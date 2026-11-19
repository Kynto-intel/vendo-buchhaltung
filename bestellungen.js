'use strict'
// Shopify-Bestellungen automatisch holen und GoBD-orientiert archivieren (seit Plan-Schritt 1.5 im zentralen Belegarchiv).
//
// Ablage im Belegarchiv (archiv.js, getrennt vom Arbeitsordner, schreibgeschützt, Index als Hash-Kette):
//   <Jahr>/shopify-original/Shopify Bestellung 1413 v1__<Hash>.json   Originaldatensatz von Shopify (nie verändert)
//   <Jahr>/umsatzbeleg/Umsatzbeleg Bestellung 1413__<Hash>.pdf         Beleg-PDF; neue Version bei Änderung: "(Version 2)"
// Ansichtskopie: <WURZEL>\<Jahr>\<MM - Monat>\Shopify Rechnungen\Umsatzbeleg Bestellung 1413.pdf
//   -> deine bestehende Ordnerstruktur (vorhandene Ordner werden erkannt, fehlende angelegt). Nur eine Kopie zum Ansehen:
//      Verschieben, Umbenennen oder Löschen dort ändert am Archiv nichts.
// Der Abgleichstand (bis wann geholt) liegt in den Plugin-Daten, nicht im Archiv.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { graphql, API_VERSION, einrichten: shopifyEinrichten } = require('./shopify')
const { belegPdf } = require('./beleg')
const profil = require('./profil') // eigene Angaben + Steuerstatus je Tag (Schritt 2.3)
const geo = require('./geo')

const WURZEL = process.env.VENDO_BELEGE || path.join(os.homedir(), 'Documents', 'Arbeit', 'Rechnungen')
const KATEGORIE = 'Shopify Rechnungen' // Unterordner im Monatsordner
const MONATSNAMEN = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']

// Findet einen vorhandenen Unterordner (egal wie er genau geschrieben ist) oder legt ihn an
function unterordner(eltern, passt, neu) {
  fs.mkdirSync(eltern, { recursive: true })
  const name = fs.readdirSync(eltern, { withFileTypes: true }).find((d) => d.isDirectory() && passt(d.name))?.name || neu
  const voll = path.join(eltern, name)
  fs.mkdirSync(voll, { recursive: true })
  return voll
}
// "2024-01-15" -> <WURZEL>\2024\01 - Januar\Shopify Rechnungen (erkennt auch "05- Mai")
function belegOrdner(datumIso, kategorie = KATEGORIE) {
  const [jahr, mm] = String(datumIso).split('-')
  const j = unterordner(WURZEL, (n) => n === jahr, jahr)
  const mo = unterordner(j, (n) => new RegExp(`^${mm}\\b`).test(n), `${mm} - ${MONATSNAMEN[+mm - 1]}`)
  return unterordner(mo, (n) => n.toLowerCase() === kategorie.toLowerCase(), kategorie)
}

const sha = (x) => crypto.createHash('sha256').update(x).digest('hex')
const rund = (n) => Math.round(n * 100) / 100
const geld = '{ shopMoney { amount currencyCode } }'

