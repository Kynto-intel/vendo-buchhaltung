'use strict'
// Migration des bisherigen Archivs ins neue Belegarchiv (Plan 7.5 Punkt 12).
//
// trockenlauf() (Schritt 1.3): liest das alte Archiv (<WURZEL>\_Vendo-Archiv mit Shopify- und Shirtigo-Index) und die
//   Beleg-PDFs in den Monatsordnern, auf die diese Indizes verweisen, und berichtet, was ins neue Archiv kopiert WÜRDE.
//   Schreibt, kopiert, verschiebt und löscht nichts – nur lesende Dateifunktionen.
// umziehen() (Schritt 1.4): führt genau diesen Plan aus – Kopie → Hash-Vergleich → Protokoll als eigener Kettenschritt.
//   Schreibt ausschließlich ins neue Archiv; die alten Dateien und Monatsordner bleiben unverändert.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { archiv, sichererName } = require('./archiv')

const NULLHASH = '0'.repeat(64)
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex')
const innerhalb = (kind, eltern) => { const rel = path.relative(eltern, kind); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) }
const gueltigesJahr = (j) => Number.isInteger(j) && j >= 2000 && j <= 2100
const berlinJahr = (zeit) => { const d = new Date(zeit); return Number.isNaN(d.getTime()) ? null : Number(d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 4)) }
// Shirtigo liefert 'JJJJ-MM-TT hh:mm:ss' in UTC (wie in shirtigo-bestellungen.js); ISO-Zeiten mit Zone bleiben unverändert
const shirtigoZeit = (x) => { const s = String(x || ''); return /[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z` }
const quellen = new WeakMap() // Planzeile -> absoluter Quellpfad (nicht im Bericht, damit dort keine persönlichen Pfade stehen)
const anzeige = (rel) => String(rel).split(/[\\/]+/).join('/')

function alleDateien(ordner) {
  if (!fs.existsSync(ordner)) return []
  return fs.readdirSync(ordner, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? alleDateien(path.join(ordner, d.name)) : d.isFile() ? [path.join(ordner, d.name)] : [])
}

// Liest einen Index (jsonl) und prüft die Hash-Kette wie bestellungen.js / shirtigo-bestellungen.js
function indexPruefen(datei) {
  if (!fs.existsSync(datei)) return { vorhanden: false, zeilen: [], ok: true, geprueft: 0, letzterHash: NULLHASH, fehler: [] }
  const fehler = []
  const zeilen = []
  let vorher = NULLHASH
  for (const [i, text] of fs.readFileSync(datei, 'utf8').split('\n').entries()) {
    if (!text.trim()) continue
    let e
    try { e = JSON.parse(text) } catch { fehler.push(`Indexzeile ${i + 1} ist unlesbar`); continue }
    const { hash, ...rest } = e
    if (e.vorher !== vorher) fehler.push(`Index-Kette unterbrochen in Zeile ${i + 1}`)
    if (sha(JSON.stringify(rest)) !== hash) fehler.push(`Indexeintrag verändert in Zeile ${i + 1}`)
    vorher = hash
    zeilen.push(e)
  }
  return { vorhanden: true, zeilen, ok: fehler.length === 0, geprueft: zeilen.length, letzterHash: vorher, fehler }
}

// optionen: { wurzel (Arbeitsordner mit Monatsordnern), ziel (neues Archiv), archivAlt?, jahr? (für die alten Indexdateien) }
function trockenlauf({ wurzel, ziel, archivAlt, jahr = new Date().getFullYear() } = {}) {
  if (!path.isAbsolute(String(wurzel || '')) || !path.isAbsolute(String(ziel || ''))) throw new Error('Arbeitsordner und Zielarchiv müssen absolute Pfade sein.')
  wurzel = path.resolve(wurzel)
  ziel = path.resolve(ziel)
  archivAlt = path.resolve(archivAlt || path.join(wurzel, '_Vendo-Archiv'))
  if (innerhalb(ziel, wurzel) || innerhalb(wurzel, ziel)) throw new Error('Das neue Archiv muss getrennt vom Arbeitsordner liegen.')
  if (!gueltigesJahr(jahr)) throw new Error('Ungültiges Jahr.')
  const shirtigoOrdner = path.join(archivAlt, 'shirtigo')
  const indexShopify = path.join(archivAlt, 'index.jsonl')
  const indexShirtigo = path.join(shirtigoOrdner, 'index.jsonl')

  const kandidaten = [] // { herkunft, basis, rel, art, jahr, name, sollSha, meta }
  const probleme = [] // verhindern den echten Umzug
  const hinweise = [] // Information, kein Hindernis
  const ersetzt = [] // ältere Indexeinträge, deren Datei durch einen neueren Eintrag ersetzt wurde
  const bekannt = new Set() // alle Dateien, auf die ein Index verweist (auch ersetzte)
  const merken = (basis, rel) => bekannt.add(path.resolve(basis, rel).toLowerCase())
  const zeigen = (voll) => anzeige(innerhalb(voll, wurzel) ? path.relative(wurzel, voll) : voll)

  // --- Shopify: je Bestellung + Version zählt der letzte Eintrag (neu erzeugte PDFs ersetzen den älteren) ---
  const shopify = indexPruefen(indexShopify)
  const letzteShopify = new Map()
  for (const e of shopify.zeilen) letzteShopify.set(`${e.nr}|${e.version}`, e)
  for (const e of shopify.zeilen) {
    if (e.json?.datei) merken(archivAlt, e.json.datei)
    if (e.pdf?.datei) merken(wurzel, e.pdf.datei)
    if (letzteShopify.get(`${e.nr}|${e.version}`) !== e) ersetzt.push(`Shopify #${e.nr} v${e.version}`)
  }
  for (const e of letzteShopify.values()) {
    const j = berlinJahr(e.createdAt)
    const meta = { quelle: 'migration', bestellung: String(e.nr), version: e.version }
    if (e.json?.datei) kandidaten.push({ herkunft: 'shopify-json', basis: archivAlt, rel: e.json.datei, art: 'shopify-original', jahr: j, name: `Shopify Bestellung ${e.nr} v${e.version}.json`, sollSha: e.json.sha256, meta })
    else probleme.push(`Shopify #${e.nr} v${e.version}: Indexeintrag ohne Originaldatensatz`)
    if (e.pdf?.datei) kandidaten.push({ herkunft: 'shopify-pdf', basis: wurzel, rel: e.pdf.datei, art: 'umsatzbeleg', jahr: j, name: path.basename(anzeige(e.pdf.datei)), sollSha: e.pdf.sha256, meta })
    else probleme.push(`Shopify #${e.nr} v${e.version}: Indexeintrag ohne Beleg-PDF`)
  }

  // --- Shirtigo: Originaldatensätze je Version, PDF je Referenz (nur die letzte zählt) ---
  const shirtigo = indexPruefen(indexShirtigo)
  const jsonJahr = new Map()
  const letztesPdf = new Map()
  for (const e of shirtigo.zeilen) {
    if (e.art === 'pdf') {
      if (e.pdf?.datei) merken(wurzel, e.pdf.datei)
      if (letztesPdf.has(e.ref)) ersetzt.push(`Shirtigo ${e.ref} PDF`)
      letztesPdf.set(e.ref, e)
      continue
    }
    if (!e.json?.datei) { probleme.push(`Shirtigo ${e.ref} v${e.version}: Indexeintrag ohne Originaldatensatz`); continue }
    merken(shirtigoOrdner, e.json.datei)
    let j = null
    try { j = berlinJahr(shirtigoZeit(JSON.parse(fs.readFileSync(path.join(shirtigoOrdner, e.json.datei), 'utf8')).bestellung?.created_at)) } catch { /* fehlt/verändert: unten gemeldet */ }
    j ||= berlinJahr(e.updatedAt) || berlinJahr(e.abgerufen)
    if (gueltigesJahr(j)) jsonJahr.set(e.ref, j)
    kandidaten.push({ herkunft: 'shirtigo-json', basis: shirtigoOrdner, rel: e.json.datei, art: 'shirtigo-original', jahr: j, name: `Shirtigo Bestellung ${e.ref} v${e.version}.json`, sollSha: e.json.sha256, meta: { quelle: 'migration', shirtigo: String(e.ref), version: e.version } })
  }
  for (const e of letztesPdf.values()) {
    const ordnerJahr = Number(anzeige(e.pdf.datei).split('/')[0]) // Monatsordner <Jahr>\<MM - Monat>\...
    const j = gueltigesJahr(ordnerJahr) ? ordnerJahr : jsonJahr.get(e.ref) || berlinJahr(e.abgerufen)
    kandidaten.push({ herkunft: 'shirtigo-pdf', basis: wurzel, rel: e.pdf.datei, art: 'eingang', jahr: j, name: path.basename(anzeige(e.pdf.datei)), sollSha: e.pdf.sha256, meta: { quelle: 'migration', shirtigo: String(e.ref), rechnungsnummer: e.rechnungsnummer || undefined } })
  }

  // --- Die alten Indexdateien selbst: belegen die bisherige Kette (Umzug wird in 1.4 eigener Kettenschritt) ---
  for (const [datei, name, info] of [[indexShopify, 'shopify-index.jsonl', shopify], [indexShirtigo, 'shirtigo-index.jsonl', shirtigo]]) {
    if (!info.vorhanden) continue
    merken(datei, '')
    kandidaten.push({ herkunft: 'alt-index', basis: path.dirname(datei), rel: path.basename(datei), art: 'alt-index', jahr, name, sollSha: null, meta: { quelle: 'migration', letzterHash: info.letzterHash, eintraege: info.geprueft } })
  }
  if (!shopify.vorhanden && !shirtigo.vorhanden) hinweise.push('Kein altes Archiv gefunden (kein Index vorhanden).')
  for (const f of shopify.fehler) probleme.push(`Shopify-Index: ${f}`)
  for (const f of shirtigo.fehler) probleme.push(`Shirtigo-Index: ${f}`)

  // --- Jede Datei lesen, Hash prüfen, Ziel bestimmen ---
  const neu = archiv(ziel) // nur lesend benutzt (eintraege/finden)
  const zielEintraege = neu.eintraege()
  const geplant = new Map() // art|sha -> Zielpfad im Plan
  const dateien = []
  for (const k of kandidaten) {
    const voll = path.resolve(k.basis, k.rel)
    const zeile = { herkunft: k.herkunft, quelle: zeigen(voll), art: k.art, jahr: k.jahr }
    if (!innerhalb(voll, k.basis) || path.isAbsolute(k.rel)) { probleme.push(`${zeile.quelle}: Pfad liegt außerhalb des erwarteten Ordners`); dateien.push({ ...zeile, status: 'pfad-ungueltig' }); continue }
    if (!gueltigesJahr(k.jahr)) { probleme.push(`${zeile.quelle}: Jahr nicht bestimmbar`); dateien.push({ ...zeile, status: 'jahr-unbekannt' }); continue }
    const info = fs.statSync(voll, { throwIfNoEntry: false })
    if (!info?.isFile()) { probleme.push(`Datei fehlt: ${zeile.quelle}`); dateien.push({ ...zeile, status: 'fehlt' }); continue }
    const inhalt = fs.readFileSync(voll)
    const hash = sha(inhalt)
    if (k.sollSha && hash !== k.sollSha) { probleme.push(`Datei verändert (Hash passt nicht zum alten Index): ${zeile.quelle}`); dateien.push({ ...zeile, status: 'veraendert', sha256: hash, bytes: inhalt.length }); continue }
    if (!inhalt.length) { probleme.push(`Datei ist leer: ${zeile.quelle}`); dateien.push({ ...zeile, status: 'leer' }); continue }
    const { stamm, endung } = sichererName(k.name)
    const zielRel = `${k.jahr}/${k.art}/${stamm}__${hash.slice(0, 12)}${endung}`
    const basisZeile = { ...zeile, sha256: hash, bytes: inhalt.length, ziel: zielRel, name: `${stamm}${endung}`, meta: k.meta }
    const imArchiv = zielEintraege.find((e) => e.sha256 === hash && e.art === k.art)
    if (imArchiv) { dateien.push({ ...basisZeile, status: 'schon-im-archiv', ziel: imArchiv.datei }); continue }
    if (geplant.has(`${k.art}|${hash}`)) { dateien.push({ ...basisZeile, status: 'doppelt', ziel: geplant.get(`${k.art}|${hash}`) }); continue }
    const zielVoll = path.join(ziel, ...zielRel.split('/'))
    const belegt = fs.statSync(zielVoll, { throwIfNoEntry: false })
    // Gleicher Inhalt am Zielpfad = Rest eines abgebrochenen Umzugs (Datei geschrieben, Indexeintrag fehlt): archiv.ablegen übernimmt ihn
    const rest = belegt?.isFile() && sha(fs.readFileSync(zielVoll)) === hash
    if (belegt && !rest) { probleme.push(`Zielpfad im neuen Archiv ist schon belegt, aber nicht im Index: ${zielRel}`); dateien.push({ ...basisZeile, status: 'ziel-belegt' }); continue }
    geplant.set(`${k.art}|${hash}`, zielRel)
    const z = { ...basisZeile, status: 'kopieren', ...(rest ? { wiederaufnahme: true } : {}) }
    quellen.set(z, voll)
    dateien.push(z)
  }

  // --- Fremde Dateien im alten Archiv (weder Index noch Abgleichstand noch referenziert) ---
  const fremd = []
  for (const datei of alleDateien(archivAlt)) {
    const schluessel = path.resolve(datei).toLowerCase()
    if (bekannt.has(schluessel)) continue
    if (schluessel === path.join(archivAlt, 'sync.json').toLowerCase()) { hinweise.push('sync.json (Stand des letzten Shopify-Abgleichs) ist veränderlich und kein Beleg – wird nicht ins Archiv übernommen.'); continue }
    fremd.push(anzeige(path.relative(archivAlt, datei)))
  }
  if (fremd.length) hinweise.push(`${fremd.length} Datei(en) im alten Archiv stehen in keinem Index und werden nicht übernommen (bitte ansehen).`)

  // --- Übrige Dateien in den Monatsordnern: nicht von Vendo verwaltet, nicht Teil dieser Migration (später 1.6/3.5) ---
  const nichtVerwaltet = { anzahl: 0, bytes: 0, jeJahr: {}, endungen: {} }
  for (const datei of alleDateien(wurzel)) {
    if (innerhalb(datei, archivAlt) || bekannt.has(path.resolve(datei).toLowerCase())) continue
    const j = anzeige(path.relative(wurzel, datei)).split('/')[0]
    const endung = path.extname(datei).toLowerCase() || '(ohne)'
    nichtVerwaltet.anzahl++
    nichtVerwaltet.bytes += fs.statSync(datei).size
    nichtVerwaltet.jeJahr[/^\d{4}$/.test(j) ? j : 'andere'] = (nichtVerwaltet.jeJahr[/^\d{4}$/.test(j) ? j : 'andere'] || 0) + 1
    nichtVerwaltet.endungen[endung] = (nichtVerwaltet.endungen[endung] || 0) + 1
  }

  const zusammenfassung = { kopieren: 0, bytes: 0, doppelt: 0, schonImArchiv: 0, fehlerhaft: 0, jeJahrArt: {} }
  for (const d of dateien) {
    if (d.status === 'kopieren') {
      zusammenfassung.kopieren++
      zusammenfassung.bytes += d.bytes
      const x = (zusammenfassung.jeJahrArt[`${d.jahr}/${d.art}`] ||= { anzahl: 0, bytes: 0 })
      x.anzahl++
      x.bytes += d.bytes
    } else if (d.status === 'doppelt') zusammenfassung.doppelt++
    else if (d.status === 'schon-im-archiv') zusammenfassung.schonImArchiv++
    else zusammenfassung.fehlerhaft++
  }

  return {
    trockenlauf: true, geschrieben: false, bereit: probleme.length === 0,
    quelle: { wurzel, archivAlt }, ziel: { pfad: ziel, vorhanden: fs.existsSync(ziel), eintraege: zielEintraege.length },
    ketten: { shopify: { vorhanden: shopify.vorhanden, ok: shopify.ok, geprueft: shopify.geprueft, letzterHash: shopify.letzterHash }, shirtigo: { vorhanden: shirtigo.vorhanden, ok: shirtigo.ok, geprueft: shirtigo.geprueft, letzterHash: shirtigo.letzterHash } },
    zusammenfassung, dateien, probleme, hinweise, ersetzt, fremd, nichtVerwaltet
  }
}

