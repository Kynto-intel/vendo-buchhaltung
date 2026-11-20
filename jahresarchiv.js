'use strict'
// Jahresarchiv als ZIP (Plan 11.4, E.1). Vorbild: Jahresexport von „haben“ (nur Aufbau und CSV-Regeln, kein Code).
//
// Inhalt: LIESMICH.txt, umsatzbelege/, eingang/, originale/ (byte-genau aus dem Belegarchiv, Prüfsumme vor dem Packen
// geprüft), bestellungen.csv, zahlungen.csv, einkaeufe.csv, belege.csv, euer.csv, angaben.json (Firmendaten, ohne
// persönliche Angaben), protokoll/ (Auszug der Hash-Kette des Jahres, Prüfwert, Siegel, Zeitstempel, Zertifikate),
// FEHLER.txt (nur bei Problemen; der Export bricht nicht ab), pruefsummen.sha256.
// CSV wie bei „haben“: UTF-8 mit BOM, Semikolon, CRLF, Dezimalkomma, Datum JJJJ-MM-TT, RFC 4180.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const ORDNER = { umsatzbeleg: 'umsatzbelege', eingang: 'eingang', 'shopify-original': 'originale/shopify', 'shopify-zahlungen': 'originale/shopify-zahlungen', 'shirtigo-original': 'originale/shirtigo', siegel: 'protokoll/siegel', zeitstempel: 'protokoll/zeitstempel', zertifikat: 'protokoll/zertifikate', pruefbericht: 'protokoll/pruefberichte', protokoll: 'protokoll/vorgaenge' }
const GEPACKT = /\.(json|jsonl|txt|csv|xml|md)$/i // Text komprimieren, PDFs und Bilder nur ablegen

// Spalten der Tabellen: [Name, Typ, Bedeutung]. Die Kopfzeilen der CSVs kommen von hier, die Verfahrensdokumentation
// (verfahren.js, Abschnitt Z3) beschreibt die Tabellen aus derselben Liste.
const T = 'Text', D = 'Datum', B = 'Betrag', J = 'ja/nein'
const WIRKSAM = 'Betrag, der in die EÜR eingeht (als Kleinunternehmer brutto, sonst netto)'
const TABELLEN = {
  'bestellungen.csv': [['Bestellnummer', T, 'Shopify-Bestellnummer'], ['Version', T, 'Version des Originaldatensatzes (neue Version bei Änderung)'], ['Bestelltag', D, 'Tag der Bestellung'], ['Zahlungstag', D, 'Tag des Zahlungseingangs (Zufluss)'], ['Storniert', J, 'Bestellung storniert'], ['Bezahlt', J, 'vollständig bezahlt'], ['Brutto', B, 'Bruttobetrag nach Erstattungen'], ['Umsatzsteuer', B, 'enthaltene Umsatzsteuer'], ['Netto', B, 'Nettobetrag'], ['Wirksam', B, WIRKSAM], ['Steuersatz', B, 'Steuersatz in Prozent (0 als Kleinunternehmer)'], ['Kleinunternehmer', J, '§ 19 UStG angewendet'], ['Zahlungsart', T, 'Zahlungsanbieter laut Shopify'], ['Belegdatei', T, 'Dateiname des Umsatzbelegs in umsatzbelege/'], ['SHA-256 Original', T, 'Prüfsumme des Umsatzbelegs']],
  'zahlungen.csv': [['Bestellnummer', T, 'Shopify-Bestellnummer'], ['Art', T, 'Eingang oder Erstattung'], ['Tag', D, 'Tag der Zahlung'], ['Betrag', B, 'Betrag'], ['Zahlungsart', T, 'Zahlungsanbieter']],
  'einkaeufe.csv': [['Shirtigo-Referenz', T, 'Auftragsnummer bei Shirtigo'], ['Rechnungsnummer', T, 'Rechnungsnummer von Shirtigo'], ['Datum', D, 'Rechnungsdatum'], ['Brutto', B, 'Bruttobetrag'], ['Umsatzsteuer', B, 'ausgewiesene Umsatzsteuer'], ['Netto', B, 'Nettobetrag'], ['Wirksam', B, WIRKSAM], ['Belegdatei', T, 'Dateiname der Rechnung in eingang/'], ['SHA-256 Beleg', T, 'Prüfsumme der Rechnung']],
  'belege.csv': [['Lieferant', T, 'Aussteller des eingelesenen Belegs'], ['Rechnungsnummer', T, 'Nummer auf dem Beleg'], ['Datum', D, 'Belegdatum'], ['Art', T, 'ausgabe oder einnahme'], ['Brutto', B, 'Bruttobetrag'], ['Umsatzsteuer', B, 'ausgewiesene Umsatzsteuer'], ['Netto', B, 'Nettobetrag'], ['Wirksam', B, WIRKSAM], ['§ 13b-Steuer', B, 'selbst geschuldete Umsatzsteuer (§ 13b UStG)'], ['Ausgeblendet', J, 'in der Ansicht ausgeblendet (bleibt im Archiv)'], ['SHA-256 Beleg', T, 'Prüfsumme der Datei in eingang/']],
  'euer.csv': [['Kennzahl', T, 'Kennzahl der Anlage EÜR (leer bei Summenzeilen)'], ['Bezeichnung', T, 'Bezeichnung'], ['Betrag', B, 'Betrag des Jahres']]
}
const kopf = (datei) => TABELLEN[datei].map(([n]) => n)