// Zahlungen (Schritt 4.1, B13): Transaktionen der Bestellung – Datum des Geldeingangs bzw. der Erstattung
const TRANSAKTIONEN = `transactions(first: 30) { kind status test processedAt createdAt gateway manualPaymentGateway amountSet ${geld} }`
// Für ältere Archiv-Originale ohne Transaktionen: nur die Zahlungen nachholen (je Anfrage bis zu 50 Bestellungen)
const ZAHLUNGEN_QUERY = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { id name ${TRANSAKTIONEN} } } }`

const QUERY = `query($cursor: String, $q: String) {
  orders(first: 20, after: $cursor, query: $q, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt updatedAt cancelledAt test displayFinancialStatus email paymentGatewayNames
      ${TRANSAKTIONEN}
      currentTotalPriceSet ${geld} totalPriceSet ${geld} totalShippingPriceSet ${geld}
      totalDiscountsSet ${geld} totalRefundedSet ${geld} netPaymentSet ${geld} currentTotalTaxSet ${geld}
      shippingAddress { name address1 address2 zip city countryCodeV2 }
      billingAddress { name address1 address2 zip city countryCodeV2 }
      refunds { createdAt refundLineItems(first: 25) { nodes { quantity restockType lineItem { title variantTitle } } } }
      shippingLines(first: 5) { nodes { originalPriceSet ${geld} discountedPriceSet ${geld} } }
      lineItems(first: 25) {
        pageInfo { hasNextPage }
        nodes { title variantTitle variant { sku image { url } } image { url } product { featuredMedia { preview { image { url } } } } quantity currentQuantity originalUnitPriceSet ${geld} discountedUnitPriceAfterAllDiscountsSet ${geld} }
      }
    }
  }
}`

// ---------- Zahlungsdatum aus den Transaktionen (Schritt 4.1, B13) ----------
// Geldeingang = erfolgreiche SALE/CAPTURE-Transaktion (keine Testzahlung), Erstattung = erfolgreiche REFUND-Transaktion.
// Datum als Berliner Kalendertag von processedAt. Bei Überweisung (manuelle Zahlungsart) ist das der Zeitpunkt, an dem die
// Bestellung in Shopify als bezahlt markiert wurde. liste = null: keine Transaktionen bekannt (Zahlungsdatum unbekannt).
function zahlungAus(liste) {
  if (!Array.isArray(liste)) return null
  const betrag = (x) => rund(parseFloat(x?.shopMoney?.amount ?? 0) || 0)
  const posten = (arten) => liste
    .filter((t) => t && t.status === 'SUCCESS' && !t.test && arten.includes(t.kind))
    .map((t) => { const zeit = t.processedAt || t.createdAt; return { datum: new Date(zeit).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }), zeit, betrag: betrag(t.amountSet), gateway: t.gateway || '', manuell: !!t.manualPaymentGateway } })
    .sort((a, b) => String(a.zeit).localeCompare(String(b.zeit)))
  const eingaenge = posten(['SALE', 'CAPTURE'])
  const erstattungen = posten(['REFUND'])
  return { datum: eingaenge[0]?.datum || null, eingaenge, erstattungen, manuell: eingaenge.some((e) => e.manuell) }
}

// ---------- Shopify-Bestellung -> rechnung-Objekt (damit ansicht.js unverändert funktioniert) ----------
// zahlungen: Transaktionen aus einer nachgeholten Archivdatei (shopify-zahlungen), falls das Original keine enthält
function zuRechnung(o, version, zahlungen = null) {
  const m = (s) => rund(parseFloat(s?.shopMoney?.amount ?? 0) || 0)
  const nr = String(o.name).replace(/^#/, '')
  const status = o.displayFinancialStatus
  const bezahlt = ['PAID', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(status)

  const positionen = o.lineItems.nodes.map((li) => {
    const variante = li.variantTitle && li.variantTitle !== 'Default Title' ? li.variantTitle.split(' / ') : []
    const einzel = m(li.discountedUnitPriceAfterAllDiscountsSet) // Rabatt ist hier schon eingerechnet
    const original = m(li.originalUnitPriceSet)
    const entfernt = li.currentQuantity === 0
    const menge = entfernt ? li.quantity : li.currentQuantity
    const sku = li.variant?.sku || ''
    // Bild (Phase 5.2): Variante → Artikel → Produkt
    const imOriginal = li.variant?.image?.url || li.image?.url || li.product?.featuredMedia?.preview?.image?.url || ''
    return { typ: 'artikel', bezeichnung: li.title, artikelnummer: sku, bildUrl: imOriginal, farbe: variante[0], groesse: variante[1], menge, einzelpreis: einzel, ursprungspreis: original !== einzel ? original : undefined, gesamt: rund(einzel * menge), entfernt }
  })
  const aktuell = m(o.currentTotalPriceSet)
  const artikelSumme = rund(positionen.filter((p) => !p.entfernt).reduce((sum, p) => sum + p.gesamt, 0))
  // Versand NACH Rabatt (z. B. Gratisversand-Code). totalShippingPriceSet allein wäre der Preis vor Rabatt.
  const linien = o.shippingLines?.nodes || []
  const versandOriginal = linien.length ? rund(linien.reduce((sum, l) => sum + m(l.originalPriceSet), 0)) : m(o.totalShippingPriceSet)
  let versand = linien.length ? rund(linien.reduce((sum, l) => sum + m(l.discountedPriceSet), 0)) : m(o.totalShippingPriceSet)
  // Ältere archivierte Datensätze haben keine Versandzeilen: Versand nach Rabatt aus der Bestellsumme ableiten
  if (!linien.length) versand = rund(Math.max(0, Math.min(versand, aktuell - artikelSumme)))
  const versandRabattiert = versand < versandOriginal
  if (versandOriginal) positionen.push({ typ: 'versand', bezeichnung: versandRabattiert ? 'Versand (rabattiert)' : 'Versand', menge: 1, einzelpreis: versand, ursprungspreis: versandRabattiert ? versandOriginal : undefined, gesamt: versand })
  const aktiv = positionen.filter((p) => !p.entfernt)

  const netto = m(o.netPaymentSet) // Zahlungseingang abzüglich Erstattungen
  const wirksam = bezahlt ? netto : 0
  // Rabatt auf Artikel (steckt schon in den Einzelpreisen); Versandrabatt steht in der Versandzeile
  const rabatt = rund(positionen.filter((p) => p.typ === 'artikel' && !p.entfernt).reduce((sum, p) => sum + ((p.ursprungspreis ?? p.einzelpreis) - p.einzelpreis) * p.menge, 0))
  const zusatz = ['PARTIALLY_REFUNDED', 'REFUNDED'].includes(status) ? rund(Math.max(0, aktuell - netto)) : 0
  const offen = status === 'PARTIALLY_PAID' ? rund(Math.max(0, aktuell - netto)) : 0
  // Steuerstatus am Bestelltag (Berlin). Regelbesteuerung: enthaltene USt laut Shopify zählt nicht als Einnahme (Plan 8.1)
  const datum = new Date(o.createdAt).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' })
  const steuer = profil.steuerAm(datum)
  const klein = steuer.art === 'klein'
  const mwst = klein ? 0 : rund(Math.max(0, Math.min(m(o.currentTotalTaxSet), wirksam)))

  // Echte Rückgaben/Erstattungen laut Shopify (restockType: RETURN = Retoure, CANCEL = storniert, NO_RESTOCK = erstattet ohne Rücklagerung)
  const retouren = (o.refunds || []).flatMap((rf) => (rf.refundLineItems?.nodes || []).map((x) => ({
    bezeichnung: x.lineItem?.title,
    variante: x.lineItem?.variantTitle && x.lineItem.variantTitle !== 'Default Title' ? x.lineItem.variantTitle : undefined,
    menge: x.quantity, art: x.restockType, datum: String(rf.createdAt || '').slice(0, 10)
  })))

  const hinweise = []
  const posSumme = rund(aktiv.reduce((s, p) => s + p.gesamt, 0))
  if (!o.cancelledAt && !['REFUNDED', 'VOIDED'].includes(status) && Math.abs(posSumme - aktuell) > 0.05) hinweise.push(`Positionen ergeben ${posSumme.toFixed(2)}, die Bestellung nennt ${aktuell.toFixed(2)} (Steuer, Geschenkkarte, Trinkgeld?).`)
  if (o.lineItems.pageInfo?.hasNextPage) hinweise.push('Mehr als 25 Positionen – nicht alle geladen.')
  const waehrung = o.netPaymentSet?.shopMoney?.currencyCode
  if (waehrung && waehrung !== 'EUR') hinweise.push(`Währung ${waehrung} statt EUR – Beträge nicht umgerechnet.`)

  return {
    anbieter: 'shopify-api', lieferant: profil.eigenerShop(), waehrung: 'EUR', preisart: 'brutto',
    referenz: nr, bestellnummer: nr, rechnungsnummer: `#${nr}`,
    datum,
    empfaenger: { name: o.shippingAddress?.name, email: o.email || undefined, strasse: o.shippingAddress?.address1, plz: o.shippingAddress?.zip, ort: o.shippingAddress?.city, land: o.shippingAddress?.countryCodeV2 },
    positionen, versand, anzahlPositionen: aktiv.length, anzahlEntfernt: positionen.length - aktiv.length,
    anzahlArtikel: aktiv.filter((p) => p.typ === 'artikel').reduce((s, p) => s + p.menge, 0),
    art: 'einnahme', wirksam: rund(wirksam - mwst), wirksamArt: klein ? 'ohne MwSt (§ 19)' : 'netto', kleinunternehmer: klein,
    regelbesteuerung: klein ? undefined : steuer.satz,
    summen: { brutto: wirksam, mwst, netto: rund(wirksam - mwst), zwischensumme: null, mwstSatz: klein ? 0 : steuer.satz },
    rabatt, rabattEingerechnet: rabatt > 0, zusatzErstattung: zusatz, offen, retouren,
    zahlung: zahlungFuer(o, status, zahlungen), storniert: !!o.cancelledAt,
    version: `api-${version}`, pruefung: { ok: hinweise.length === 0, hinweise }
  }
}

