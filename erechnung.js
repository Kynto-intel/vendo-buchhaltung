'use strict'
// E-Rechnungen als XML annehmen (Konformitätsprüfung K.3, Vorstufe von Phase 3): XRechnung bzw. EN 16931 in den Syntaxen
// UN/CEFACT CII (CrossIndustryInvoice) und OASIS UBL (Invoice, CreditNote). Die XML-Datei ist die Rechnung und wird
// byte-genau archiviert; hier werden nur die Kopfdaten und Summen gelesen, damit der Beleg in Ausgaben und EÜR zählt.
// Eine Prüfung mit dem amtlichen Prüfprogramm (KoSIT-Validator) folgt mit Phase 3 und wird darum als Hinweis vermerkt.

const profil = require('./profil')

const MAX_XML = 20 * 1024 * 1024
const rund = (n) => Math.round(n * 100) / 100

// Erkennung ohne XML-Parser: Wurzelelement nach dem Prolog, Namensraum-Präfix egal
function format(text) {
  const kopf = String(text).replace(/^﻿/, '').replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '').trimStart()
  const wurzel = /^<(?:[\w.-]+:)?([\w.-]+)/.exec(kopf)?.[1]
  if (wurzel === 'CrossIndustryInvoice') return 'CII'
  if (wurzel === 'Invoice' || wurzel === 'CreditNote') return 'UBL'
  return null
}