// Lesbarer Kurzbericht (nur Zahlen und Pfade relativ zu den Archivordnern)
function berichtText(p) {
  const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`
  const z = p.zusammenfassung
  const zeilen = [
    'TROCKENLAUF – es wurde nichts geschrieben, kopiert oder verschoben.',
    `Quelle: ${p.quelle.wurzel}  (altes Archiv: ${p.quelle.archivAlt})`,
    `Ziel:   ${p.ziel.pfad}  (${p.ziel.vorhanden ? `vorhanden, ${p.ziel.eintraege} Einträge` : 'noch nicht angelegt'})`,
    `Alte Ketten: Shopify ${p.ketten.shopify.vorhanden ? `${p.ketten.shopify.geprueft} Einträge, ${p.ketten.shopify.ok ? 'ok' : 'FEHLER'}` : 'kein Index'}; Shirtigo ${p.ketten.shirtigo.vorhanden ? `${p.ketten.shirtigo.geprueft} Einträge, ${p.ketten.shirtigo.ok ? 'ok' : 'FEHLER'}` : 'kein Index'}`,
    `Würde kopieren: ${z.kopieren} Dateien (${mb(z.bytes)}); doppelt: ${z.doppelt}; schon im neuen Archiv: ${z.schonImArchiv}; fehlerhaft: ${z.fehlerhaft}`,
    ...Object.entries(z.jeJahrArt).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `  ${k}: ${v.anzahl} (${mb(v.bytes)})`),
    `Ersetzte ältere Indexeinträge (nicht kopiert, Kette bleibt im alten Index belegt): ${p.ersetzt.length}`,
    `Nicht von Vendo verwaltete Dateien in den Monatsordnern (nicht Teil dieser Migration): ${p.nichtVerwaltet.anzahl} (${mb(p.nichtVerwaltet.bytes)})`,
    `Bereit für den echten Umzug: ${p.bereit ? 'ja' : 'NEIN – erst die Probleme klären'}`
  ]
  if (p.probleme.length) zeilen.push('Probleme:', ...p.probleme.map((x) => `  - ${x}`))
  if (p.hinweise.length) zeilen.push('Hinweise:', ...p.hinweise.map((x) => `  - ${x}`))
  if (p.fremd.length) zeilen.push('Dateien ohne Index im alten Archiv:', ...p.fremd.map((x) => `  - ${x}`))
  return zeilen.join('\n')
}

// Echter Umzug (Schritt 1.4). Startet nur, wenn der Trockenlauf keine Probleme meldet. Jede Datei wird vor dem Ablegen
// erneut gelesen und mit dem Plan verglichen, nach dem Ablegen aus dem Archiv zurückgelesen und noch einmal verglichen.
// Bei einem Fehler endet der Lauf sofort; bereits abgelegte Dateien bleiben (ein neuer Lauf setzt dort fort).
// Am Ende: Protokoll ins Archiv (Art „protokoll“), Integritätsprüfung, dann Windows-Schutz für alle Archivdateien.
// optionen: wie trockenlauf + { schutz } (./schutz in der App, Stub in Tests, null = kein Schutz)
function umziehen({ wurzel, ziel, archivAlt, jahr = new Date().getFullYear(), schutz = null } = {}) {
  const plan = trockenlauf({ wurzel, ziel, archivAlt, jahr })
  if (!plan.bereit) throw new Error(`Umzug nicht gestartet: Der Trockenlauf meldet ${plan.probleme.length} Problem(e). Es wurde nichts kopiert.`)
  const offen = plan.dateien.filter((d) => d.status === 'kopieren')
  const ergebnis = { ok: false, kopiert: 0, bytes: 0, uebernommen: plan.zusammenfassung.schonImArchiv + plan.zusammenfassung.doppelt, fehler: [], protokoll: null }
  if (!offen.length) return { ...ergebnis, ok: true, integritaet: archiv(plan.ziel.pfad).integritaet() }

  const beginn = new Date().toISOString()
  const a = archiv(plan.ziel.pfad) // Schutz erst am Ende gesammelt (ein PowerShell-Aufruf je Paket statt je Datei)
  const kopiert = []
  for (const d of offen) {
    try {
      const inhalt = fs.readFileSync(quellen.get(d))
      if (sha(inhalt) !== d.sha256) throw new Error('Quelle hat sich seit dem Trockenlauf verändert')
      const e = a.ablegen(inhalt, { art: d.art, jahr: d.jahr, name: d.name, meta: d.meta })
      if (e.datei !== d.ziel) throw new Error(`abgelegt unter ${e.datei} statt ${d.ziel}`)
      if (e.doppelt) throw new Error('war unerwartet schon im Archiv')
      if (sha(fs.readFileSync(a.pfad(e))) !== d.sha256) throw new Error('Kopie im Archiv weicht vom Original ab')
      kopiert.push({ nr: e.nr, quelle: d.quelle, ziel: e.datei, sha256: d.sha256, bytes: d.bytes })
      ergebnis.bytes += d.bytes
    } catch (f) {
      ergebnis.fehler.push(`${d.quelle}: ${f.message}`)
      break
    }
  }
  ergebnis.kopiert = kopiert.length

  const pruefung = a.integritaet()
  const protokoll = {
    vorgang: 'Migration altes Archiv → neues Belegarchiv (Plan 7.5 Punkt 12, Schritt 1.4)',
    beginn, ende: new Date().toISOString(), vollstaendig: ergebnis.fehler.length === 0 && kopiert.length === offen.length,
    alteKetten: plan.ketten, geplant: offen.length, kopiert: kopiert.length, bytes: ergebnis.bytes,
    schonImArchiv: plan.zusammenfassung.schonImArchiv, doppelt: plan.zusammenfassung.doppelt,
    nichtUebernommen: { hinweise: plan.hinweise, fremd: plan.fremd, nichtVerwaltet: { anzahl: plan.nichtVerwaltet.anzahl, bytes: plan.nichtVerwaltet.bytes } },
    integritaetVorProtokoll: { ok: pruefung.ok, geprueft: pruefung.geprueft, letzterHash: pruefung.letzterHash, fehler: pruefung.fehler },
    fehler: ergebnis.fehler, dateien: kopiert
  }
  try {
    const stempel = protokoll.ende.slice(0, 19).replace(/:/g, '-')
    ergebnis.protokoll = a.ablegen(Buffer.from(JSON.stringify(protokoll, null, 2), 'utf8'), {
      art: 'protokoll', jahr, name: `Migration ${stempel}.json`,
      meta: { vorgang: 'migration', vollstaendig: protokoll.vollstaendig, kopiert: kopiert.length, letzterHashVorher: pruefung.letzterHash }
    }).datei
  } catch (f) {
    ergebnis.fehler.push(`Protokoll: ${f.message}`)
  }

  ergebnis.integritaet = a.integritaet()
  if (schutz) Object.assign(ergebnis, archiv(plan.ziel.pfad, { schutz }).alleSchuetzen())
  ergebnis.ok = protokoll.vollstaendig && !!ergebnis.protokoll && ergebnis.integritaet.ok && ergebnis.fehler.length === 0
  return ergebnis
}

module.exports = { trockenlauf, umziehen, berichtText, indexPruefen }
