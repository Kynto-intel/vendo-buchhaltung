'use strict'
// Inhalt des Umsatzbelegs zu einer Shopify-Bestellung: WAS steht drauf (Positionen, Summen, Hinweise).
// Das Aussehen (Firma, Schrift, Farben, Tabelle, Fuß) steht in beleg-layout.js.
// Absichtlich "Umsatzbeleg" und nicht "Rechnung": eine Rechnung an Kunden hat eigene Pflichtangaben (fortlaufende Nummer usw.).

const L = require('./beleg-layout')
const profil = require('./profil') // eigene Angaben + Steuerstatus je Tag (Schritt 2.3)

const RUECKGABE = { RETURN: 'Retoure', LEGACY_RESTOCK: 'Retoure', CANCEL: 'storniert', NO_RESTOCK: 'erstattet, nicht zurück ins Lager' }

// neufassung (Phase 5.3): { grund, ersetzt (SHA-256 der alten Fassung), ersetztVom } – Vermerk auf dem Beleg
async function belegPdf({ o, rechnung: r, version, jsonSha, abgerufen, neufassung = null }) {
  const nr = r.referenz
  const firma = profil.firma(r.datum, !!r.kleinunternehmer) // Angaben von heute; § 19-Hinweis genau dann, wenn der Beleg ohne USt ist
  const { doc, beenden } = L.neuesDokument({
    Title: `Umsatzbeleg Bestellung #${nr} (Version ${version}${neufassung ? ', Neufassung' : ''})`, Subject: 'Umsatzbeleg zur Shopify-Bestellung', CreationDate: new Date(abgerufen)
  }, firma)

  L.rechnungsKopf(doc, { firma, nummer: nr, erstellt: L.datum(new Date(abgerufen).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' })), bestelldatum: `${L.datum(r.datum)}${o.createdAt ? ` ${new Date(o.createdAt).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })}` : ''}` })

  const land = (code) => code === 'DE' ? 'Germany' : code || ''
  const adresse = (a) => a ? [
    a.name,
    a.address1,
    a.address2,
    [a.zip, a.city].filter(Boolean).join(' '),
    land(a.countryCodeV2)
  ] : []
  const versand = o.shippingAddress
  const rechnung = o.billingAddress || versand
  const kunde = rechnung?.name || versand?.name
  const kundenzeilen = [kunde, o.email, ...adresse(rechnung).slice(1)]
  L.adressen(doc, [
    { titel: 'VERSANDDETAILS', zeilen: adresse(versand) },
    { titel: 'RECHNUNGSANSCHRIFT', zeilen: adresse(rechnung) },
    { titel: 'KUNDENDETAILS', zeilen: kundenzeilen }
  ])

  const positionen = r.positionen.filter((p) => p.typ !== 'versand').map((p) => ({
    ...p,
    bezeichnung: p.bezeichnung + (p.entfernt ? ' (entfernt/erstattet)' : '')
  }))
  const satz = `${String(r.summen?.mwstSatz ?? 0).replace('.', ',')} %`
  await L.artikelTabelle(doc, positionen, r.kleinunternehmer ? '' : satz.replace(' ', ''))

  if (r.retouren?.length) {
    L.block(doc, 'Retouren / Erstattungen laut Shopify', r.retouren.map((x) =>
      `${x.menge}× ${[x.bezeichnung, x.variante].filter(Boolean).join(' – ')} (${RUECKGABE[x.art] || 'erstattet'}${x.datum ? `, ${L.datum(x.datum)}` : ''})`))
  }

  const aktiv = r.positionen.filter((p) => !p.entfernt && p.typ !== 'versand')
  const artikelSumme = Math.round(aktiv.reduce((sum, p) => sum + p.gesamt, 0) * 100) / 100
  const bezahlt = Number(o.netPaymentSet?.shopMoney?.amount || 0)
  const gesamt = Number(o.currentTotalPriceSet?.shopMoney?.amount ?? artikelSumme + r.versand)
  L.rechnungSummen(doc, {
    zahlungsart: (o.paymentGatewayNames || []).join(', ') || r.zahlung?.art || '',
    rabatt: r.rabatt || 0,
    zwischensumme: artikelSumme,
    versand: r.versand || 0,
    gesamt,
    bezahlt,
    offen: r.offen || 0,
    // Regelbesteuerung (Steuerstatus am Bestelltag): Preise sind brutto, also Netto und enthaltene USt ausweisen
    steuer: r.kleinunternehmer ? [] : [{ titel: 'NETTO', wert: r.summen?.netto ?? 0 }, { titel: `ENTHALTENE UST ${satz}`, wert: r.summen?.mwst ?? 0 }]
  })
  L.rechnungAbschluss(doc, firma)

  const jahr = Number(String(r.datum || '').slice(0, 4)) || new Date().getFullYear()
  L.absatz(doc,
    `Dieser Beleg wurde am ${L.uhr(abgerufen)} automatisch aus dem unveränderten Shopify-Datensatz der Bestellung erzeugt (Quelle: Shopify Admin API). ` +
    'Änderungen an der Bestellung führen zu einer neuen Belegversion, bestehende Versionen werden nie überschrieben. ' +
    `Aufbewahrung bis 31.12.${jahr + 8}.`, { klein: true })
  if (neufassung) {
    L.absatz(doc, `Neufassung vom ${L.uhr(abgerufen)}. ${neufassung.grund} Sie ersetzt die Fassung${neufassung.ersetztVom ? ` vom ${L.uhr(neufassung.ersetztVom)}` : ''} (SHA-256 ${neufassung.ersetzt}); diese bleibt unverändert im Belegarchiv.`, { klein: true })
  }

  return beenden((seite, anzahl) => [
    `Beleg Bestellung #${nr} · Version ${version}${neufassung ? ' · Neufassung' : ''} · Seite ${seite}/${anzahl}`,
    `SHA-256 Originaldatensatz: ${jsonSha}`
  ])
}

module.exports = { belegPdf }