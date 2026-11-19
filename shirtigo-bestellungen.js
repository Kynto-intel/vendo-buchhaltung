'use strict'
// Shirtigo-Bestellungen (Produktionskosten) automatisch holen.
// Zuordnung: fulfillment.reference = deine Shopify-Bestellnummer (z. B. 1411), invoice_reference = Rechnungsnummer.
//
// WICHTIG: Das sind Daten AUS Shirtigo, nicht die Rechnung selbst. Als Beleg gilt die Original-PDF, die über die
// Shirtigo-REST-API geholt wird. Sobald sie vorliegt, zählt die PDF.
//
// Ablage im Belegarchiv (seit Plan-Schritt 1.5, archiv.js – schreibgeschützt, Index als Hash-Kette):
//   <Jahr>/shirtigo-original/Shirtigo Bestellung <Referenz> v1__<Hash>.json   Originaldatensatz (neue Version bei Änderung)
//   <Jahr>/eingang/Shirtigo Rechnung <Nr>__<Hash>.pdf                          Original-PDF der Rechnung
// Ansichtskopie: <WURZEL>\<Jahr>\<MM - Monat>\Shirtigo Rechnungen\Shirtigo Rechnung <Nr>.pdf (nur zum Ansehen).
// Nur Bestellungen MIT Rechnungsnummer werden zu Einträgen (Ausgaben); der Rest bleibt archiviert und wartet.

const fs = require('node:fs')
const shirtigo = require('./shirtigo')
const { ansichtsKopie } = require('./bestellungen')
const profil = require('./profil') // Steuerstatus je Tag aus „Meine Angaben“ (Schritt 2.3)