// ---------- CSV ----------
const zelle = (w) => {
  if (w === null || w === undefined) return ''
  const t = typeof w === 'number' ? (Number.isFinite(w) ? w.toFixed(2).replace('.', ',') : '') : typeof w === 'boolean' ? (w ? 'ja' : 'nein') : String(w)
  return /[;"\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
}
const csv = (kopf, zeilen) => Buffer.from('﻿' + [kopf, ...zeilen].map((z) => z.map(zelle).join(';')).join('\r\n') + '\r\n', 'utf8')
const tag = (x) => (/^\d{4}-\d{2}-\d{2}/.test(String(x || '')) ? String(x).slice(0, 10) : '')
const name = (datei) => String(datei || '').split('/').pop()

function liesmich({ jahr, firma, jetzt, version, anzahl, pruefwert }) {
  return Buffer.from([
    `Jahresarchiv ${jahr} – ${firma.firmenname || 'Buchhaltung'}`, '',
    `Erstellt: ${jetzt} mit Vendo, Plugin Buchhaltung ${version}`,
    `Steuernummer: ${firma.steuernummer || '–'}   Finanzamt: ${firma.finanzamt || '–'}`, '',
    'Ordner und Dateien:',
    '  umsatzbelege/       Umsatzbelege der Shop-Bestellungen (PDF, unverändert aus dem Belegarchiv)',
    '  eingang/            Eingangsrechnungen (Shirtigo, eingelesene PDFs), unverändert',
    '  originale/          Originaldatensätze von Shopify und Shirtigo (JSON) und Zahlungsnachweise, unverändert',
    '  bestellungen.csv    je Bestellung: Nummer, Bestelltag, Zahlungstag, Beträge, Belegdatei, SHA-256',
    '  zahlungen.csv       Zahlungseingänge und Erstattungen je Bestellung',
    '  einkaeufe.csv       Shirtigo-Rechnungen   belege.csv   eingelesene Belege',
    '  euer.csv            Kennzahlen der Anlage EÜR des Jahres (zum Abtippen in Mein ELSTER, ohne Gewähr)',
    '  angaben.json        Firmendaten zum Zeitpunkt des Exports',
    '  verfahrensdokumentation.md  Beschreibung des Verfahrens (GoBD) mit Beschreibung der Tabellen',
    '  jahresnachweis.md   Belege, Prüfungen, Siegel und Sicherung des Jahres',
    '  protokoll/          Auszug der Hash-Kette (index-JJJJ.jsonl), vollständige Kette (kette-gesamt.jsonl, nur Metadaten),',
    '                      pruefwert.txt, alle Siegel mit Zeitstempeln und Zertifikaten (auch aus späteren Jahren)',
    '  FEHLER.txt          nur wenn eine Datei fehlte oder nicht zur Prüfsumme passte',
    '  pruefsummen.sha256  SHA-256 jeder anderen Datei', '',
    `Anzahl Dateien: ${anzahl}. Prüfwert der Hash-Kette beim Export: ${pruefwert || '–'}`, '',
    'Prüfen (Windows PowerShell, im entpackten Ordner):',
    '  Get-FileHash -Algorithm SHA256 <Datei>   und mit pruefsummen.sha256 vergleichen.', '',
    'CSV: UTF-8 mit BOM, Semikolon, Zeilenende CRLF, Beträge mit Dezimalkomma, Datum JJJJ-MM-TT.',
    'Aufbewahrung (§ 147 AO, § 14b UStG): Bücher und Aufzeichnungen 10 Jahre, Buchungsbelege 8 Jahre (seit 2025),',
    'elektronisch erhaltene Rechnungen elektronisch. Ohne Gewähr, keine Steuerberatung.', ''
  ].join('\r\n'), 'utf8')
}

// Alle Dateien des Jahresarchivs zusammenstellen (ohne ZIP, testbar). quellen wie im Index (datenbank-index.js).
function zusammenstellen({ jahr, archiv, shop = [], shirtigo = [], belege = [], euer = null, firma = {}, version = '', jetzt = new Date().toISOString(), zusatz = null }) {
  jahr = String(jahr)
  const dateien = []
  const fehler = []
  const alle = archiv.eintraege()
  // Siegel, Zeitstempel und Zertifikate liegen unter dem Jahr der Versiegelung; sie decken aber auch frühere Jahre: immer alle mit
  const NACHWEIS = new Set(['siegel', 'zeitstempel', 'zertifikat'])
  const imJahr = alle.filter((e) => ORDNER[e.art] && (String(e.jahr) === jahr || NACHWEIS.has(e.art)))
  const vergeben = new Set()
  for (const e of imJahr) {
    let ziel = `${ORDNER[e.art]}/${name(e.datei)}`
    if (vergeben.has(ziel)) ziel = ziel.replace(/(\.[^.]*)?$/, `-${e.nr}$1`)
    vergeben.add(ziel)
    let inhalt
    try { inhalt = fs.readFileSync(archiv.pfad(e)) } catch { fehler.push(`Datei fehlt im Archiv: ${e.datei}`); continue }
    if (sha(inhalt) !== e.sha256) { fehler.push(`Datei passt nicht zur Prüfsumme und wurde nicht übernommen: ${e.datei}`); continue }
    dateien.push({ name: ziel, inhalt })
  }
  const imJahrTag = (d) => tag(d).startsWith(jahr)
  const shopJahr = shop.filter((e) => imJahrTag(e?.rechnung?.datum))
  dateien.push({ name: 'bestellungen.csv', inhalt: csv(kopf('bestellungen.csv'),
    shopJahr.map(({ beleg = {}, rechnung: r }) => [r.referenz, String(beleg.version ?? ''), tag(r.datum), tag(r.zahlung?.datum), !!r.storniert, !!r.zahlung?.bezahlt, r.summen?.brutto ?? 0, r.summen?.mwst ?? 0, r.summen?.netto ?? 0, r.wirksam ?? 0, r.summen?.mwstSatz ?? 0, !!r.kleinunternehmer, r.zahlung?.art || '', name(beleg.pdf), beleg.sha256 || ''])) })
  dateien.push({ name: 'zahlungen.csv', inhalt: csv(kopf('zahlungen.csv'),
    shop.flatMap(({ rechnung: r }) => [...(r?.zahlung?.eingaenge || []).map((z) => [r.referenz, 'Eingang', tag(z.datum), z.betrag, z.gateway || '']), ...(r?.zahlung?.erstattungen || []).map((z) => [r.referenz, 'Erstattung', tag(z.datum), z.betrag, z.gateway || ''])]).filter((z) => z[2].startsWith(jahr))) })
  dateien.push({ name: 'einkaeufe.csv', inhalt: csv(kopf('einkaeufe.csv'),
    shirtigo.filter((e) => imJahrTag(e?.rechnung?.datum)).map(({ id, beleg = {}, rechnung: r }) => [String(id).replace(/^t/, ''), r.rechnungsnummer || '', tag(r.datum), r.summen?.brutto ?? 0, r.summen?.mwst ?? 0, r.summen?.netto ?? 0, r.wirksam ?? 0, name(beleg.pdf), beleg.sha256 || ''])) })
  dateien.push({ name: 'belege.csv', inhalt: csv(kopf('belege.csv'),
    belege.filter((d) => imJahrTag(d?.rechnung?.datum)).map(({ rechnung: r, ausgeblendet, archiv: a }) => [r.lieferant || '', r.rechnungsnummer || '', tag(r.datum), r.art || '', r.summen?.brutto ?? 0, r.summen?.mwst ?? 0, r.summen?.netto ?? 0, r.wirksam ?? 0, r.p13b?.steuer ?? 0, !!ausgeblendet, a?.sha256 || ''])) })
  const kz = [['111', 'Betriebseinnahmen als Kleinunternehmer', 'kz111'], ['112', 'Umsatzsteuerpflichtige Betriebseinnahmen (netto)', 'kz112'], ['140', 'Vereinnahmte Umsatzsteuer', 'kz140'], ['100', 'Waren, Rohstoffe und Hilfsstoffe', 'kz100'], ['186', 'An das Finanzamt gezahlte Umsatzsteuer', 'kz186'], ['', 'Übrige Ausgaben (Kennzahl je Art selbst zuordnen)', 'sonstige'], ['', 'Summe Einnahmen', 'einnahmen'], ['', 'Summe Ausgaben', 'ausgaben'], ['', 'Gewinn', 'gewinn']]
  dateien.push({ name: 'euer.csv', inhalt: csv(kopf('euer.csv'), euer ? kz.map(([k, l, f]) => [k, l, Number(euer[f]) || 0]) : []) })
  if (!euer) fehler.push(`Keine EÜR-Zahlen für ${jahr} vorhanden.`)
  const { persoenlich, ...nurFirma } = firma // persönliche Angaben nie ins Jahresarchiv (P-4)
  dateien.push({ name: 'angaben.json', inhalt: Buffer.from(JSON.stringify(nurFirma, null, 2), 'utf8') })
  const kette = alle.filter((e) => String(e.jahr) === jahr)
  dateien.push({ name: `protokoll/index-${jahr}.jsonl`, inhalt: Buffer.from(kette.map((e) => JSON.stringify(e)).join('\n') + (kette.length ? '\n' : ''), 'utf8') })
  // Die vollständige Kette (nur Metadaten) macht Auszug und Siegel nachprüfbar: jede Zeile verweist auf ihren Vorgänger
  dateien.push({ name: 'protokoll/kette-gesamt.jsonl', inhalt: Buffer.from(alle.map((e) => JSON.stringify(e)).join('\n') + (alle.length ? '\n' : ''), 'utf8') })
  const pruefwert = alle.at(-1)?.hash || ''
  dateien.push({ name: 'protokoll/pruefwert.txt', inhalt: Buffer.from(`Prüfwert (Kopf der Hash-Kette, ${alle.length} Einträge) beim Export ${jetzt}:\r\n${pruefwert}\r\n`, 'utf8') })
  // Zusatz (haupt.js): Verfahrensdokumentation und Jahresnachweis, die Befunde und Prüfwert des Exports kennen müssen
  if (zusatz) for (const z of zusatz({ fehler, pruefwert, arten: anzahlJeArt(imJahr.filter((e) => String(e.jahr) === jahr)) })) dateien.push(z)
  dateien.unshift({ name: 'LIESMICH.txt', inhalt: liesmich({ jahr, firma: nurFirma, jetzt, version, anzahl: dateien.length + 2 + (fehler.length ? 1 : 0), pruefwert }) })
  if (fehler.length) dateien.push({ name: 'FEHLER.txt', inhalt: Buffer.from(fehler.join('\r\n') + '\r\n', 'utf8') })
  dateien.push({ name: 'pruefsummen.sha256', inhalt: Buffer.from(dateien.map((d) => `${sha(d.inhalt)}  ${d.name}`).join('\n') + '\n', 'utf8') })
  return { dateien, fehler, pruefwert }
}

// ZIP Datei für Datei schreiben (fflate, Stream); Rückgabe: Größe und SHA-256 des ZIP
function schreiben(dateien, ziel) {
  const { Zip, ZipDeflate, ZipPassThrough } = require('fflate')
  fs.mkdirSync(path.dirname(ziel), { recursive: true })
  const temp = `${ziel}.teil`
  return new Promise((aufloesen, ablehnen) => {
    const aus = fs.createWriteStream(temp)
    const hash = crypto.createHash('sha256')
    let bytes = 0
    aus.on('error', ablehnen)
    const zip = new Zip((fehler, stueck, fertig) => {
      if (fehler) { aus.destroy(); return ablehnen(fehler) }
      hash.update(stueck); bytes += stueck.length; aus.write(stueck)
      if (fertig) aus.end(() => { try { fs.renameSync(temp, ziel); aufloesen({ datei: ziel, bytes, sha256: hash.digest('hex') }) } catch (f) { ablehnen(f) } })
    })
    for (const d of dateien) {
      const eintrag = GEPACKT.test(d.name) ? new ZipDeflate(d.name, { level: 6 }) : new ZipPassThrough(d.name)
      zip.add(eintrag)
      eintrag.push(new Uint8Array(d.inhalt.buffer, d.inhalt.byteOffset, d.inhalt.length), true)
    }
    zip.end()
  })
}

const anzahlJeArt = (eintraege) => eintraege.reduce((m, e) => ({ ...m, [e.art]: (m[e.art] || 0) + 1 }), {})
const jahre = (archiv) => [...new Set(archiv.eintraege().filter((e) => ORDNER[e.art]).map((e) => String(e.jahr)))].sort().reverse()

module.exports = { zusammenstellen, schreiben, jahre, csv, anzahlJeArt, ORDNER, TABELLEN }