function zahlungFuer(o, status, zahlungen) {
  const quelle = Array.isArray(o.transactions) ? o.transactions : Array.isArray(zahlungen) ? zahlungen : null
  const z = zahlungAus(quelle)
  const gateways = [...new Set((z?.eingaenge || []).map((e) => e.gateway).filter(Boolean))]
  return {
    art: (gateways.length ? gateways : o.paymentGatewayNames || []).join(', ') || null, bezahlt: status === 'PAID',
    datum: z?.datum || null, eingaenge: z?.eingaenge || [], erstattungen: z?.erstattungen || [], manuell: !!z?.manuell, bekannt: !!z
  }
}

// ---------- Verbindung zum Belegarchiv (archiv.js) und zum Abgleichstand ----------
// haupt.js richtet beides ein: das Archiv (mit Windows-Schutz) und einen Speicher für den Abgleichstand in den Plugin-Daten
// (veränderlich, darum nicht im Archiv).
let archiv = null
let stand = { lesen: () => ({}), schreiben: () => {} }
let cache = null
function einrichten({ archiv: a, stand: s, zugang } = {}) {
  if (!a) throw new Error('Kein Belegarchiv angegeben.')
  archiv = a
  if (s) stand = s
  if (zugang) shopifyEinrichten({ zugang }) // Shopify-Zugang kommt über haupt.js vom Host (Vendo: Hermes)
  cache = null
}