const rund = (n) => Math.round(n * 100) / 100
// Shirtigo liefert 'JJJJ-MM-TT hh:mm:ss' in UTC; ISO-Zeiten mit Zone bleiben unverändert
const zeit = (x) => { const s = String(x || ''); return /[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z` }
const berlinJahr = (x) => { const d = new Date(x); return Number.isNaN(d.getTime()) ? null : Number(d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 4)) }

// ---------- Verbindung zum Belegarchiv (von haupt.js eingerichtet) ----------
let archiv = null
let cache = null
function einrichten({ archiv: a } = {}) {
  if (!a) throw new Error('Kein Belegarchiv angegeben.')
  archiv = a
  cache = null
}
function archivNoetig() {
  if (!archiv) throw new Error('Das Belegarchiv ist nicht eingerichtet.')
  return archiv
}

// ---------- Shirtigo-Bestellung -> rechnung-Objekt (Ausgabe) ----------
function zuRechnung(o, version, hatPdf = false) {
  const m = (p) => (p && p.amount != null ? rund(p.amount / (p.currency_factor || 100)) : 0)
  const liste = (x) => (Array.isArray(x) ? x : x?.data || [])
  const shop = o.fulfillment?.type === 'shopify' && o.fulfillment.reference ? String(o.fulfillment.reference) : null
  const versandInfo = Array.isArray(o.shipping) ? o.shipping[0] : (o.shipping?.data ?? o.shipping)

  const stueck = (p, gesamt) => ({ menge: p.amount || 1, einzelpreis: rund(gesamt / (p.amount || 1)), gesamt })
  const positionen = [
    ...liste(o.products).map((p) => ({ typ: 'artikel', bezeichnung: p.name, projekt: p.campaign_name || undefined, farbe: p.color, groesse: p.size, ...stueck(p, m(p.net_total_price_with_branding || p.net_total_price)) })),
    ...liste(o.warehouseProducts).map((p) => ({ typ: 'artikel', bezeichnung: p.name || p.sku || 'Lagerartikel', ...stueck(p, m(p.net_total_price || p.net_unit_price)) }))
  ]
  const versand = m(versandInfo?.cost)
  if (versand) positionen.push({ typ: 'versand', bezeichnung: 'Versandkosten', menge: 1, einzelpreis: versand, gesamt: versand })

  const netto = m(o.net_price)
  const brutto = m(o.gross_price)
  const mwst = m(o.vat_amount)
  const bezahlt = liste(o.payments).find((p) => p.status === 'paid')
  const datum = String(bezahlt?.updated_at || o.created_at || '').slice(0, 10) || null // Zahlungsdatum (Abfluss), sonst Bestelldatum

  const hinweise = []
  // Kleine Differenz zwischen Positionen und Shirtigo-Summe (z. B. Verpackung/Zuschlag): als eigene Zeile ausweisen,
  // damit die Summen aufgehen. Größere Abweichungen bleiben ein Warnhinweis.
  const posSumme = rund(positionen.reduce((s, p) => s + p.gesamt, 0))
  const diff = rund(netto - posSumme)
  if (diff > 0.02 && diff <= 1) positionen.push({ typ: 'zusatz', bezeichnung: 'Zusatz (z. B. Sticker) laut Shirtigo-Summe', menge: 1, einzelpreis: diff, gesamt: diff })
  else if (Math.abs(diff) > 0.02) hinweise.push(`Positionen ergeben ${posSumme.toFixed(2)} netto, Shirtigo nennt ${netto.toFixed(2)}.`)
  if (o.net_discount) hinweise.push('Shirtigo meldet einen Rabatt (net_discount) – bitte mit der Rechnungs-PDF vergleichen.')
  const gutschrift = o.creditmemo ? (m(o.creditmemo.gross_price) || m(o.creditmemo_gross_price)) : 0
  if (o.creditmemo) hinweise.push(gutschrift > 0 ? `Gutschrift ${o.creditmemo_reference || ''} über ${gutschrift.toFixed(2)} € (brutto) ist von den Kosten abgezogen.` : `Gutschrift ${o.creditmemo_reference || ''} vorhanden – Betrag nicht erkannt, nicht verrechnet. Bitte mit der PDF prüfen.`)
  if (!bezahlt) hinweise.push('Keine bezahlte Zahlung bei Shirtigo gefunden.')
  const klein = !profil.vorsteuerAbziehbarAm(datum) // ohne Vorsteuerabzug brutto (laut Nutzer immer), sonst netto

  return {
    anbieter: 'shirtigo-api', lieferant: 'Shirtigo GmbH', waehrung: o.net_price?.currency_code || 'EUR', preisart: 'netto',
    rechnungsnummer: o.invoice_reference, datum, bestellnummer: o.reference, referenz: shop,
    positionen, versand, anzahlPositionen: positionen.length, anzahlEntfernt: 0,
    anzahlArtikel: positionen.filter((p) => p.typ === 'artikel').reduce((s, p) => s + p.menge, 0),
    art: 'ausgabe', summen: { netto, mwst, brutto, mwstSatz: o.vat_rate ?? 19 },
    gutschrift: gutschrift || undefined,
    wirksam: rund((klein ? brutto : netto) - (klein ? gutschrift : rund(gutschrift / (1 + (o.vat_rate ?? 19) / 100)))), wirksamArt: klein ? 'inkl. MwSt' : 'netto',
    zahlung: { art: bezahlt?.type || null, bezahlt: !!bezahlt }, version: `shirtigo-api-${version}`,
    nurDaten: !hatPdf, // true = nur Daten aus Shirtigo, Original-PDF liegt noch nicht vor (die Ansicht zeigt dafür ein eigenes Etikett)
    pruefung: { ok: hinweise.length === 0, hinweise }
  }
}

// ---------- Cache: je Shirtigo-Bestellung Stand + (falls Rechnung vorhanden) Eintrag für die Ansicht ----------
// Archivarten: shirtigo-original (meta.shirtigo + meta.version) und eingang mit meta.shirtigo (Original-PDF)
function eintragBauen(j, o, pdf) {
  let abgerufen = j.zeit
  if (!o) ({ bestellung: o, meta: { abgerufen = j.zeit } = {} } = JSON.parse(fs.readFileSync(archivNoetig().pfad(j), 'utf8'))) // Abrufzeit aus dem Original (bei migrierten nicht die Umzugszeit)
  const ref = String(j.meta.shirtigo)
  const x = { ref, version: j.meta.version, updatedAt: o.updated_at, json: j, pdf: pdf || null, eintrag: null }
  if (!o.invoice_reference) return x
  x.eintrag = {
    id: `t${ref}`, name: `Shirtigo ${ref} · Rechnung ${o.invoice_reference}`, groesse: pdf?.bytes || 0, zeit: Date.parse(zeit(o.created_at)) || Date.now(),
    scanStand: Date.parse(abgerufen), methode: 'shirtigo-api', seiten: 1, zeichen: 0, quelle: 'shirtigo-api',
    beleg: pdf ? { pdf: pdf.datei, sha256: pdf.sha256 } : undefined,
    rechnung: zuRechnung(o, j.meta.version, !!pdf)
  }
  return x
}
function cacheLaden() {
  if (cache) return cache
  cache = new Map()
  const neueste = new Map()
  const pdfs = new Map()
  const alle = archivNoetig().eintraege()
  const eingangNachHash = new Map(alle.filter((e) => e.art === 'eingang').map((e) => [e.sha256, e]))
  for (const e of alle) {
    const ref = e.meta?.shirtigo
    if (ref == null) continue
    if (e.art === 'shirtigo-original' && (!neueste.has(ref) || e.meta.version >= neueste.get(ref).meta.version)) neueste.set(ref, e)
    if (e.art === 'eingang') pdfs.set(ref, e)
    if (e.art === 'zuordnung' && eingangNachHash.has(e.meta.beleg)) pdfs.set(ref, eingangNachHash.get(e.meta.beleg)) // Beleg ohne eigenes Shirtigo-Exemplar
  }
  for (const [ref, j] of neueste) { try { cache.set(ref, eintragBauen(j, null, pdfs.get(ref))) } catch { /* Integritätsprüfung meldet es */ } }
  return cache
}
const eintraege = () => [...cacheLaden().values()].map((x) => x.eintrag).filter(Boolean)
function pdfPfad(id) {
  const x = /^t/.test(String(id)) ? cacheLaden().get(String(id).slice(1)) : null
  if (!x?.pdf) throw new Error('Zu dieser Shirtigo-Rechnung liegt noch keine PDF vor.')
  return archivNoetig().pfad(x.pdf)
}

// ---------- Original-PDF holen und ablegen ----------
// Original ins Archiv (Art „eingang“), danach Ansichtskopie im Monatsordner. Liegt dort eine eigene Datei gleichen Namens,
// heißt die Kopie „… (API).pdf“; fremde Dateien werden nie überschrieben.
async function pdfAblegen(x, o, neu, hinweise) {
  const buf = await shirtigo.rechnungPdf(o)
  if (!buf) return null
  const datum = x.eintrag.rechnung.datum || String(o.created_at).slice(0, 10)
  const basis = `Shirtigo Rechnung ${String(o.invoice_reference).replace(/[\\/:*?"<>|]/g, '-')}`
  const e = archivNoetig().ablegen(buf, {
    art: 'eingang', jahr: Number(datum.slice(0, 4)), name: `${basis}.pdf`,
    meta: { quelle: 'shirtigo-api', shirtigo: x.ref, rechnungsnummer: o.invoice_reference }, sofortSchuetzen: false
  })
  if (!e.doppelt) neu.push(e)
  else if (String(e.meta?.shirtigo) !== x.ref) {
    // Dieselbe PDF liegt schon im Archiv, z. B. selbst eingelesen (Schritt 1.6). Archiveinträge sind unveränderlich, darum
    // verbindet ein kleiner Zuordnungseintrag die Shirtigo-Bestellung mit dem vorhandenen Beleg (kein zweites Exemplar).
    const z = archivNoetig().ablegen(Buffer.from(JSON.stringify({ shirtigo: x.ref, rechnungsnummer: o.invoice_reference, beleg: e.datei, sha256: e.sha256 }, null, 2), 'utf8'), {
      art: 'zuordnung', jahr: e.jahr, name: `Zuordnung Shirtigo ${x.ref}.json`,
      meta: { quelle: 'shirtigo-api', shirtigo: x.ref, beleg: e.sha256 }, sofortSchuetzen: false
    })
    if (!z.doppelt) neu.push(z)
  }
  const h = ansichtsKopie(buf, datum, 'Shirtigo Rechnungen', [`${basis}.pdf`, `${basis} (API).pdf`])
  if (h) hinweise.push(h)
  return e
}

// Für alle Bestellungen mit Rechnungsnummer ohne PDF im Archiv: Original von Shirtigo holen
async function pdfsHolen(map, neu, hinweise) {
  const erg = { pdfNeu: 0, pdfKeine: 0, pdfWerkzeug: null, pdfFehler: [] }
  const offen = [...map.entries()].filter(([, x]) => x.eintrag && !x.pdf)
  if (!offen.length) return erg
  fortschritt = { phase: 'pdf', erledigt: 0, gesamt: offen.length, pdfNeu: 0, pdfFehler: 0 }
  // Original-PDFs kommen über die REST-API (GET /orders/{Referenz}/invoice); 404 = bei Shirtigo noch keine Rechnung
  // Vier gleichzeitig; einzelne Fehler dürfen den Abruf der übrigen PDFs nicht blockieren.
  for (let i = 0; i < offen.length; i += 4) {
    await Promise.all(offen.slice(i, i + 4).map(async ([ref, x]) => {
      try {
        const o = JSON.parse(fs.readFileSync(archivNoetig().pfad(x.json), 'utf8')).bestellung
        const pe = await pdfAblegen(x, o, neu, hinweise)
        if (pe) { map.set(ref, eintragBauen(x.json, o, pe)); erg.pdfNeu++; fortschritt.pdfNeu++ } else erg.pdfKeine++ // keine = Shirtigo hat (noch) keine Rechnung herausgegeben
      } catch (f) { erg.pdfFehler.push(`${ref}: ${f.message}`); fortschritt.pdfFehler++ }
      finally { fortschritt.erledigt++ }
    }))
  }
  return erg
}

function ablegen(o, version, neu) {
  const ref = String(o.reference)
  const text = JSON.stringify({ meta: { quelle: 'Shirtigo MCP list_orders', abgerufen: new Date().toISOString() }, bestellung: o }, null, 2)
  const jahr = berlinJahr(zeit(o.created_at)) || new Date().getFullYear()
  const j = archivNoetig().ablegen(Buffer.from(text, 'utf8'), {
    art: 'shirtigo-original', jahr, name: `Shirtigo Bestellung ${ref} v${version}.json`,
    meta: { quelle: 'shirtigo-mcp', shirtigo: ref, version }, sofortSchuetzen: false
  })
  if (!j.doppelt) neu.push(j)
  return j
}

// ---------- Abgleich: alle Seiten durchgehen (Shirtigo liefert neueste zuerst) ----------
let laeuft = null
let fortschritt = null
function abgleichen() {
  laeuft ||= (async () => {
    const a = archivNoetig()
    const map = cacheLaden()
    const neu = []
    const hinweise = []
    const erg = { neu: 0, geaendert: 0, gesehen: 0, ohneRechnung: 0 }
    try {
      for (let seite = 1; ; seite++) {
        fortschritt = { phase: 'bestellungen', seite }
        const r = shirtigo.nutzdaten(await shirtigo.aufrufen('list_orders', { limit: 50, page: seite, include: 'products,warehouseProducts,shipping,payments' }))
        for (const o of r?.data || []) {
          erg.gesehen++
          const alt = map.get(String(o.reference))
          if (alt && alt.updatedAt === o.updated_at) continue
          const j = ablegen(o, (alt?.version || 0) + 1, neu)
          map.set(String(o.reference), eintragBauen(j, o, alt?.pdf))
          alt ? erg.geaendert++ : erg.neu++
        }
        const p = r?.meta?.pagination
        if (!p || seite >= p.total_pages) break
      }
      erg.ohneRechnung = [...map.values()].filter((x) => !x.eintrag).length
      try { Object.assign(erg, await pdfsHolen(map, neu, hinweise)) } catch (f) { erg.pdfFehler = [f.message] } // PDF-Probleme dürfen den Datenabgleich nicht kippen
      erg.pdfOffen = [...map.values()].filter((x) => x.eintrag && !x.pdf).length
    } finally {
      const schutz = a.nachSchuetzen(neu) // auch nach einem Fehler: alles bis dahin Abgelegte schützen
      if (neu.length && schutz.schutzFehler) hinweise.push(`Windows-Schutz: ${schutz.schutzFehler[0]}`)
      if (hinweise.length) erg.hinweise = hinweise
    }
    return erg
  })().finally(() => { laeuft = null; fortschritt = null })
  return laeuft
}

// Nach Änderung von „Meine Angaben“ (Steuerstatus): Einträge neu aus dem Archiv berechnen
function neuBerechnen() { if (!laeuft) cache = null }
const beschaeftigt = () => !!laeuft
const warten = () => laeuft || Promise.resolve()
const status = () => fortschritt ? { ...fortschritt } : null
module.exports = { einrichten, abgleichen, eintraege, neuBerechnen, zuRechnung, pdfPfad, beschaeftigt, warten, status }