// erstes Element mit diesem lokalen Namen (beliebiges Präfix); innerhalb: nur innerhalb dieses Elternelements suchen
const element = (text, name) => new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`).exec(text)?.[1] ?? null
const wert = (text, ...pfad) => {
  let t = text
  for (const n of pfad) { t = t == null ? null : element(t, n); }
  return t == null ? null : t.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim() || null
}
const zahl = (t) => { const n = Number(String(t ?? '').trim()); return Number.isFinite(n) && String(t ?? '').trim() !== '' ? rund(n) : null }
const datumCii = (t) => (/^\d{8}$/.test(String(t || '')) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : null)
const datumUbl = (t) => (/^\d{4}-\d{2}-\d{2}/.test(String(t || '')) ? t.slice(0, 10) : null)

function lesen(text) {
  const art = format(text)
  if (!art) throw new Error('Das ist keine E-Rechnung (XRechnung/ZUGFeRD-XML in CII oder UBL).')
  const r = { anbieter: 'e-rechnung', format: art, waehrung: 'EUR', preisart: 'netto', positionen: [], eRechnung: true }
  if (art === 'CII') {
    const kopf = element(text, 'ExchangedDocument') || ''
    r.rechnungsnummer = wert(kopf, 'ID')
    r.datum = datumCii(wert(kopf, 'IssueDateTime', 'DateTimeString'))
    r.typcode = wert(kopf, 'TypeCode')
    const verkaeufer = element(text, 'SellerTradeParty') || ''
    r.lieferant = wert(verkaeufer, 'Name')
    r.ustId = /<(?:[\w.-]+:)?ID[^>]*schemeID="VA"[^>]*>([^<]+)</.exec(verkaeufer)?.[1]?.trim() || null
    const summe = element(text, 'SpecifiedTradeSettlementHeaderMonetarySummation') || ''
    r.waehrung = wert(text, 'InvoiceCurrencyCode') || 'EUR'
    const netto = zahl(wert(summe, 'TaxBasisTotalAmount'))
    const mwst = zahl(wert(summe, 'TaxTotalAmount')) ?? 0
    const brutto = zahl(wert(summe, 'GrandTotalAmount'))
    if (netto != null || brutto != null) r.summen = { netto: netto ?? rund((brutto ?? 0) - mwst), mwst, brutto: brutto ?? rund((netto ?? 0) + mwst) }
    r.reverseCharge = /<(?:[\w.-]+:)?CategoryCode>\s*AE\s*</.test(text)
    r.positionen = (text.match(/<(?:[\w.-]+:)?IncludedSupplyChainTradeLineItem\b/g) || []).map((_, i) => ({ typ: 'artikel', bezeichnung: `Position ${i + 1}`, menge: 1 }))
  } else {
    const ohneUnter = text.replace(/<(?:[\w.-]+:)?(AccountingSupplierParty|AccountingCustomerParty|InvoiceLine|CreditNoteLine|TaxTotal|LegalMonetaryTotal|PaymentMeans|Delivery|AllowanceCharge|OrderReference|BillingReference|AdditionalDocumentReference)\b[\s\S]*?<\/(?:[\w.-]+:)?\1>/g, '')
    r.rechnungsnummer = wert(ohneUnter, 'ID')
    r.datum = datumUbl(wert(ohneUnter, 'IssueDate'))
    r.typcode = wert(ohneUnter, 'InvoiceTypeCode') || (format(text) && /^\s*<(?:[\w.-]+:)?CreditNote/.test(text.replace(/^﻿/, '').replace(/<\?xml[^>]*\?>/, '')) ? '381' : null)
    const verkaeufer = element(text, 'AccountingSupplierParty') || ''
    r.lieferant = wert(verkaeufer, 'RegistrationName') || wert(verkaeufer, 'PartyName', 'Name')
    r.ustId = wert(element(verkaeufer, 'PartyTaxScheme') || '', 'CompanyID')
    r.waehrung = wert(ohneUnter, 'DocumentCurrencyCode') || 'EUR'
    const summe = element(text, 'LegalMonetaryTotal') || ''
    const netto = zahl(wert(summe, 'TaxExclusiveAmount'))
    const brutto = zahl(wert(summe, 'TaxInclusiveAmount')) ?? zahl(wert(summe, 'PayableAmount'))
    const mwst = zahl(wert(element(text, 'TaxTotal') || '', 'TaxAmount')) ?? (netto != null && brutto != null ? rund(brutto - netto) : 0)
    if (netto != null || brutto != null) r.summen = { netto: netto ?? rund((brutto ?? 0) - mwst), mwst, brutto: brutto ?? rund((netto ?? 0) + mwst) }
    r.reverseCharge = /<(?:[\w.-]+:)?ID>\s*AE\s*<\/(?:[\w.-]+:)?ID>/.test(element(text, 'TaxCategory') || '')
    r.positionen = (text.match(/<(?:[\w.-]+:)?(?:InvoiceLine|CreditNoteLine)\b/g) || []).map((_, i) => ({ typ: 'artikel', bezeichnung: `Position ${i + 1}`, menge: 1 }))
  }
  if (r.summen?.brutto) r.summen.mwstSatz = r.summen.netto ? rund(r.summen.mwst / r.summen.netto * 100) : 0
  // Gutschrift (Typ 381): als negativer Betrag
  if (r.typcode === '381' && r.summen) for (const k of ['netto', 'mwst', 'brutto']) r.summen[k] = -Math.abs(r.summen[k])
  r.art = profil.istEigen(r.lieferant) ? 'einnahme' : 'ausgabe'
  if (r.summen) {
    const brutto = r.art === 'ausgabe' && !profil.vorsteuerAbziehbarAm(r.datum)
    r.wirksam = brutto ? r.summen.brutto : r.summen.netto
    r.wirksamArt = r.art === 'einnahme' ? 'netto' : brutto ? 'inkl. MwSt' : 'netto'
  }
  const hinweise = ['E-Rechnung (XML): unverändert archiviert. Eine Prüfung mit dem amtlichen Prüfprogramm (KoSIT) folgt mit Phase 3.']
  if (!r.summen) hinweise.push('Summen nicht gefunden – bitte die Rechnung ansehen.')
  if (!r.datum) hinweise.push('Rechnungsdatum nicht gefunden.')
  if (r.waehrung !== 'EUR') hinweise.push(`Währung ${r.waehrung} – Beträge nicht umgerechnet.`)
  r.pruefung = { ok: !!(r.summen && r.datum && r.waehrung === 'EUR'), hinweise }
  r.version = 'xml-1'
  return r
}

module.exports = { lesen, format, MAX_XML }