// ---------- Neufassung von Umsatzbelegen (Phase 5.3) ----------
// Pflichtfall: Belege, die vor dem Steuerstatus je Zeitraum (Schritt 2.3, 29.10.2026) erzeugt wurden, deren Bestellung aber in
// die Regelbesteuerung fällt: das alte PDF zeigt „0 %“ und den § 19-Hinweis (B17). Die Neufassung entsteht aus dem
// unveränderten Original (Hash geprüft) und kommt zusätzlich ins Archiv; die alte Fassung bleibt dort (GoBD). Ein Protokoll
// im Archiv hält fest, welche Fassung welche ersetzt. Vorbild „haben“: festgeschriebene Belege werden nie geändert.
const STEUERSTATUS_SEIT = Date.parse('2026-10-29T00:00:00Z')
const NEUFASSUNG_GRUND = 'Steuerausweis berichtigt: Die Bestellung fällt in die Regelbesteuerung (Umsatzsteuer ausgewiesen, kein § 19-Hinweis).'
function neufassungPlanen({ steuerstatusSeit = STEUERSTATUS_SEIT } = {}) {
  const steuer = []
  for (const x of cacheLaden().values()) {
    const r = x.eintrag.rechnung
    if (!x.pdf || r.storniert) continue
    if (!r.kleinunternehmer && Date.parse(x.pdf.zeit || 0) < steuerstatusSeit) steuer.push({ nr: x.nr, version: x.version, datum: r.datum, steuer: r.summen?.mwst ?? 0 })
  }
  steuer.sort((a, b) => Number(a.nr) - Number(b.nr))
  return { steuer, steuerSumme: rund(steuer.reduce((s, x) => s + x.steuer, 0)) }
}
async function neufassungPdf(x, jetzt) {
  const a = archivNoetig()
  const roh = fs.readFileSync(a.pfad(x.json))
  if (sha(roh) !== x.json.sha256) throw new Error(`#${x.nr}: Originaldatensatz verändert`)
  const o = JSON.parse(roh.toString('utf8')).bestellung
  const rechnung = zuRechnung(o, x.version)
  const pdf = await belegPdf({ o, rechnung, version: x.version, jsonSha: x.json.sha256, abgerufen: jetzt, neufassung: { grund: NEUFASSUNG_GRUND, ersetzt: x.pdf.sha256, ersetztVom: x.pdf.zeit } })
  return { pdf, rechnung }
}
// Vorschau: erste Neufassung als PDF-Puffer, nichts wird abgelegt
async function neufassungVorschau(optionen) {
  const plan = neufassungPlanen(optionen)
  if (!plan.steuer.length) return null
  const x = cacheLaden().get(plan.steuer[0].nr)
  return { nr: x.nr, anzahl: plan.steuer.length, pdf: (await neufassungPdf(x, new Date().toISOString())).pdf }
}
async function neufassungErzeugen(optionen) {
  if (laeuft) throw new Error('Ein Abgleich läuft gerade. Bitte danach erneut versuchen.')
  const a = archivNoetig()
  const plan = neufassungPlanen(optionen)
  const jetzt = new Date().toISOString()
  const neu = []
  const liste = []
  const hinweise = []
  try {
    for (const s of plan.steuer) {
      const x = cacheLaden().get(s.nr)
      const { pdf, rechnung } = await neufassungPdf(x, jetzt)
      const name = `Umsatzbeleg Bestellung ${x.nr} (Neufassung).pdf`
      const p = a.ablegen(pdf, { art: 'umsatzbeleg', jahr: x.json.jahr, name, meta: { quelle: 'neufassung', bestellung: x.nr, version: x.version, ersetzt: x.pdf.sha256, grund: 'steuerausweis' }, sofortSchuetzen: false })
      if (!p.doppelt) neu.push(p)
      const h = ansichtsKopie(pdf, rechnung.datum, KATEGORIE, [name])
      if (h) hinweise.push(h)
      liste.push({ bestellung: x.nr, version: x.version, alt: { datei: x.pdf.datei, sha256: x.pdf.sha256 }, neu: { datei: p.datei, sha256: p.sha256 } })
    }
    let protokoll = null
    if (liste.length) {
      const inhalt = { vorgang: 'Neufassung von Umsatzbelegen (Plan Phase 5.3)', zeit: jetzt, grund: NEUFASSUNG_GRUND, anzahl: liste.length, umsatzsteuer: plan.steuerSumme, hinweis: 'Die alten Fassungen bleiben unverändert im Archiv.', belege: liste }
      const pr = a.ablegen(Buffer.from(JSON.stringify(inhalt, null, 2), 'utf8'), { art: 'protokoll', jahr: Number(jetzt.slice(0, 4)), name: `Neufassung Umsatzbelege ${jetzt.slice(0, 19).replace(/:/g, '-')}.json`, meta: { vorgang: 'neufassung', anzahl: liste.length }, sofortSchuetzen: false })
      neu.push(pr)
      protokoll = pr.datei
    }
    return { anzahl: liste.length, umsatzsteuer: plan.steuerSumme, protokoll, hinweise }
  } finally {
    a.nachSchuetzen(neu)
    cache = null
  }
}
function archivNoetig() {
  if (!archiv) throw new Error('Das Belegarchiv ist nicht eingerichtet.')
  return archiv
}

// Ansichtskopie im Monatsordner. Nie überschreiben: liegt dort schon eine andere Datei gleichen Namens, wird der nächste
// Name versucht. Fehler hier verhindern nichts – das Original liegt im Archiv.
function ansichtsKopie(inhalt, datumIso, kategorie, namen) {
  try {
    const ordner = belegOrdner(datumIso, kategorie)
    for (const name of namen) {
      const ziel = path.join(ordner, name)
      if (fs.existsSync(ziel)) { if (sha(fs.readFileSync(ziel)) === sha(inhalt)) return null; continue }
      fs.writeFileSync(ziel, inhalt, { flag: 'wx' })
      return null
    }
    return `Ansichtskopie ${namen[0]}: Name im Monatsordner schon vergeben`
  } catch (f) {
    return `Ansichtskopie ${namen[0]}: ${f.message}`
  }
}

// ---------- Cache für die Ansicht (aus der jeweils neuesten Version je Bestellung im Archiv) ----------
// Archivarten: shopify-original (Originaldatensatz) und umsatzbeleg (Beleg-PDF), verbunden über meta.bestellung + meta.version
// Archivart shopify-zahlungen: nachgeholte Transaktionen einer Bestellung, deren Original noch keine enthält (Schritt 4.1)
function eintragBauen(j, p, o, z = null) {
  const a = archivNoetig()
  let meta = {}
  if (!o) ({ meta, bestellung: o } = JSON.parse(fs.readFileSync(a.pfad(j), 'utf8')))
  else meta = { abgerufen: j.zeit }
  const hatEigene = Array.isArray(o.transactions)
  const zahlungen = !hatEigene && z ? JSON.parse(fs.readFileSync(a.pfad(z), 'utf8')).bestellung?.transactions : null
  const nr = String(j.meta.bestellung)
  const version = j.meta.version
  const m = (s) => rund(parseFloat(s?.shopMoney?.amount ?? 0) || 0)
  return {
    nr, version, updatedAt: o.updatedAt, json: j, pdf: p || null, gid: o.id, zahlungen: z, zahlungenBekannt: hatEigene || Array.isArray(zahlungen),
    // Steuer laut Shopify (zuRechnung setzt sie als Kleinunternehmer auf 0) – für den Steuerstatus je Zeitraum (Schritt 2.2)
    steuer: { betrag: m(o.currentTotalTaxSet), brutto: m(o.currentTotalPriceSet) },
    eintrag: {
      id: `s${nr}`, name: `Bestellung #${nr} (Version ${version})`, groesse: p?.bytes || 0, zeit: Date.parse(o.createdAt),
      scanStand: Date.parse(meta.abgerufen || j.zeit), methode: 'api', seiten: 1, zeichen: 0, quelle: 'shopify',
      beleg: p ? { version, updatedAt: o.updatedAt, pdf: p.datei, sha256: j.sha256 } : undefined,
      rechnung: zuRechnung(o, version, zahlungen)
    }
  }
}
function cacheLaden() {
  if (cache) return cache
  const a = archivNoetig()
  cache = new Map()
  const neueste = new Map()
  const pdfs = new Map()
  const zahlungen = new Map()
  for (const e of a.eintraege()) {
    const nr = e.meta?.bestellung
    if (!nr) continue
    if (e.art === 'shopify-original' && (!neueste.has(nr) || e.meta.version >= neueste.get(nr).meta.version)) neueste.set(nr, e)
    if (e.art === 'umsatzbeleg') pdfs.set(`${nr}|${e.meta.version}`, e)
    if (e.art === 'shopify-zahlungen') zahlungen.set(nr, e) // neueste gewinnt (Index ist chronologisch)
  }
  for (const [nr, j] of neueste) { try { cache.set(nr, eintragBauen(j, pdfs.get(`${nr}|${j.meta.version}`), null, zahlungen.get(nr))) } catch { /* beschädigte Datei: Integritätsprüfung meldet es */ } }
  return cache
}
const eintraege = () => [...cacheLaden().values()].map((x) => x.eintrag)
// Umsatzsteuer je Bestellung laut Shopify (neueste Version): nur Nummer, Berliner Bestelltag, Beträge – keine Kundendaten
const steuerBefund = () => [...cacheLaden().values()].map(({ nr, steuer, eintrag: { rechnung: r } }) => ({ nr, datum: r.datum, steuer: steuer.betrag, brutto: steuer.brutto, storniert: r.storniert }))
// Orte der Bestellungen für den Globus: nur Ort + Anzahl, keine Namen/Adressen. Koordinaten kommen offline aus geo.js
// (Postleitzahl -> Ortsname -> Landesmitte) und werden auf ~10 km gerundet zusammengefasst. Stornierte Bestellungen zählen nicht.
function orte() {
  const map = new Map()
  for (const { eintrag: e } of cacheLaden().values()) {
    const r = e.rechnung
    if (r.storniert) continue
    const a = r.empfaenger || {}
    const p = geo.finde(a.land, a.plz, a.ort)
    if (!p) continue
    const schluessel = `${p.lat.toFixed(1)}|${p.lon.toFixed(1)}`
    const x = map.get(schluessel) || { lat: p.lat, lon: p.lon, ort: p.genau === 'land' ? (a.land || '') : (a.ort || ''), anzahl: 0, genau: p.genau }
    x.anzahl++
    map.set(schluessel, x)
  }
  return [...map.values()].sort((x, y) => y.anzahl - x.anzahl)
}
// Geöffnet wird immer das Original im Archiv (schreibgeschützt), nicht die Ansichtskopie
function pdfPfad(id) {
  const x = /^s\d+$/.test(String(id)) ? cacheLaden().get(String(id).slice(1)) : null
  if (!x?.pdf) throw new Error('Beleg nicht gefunden.')
  return archivNoetig().pfad(x.pdf)
}

// ---------- Ablegen einer Bestellversion ----------
// Reihenfolge: Beleg-PDF erzeugen → Original ins Archiv → Beleg ins Archiv → Ansichtskopie. Bricht es nach dem Original ab,
// erzeugt der nächste Abgleich den fehlenden Beleg (belegeNachholen).
const belegName = (nr, version) => `Umsatzbeleg Bestellung ${nr}${version > 1 ? ` (Version ${version})` : ''}.pdf`
async function belegAblegen(j, o, abgerufen, neu, hinweise) {
  const a = archivNoetig()
  if (!profil.vollstaendig()) return null // kein Umsatzbeleg ohne Pflichtangaben – wird nachgeholt, sobald sie vollständig sind
  const nr = String(j.meta.bestellung)
  const version = j.meta.version
  const rechnung = zuRechnung(o, version)
  const pdf = await belegPdf({ o, rechnung, version, jsonSha: j.sha256, abgerufen })
  const p = a.ablegen(pdf, { art: 'umsatzbeleg', jahr: j.jahr, name: belegName(nr, version), meta: { quelle: 'shopify-api', bestellung: nr, version }, sofortSchuetzen: false })
  if (!p.doppelt) neu.push(p)
  const h = ansichtsKopie(pdf, rechnung.datum, KATEGORIE, [belegName(nr, version)])
  if (h) hinweise.push(h)
  return p
}
async function ablegen(o, version, neu, hinweise) {
  const a = archivNoetig()
  const nr = String(o.name).replace(/^#/, '')
  const abgerufen = new Date().toISOString()
  const jahr = Number(zuRechnung(o, version).datum.slice(0, 4)) // Bestelldatum in Berlin, wie bei der Migration
  const jsonText = JSON.stringify({ meta: { quelle: 'Shopify Admin GraphQL API', apiVersion: API_VERSION, abgerufen }, bestellung: o }, null, 2)
  const j = a.ablegen(Buffer.from(jsonText, 'utf8'), { art: 'shopify-original', jahr, name: `Shopify Bestellung ${nr} v${version}.json`, meta: { quelle: 'shopify-api', bestellung: nr, version }, sofortSchuetzen: false })
  if (!j.doppelt) neu.push(j)
  const p = await belegAblegen(j, o, abgerufen, neu, hinweise)
  return eintragBauen(j, p, o)
}

// Originale ohne Beleg-PDF (Abbruch zwischen Original und Beleg): Beleg aus dem archivierten Original erzeugen.
// Der Originaldatensatz ändert sich nie; vorher wird sein Hash geprüft.
async function belegeNachholen(map, neu, hinweise) {
  const a = archivNoetig()
  const erg = { anzahl: 0, fehler: [], wartend: 0 }
  for (const x of map.values()) {
    if (x.pdf) continue
    if (!profil.vollstaendig()) { erg.wartend++; continue }
    try {
      const roh = fs.readFileSync(a.pfad(x.json))
      if (sha(roh) !== x.json.sha256) throw new Error('Originaldatensatz verändert')
      const j = JSON.parse(roh.toString('utf8'))
      const p = await belegAblegen(x.json, j.bestellung, j.meta.abgerufen, neu, hinweise)
      map.set(x.nr, eintragBauen(x.json, p, j.bestellung, x.zahlungen))
      if (p) erg.anzahl++
    } catch (f) {
      erg.fehler.push(`#${x.nr} v${x.version}: ${f.message}`)
    }
  }
  return erg
}

// Ältere Originale ohne Transaktionen: Zahlungen einmal nachholen und als eigene Archivdatei ablegen. Das Original und der
// Beleg bleiben unverändert (keine neue Version). Ändert sich die Bestellung später, bringt das neue Original eigene mit.
async function zahlungenNachholen(map, neu) {
  const a = archivNoetig()
  const fehlen = [...map.values()].filter((x) => !x.zahlungenBekannt && x.gid)
  let anzahl = 0
  for (let i = 0; i < fehlen.length; i += 50) {
    const teil = fehlen.slice(i, i + 50)
    const { nodes } = await graphql(ZAHLUNGEN_QUERY, { ids: teil.map((x) => x.gid) })
    const abgerufen = new Date().toISOString()
    for (const n of nodes || []) {
      const x = n?.id && teil.find((y) => y.gid === n.id)
      if (!x || !Array.isArray(n.transactions)) continue
      const text = JSON.stringify({ meta: { quelle: 'Shopify Admin GraphQL API', apiVersion: API_VERSION, abgerufen }, bestellung: { id: n.id, name: n.name, transactions: n.transactions } }, null, 2)
      const z = a.ablegen(Buffer.from(text, 'utf8'), { art: 'shopify-zahlungen', jahr: x.json.jahr, name: `Shopify Zahlungen ${x.nr}.json`, meta: { quelle: 'shopify-api', bestellung: x.nr, version: x.version }, sofortSchuetzen: false })
      if (!z.doppelt) neu.push(z)
      map.set(x.nr, eintragBauen(x.json, x.pdf, null, z))
      anzahl++
    }
  }
  return { anzahl, offen: fehlen.length - anzahl }
}

// ---------- Abgleich ----------
let laeuft = null
function abgleichen() {
  laeuft ||= (async () => {
    const a = archivNoetig()
    const map = cacheLaden()
    const neu = []
    const hinweise = []
    const erg = { neu: 0, geaendert: 0, gesehen: 0, pdfNeu: 0, zahlungenNeu: 0 }
    try {
      const nachgeholt = await belegeNachholen(map, neu, hinweise)
      erg.pdfNeu = nachgeholt.anzahl
      if (nachgeholt.fehler.length) erg.pdfFehler = nachgeholt.fehler.join('; ')
      let seit = stand.lesen()?.seit || null
      let cursor = null
      for (;;) {
        const q = seit ? `updated_at:>='${seit}'` : null // erster Lauf: alles, danach nur Neues/Geändertes
        const { orders } = await graphql(QUERY, { cursor, q })
        for (const o of orders.nodes) {
          if (o.test) continue
          erg.gesehen++
          const nr = String(o.name).replace(/^#/, '')
          const alt = map.get(nr)
          if (alt && alt.updatedAt === o.updatedAt) continue
          map.set(nr, await ablegen(o, (alt?.version || 0) + 1, neu, hinweise))
          alt ? erg.geaendert++ : erg.neu++
        }
        const letzte = orders.nodes.at(-1)?.updatedAt
        if (letzte) { seit = letzte; stand.schreiben({ seit, zuletzt: new Date().toISOString() }) } // fortsetzbar bei Abbruch
        if (!orders.pageInfo.hasNextPage) break
        cursor = orders.pageInfo.endCursor
      }
      stand.schreiben({ seit, zuletzt: new Date().toISOString() })
      try {
        const z = await zahlungenNachholen(map, neu)
        erg.zahlungenNeu = z.anzahl
        if (z.offen) hinweise.push(`Zahlungsdatum für ${z.offen} Bestellung(en) nicht gefunden.`)
      } catch (f) { hinweise.push(`Zahlungsdaten konnten nicht geholt werden: ${f.message}`) }
      const ohneBeleg = [...map.values()].filter((x) => !x.pdf).length
      if (ohneBeleg && !profil.vollstaendig()) hinweise.push(`${ohneBeleg} Umsatzbeleg(e) warten auf „Meine Angaben“: Pflichtangaben fehlen. Die Bestellungen sind im Archiv, die Belege werden danach automatisch erzeugt.`)
    } catch (fehler) {
      cache = null // Zwischenspeicher kann vom Archiv abweichen (z. B. Original abgelegt, Beleg nicht) → beim nächsten Mal neu aus dem Archiv lesen
      throw fehler
    } finally {
      const schutz = a.nachSchuetzen(neu) // auch nach einem Fehler: alles bis dahin Abgelegte schützen
      if (neu.length && schutz.schutzFehler) hinweise.push(`Windows-Schutz: ${schutz.schutzFehler[0]}`)
      if (hinweise.length) erg.hinweise = hinweise
    }
    return erg
  })().finally(() => { laeuft = null })
  return laeuft
}

// Nach Änderung von „Meine Angaben“: Einträge neu aus dem Archiv berechnen (Steuerstatus, Shopname). Belege bleiben unverändert.
function neuBerechnen() { if (!laeuft) cache = null }
const beschaeftigt = () => !!laeuft
const warten = () => laeuft || Promise.resolve()
module.exports = { einrichten, neufassungPlanen, neufassungVorschau, neufassungErzeugen, abgleichen, eintraege, steuerBefund, neuBerechnen, orte, pdfPfad, zuRechnung, zahlungAus, belegOrdner, ansichtsKopie, beschaeftigt, warten, WURZEL }
