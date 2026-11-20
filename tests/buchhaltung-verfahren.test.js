'use strict'
// Verfahrensdokumentation und Jahresnachweis (verfahren.js, Schritt 7.2 / E.4) mit erfundenem Stand.
//   node --test tests/buchhaltung-verfahren.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const v = require('../verfahren.js')
const ja = require('../jahresarchiv.js')
const { archiv } = require('../archiv.js')

const stand = {
  jetzt: '2026-11-20T09:30:00Z', umgebung: 'vendo', windows: true,
  firma: { firmenname: 'Synthetik-Shop', inhaber: 'Erika Synthetisch', strasse: 'Teststraße 1', plz: '12345', ort: 'Musterstadt', land: 'DE', rechtsform: 'einzelunternehmen', taetigkeit: 'Online-Handel mit Textilien', steuernummer: '12/345/67890', finanzamt: 'Musterstadt', versteuerung: 'ist', kontenrahmen: 'SKR03', steuerzeitraeume: [{ von: '', bis: '2024-03-31', art: 'klein' }, { von: '2024-04-01', bis: '2024-05-31', art: 'regel', satz: 19 }, { von: '2024-06-01', bis: '', art: 'klein' }], persoenlich: 'GEHEIM-PERSOENLICH', iban: 'DE00SYNTHETISCH' },
  versionen: { plugin: '1.0.0', parser: 'p9', node: '24.0.0', electron: '40.0.0' },
  archiv: { pfad: '%USERPROFILE%\\Documents\\Vendo-Archiv', eintraege: 12, erster: '2024-04-02T10:00:00Z', arten: { umsatzbeleg: 5, 'shopify-original': 5, siegel: 2 } },
  wartung: { zeit: '2026-11-18T08:00:00Z', ok: true, archiv: { ok: true, geprueft: 12, anzahlFehler: 0 }, siegel: { ok: true, anzahl: 2, zuletzt: '2026-11-18T07:00:00Z', nochNichtVersiegelt: 3 } },
  usb: { letzteSicherung: '2026-11-17T20:00:00Z', laufwerk: 'SYNTH-STICK', schluesselBestaetigt: true, wiederherstellungstest: { zeit: '2026-11-01T12:00:00Z', ok: true } },
  datenbank: { zustand: 'verbunden' },
  quellen: { shopify: { eingerichtet: true, quelle: 'hermes' }, shirtigo: true, belege: 4 },
  dienste: ['Sectigo Qualified (eIDAS)', 'FreeTSA'], pruefwert: 'a'.repeat(64)
}
const voll = { verantwortlich: 'Inhaberin', vertretung: 'keine', steuerberatung: 'keine', rechner: 'Windows-PC zu Hause', zugriff: 'nur Inhaberin', papier: 'keine Papierbelege', stickOrt: 'Schublade', schluesselOrt: 'Ordner Steuer' }

test('Verfahrensdokumentation: Aufbau nach AWV-Muster, echte Werte, Fehlendes markiert, keine Geheimnisse', () => {
  const text = v.verfahrensdokumentation({ stand, ergaenzungen: {} })
  for (const k of ['## 1. Allgemeine Beschreibung', '## 2. Anwenderdokumentation', '## 3. Technische Systemdokumentation', '## 4. Betriebsdokumentation', '## 5. Internes Kontrollsystem', '## 6. Datenzugriff', '## 7. Aufbewahrung']) assert.ok(text.includes(k), k)
  assert.match(text, /Synthetik-Shop/)
  assert.match(text, /12\/345\/67890/)
  assert.match(text, /- seit Beginn bis 31\.03\.2024: Kleinunternehmer \(§ 19 UStG\)\n- 01\.04\.2024 bis 31\.05\.2024: Regelbesteuerung \(19 %\)\n- 01\.06\.2024 bis heute: Kleinunternehmer/)
  assert.match(text, /12 Einträge, erster vom 02\.04\.2024/)
  assert.match(text, /Bisher 2 Siegel.*3 Einträge noch unversiegelt/)
  assert.match(text, /Letzte Sicherung: 17\.11\.2026.*\(SYNTH-STICK\)/)
  assert.match(text, /nicht an Hermes/)
  assert.match(text, /Zustand: \*\*unvollständig\*\* – 8 Angabe\(n\) fehlen/)
  assert.match(text, /\*\*Fehlt: Verantwortliche Person\*\*/)
  assert.match(text, /Noch nicht durchgesehen und bestätigt/)
  for (const geheim of ['GEHEIM-PERSOENLICH', 'DE00SYNTHETISCH']) assert.ok(!text.includes(geheim), geheim)
  assert.ok(!/Ergänzungen\n/.test(text.split('## 7.')[1]), 'ohne „sonstiges“ kein Abschnitt 8')
})

test('Ergänzungen: vollständig, Bestätigung gilt nur bis zur nächsten Änderung, Längenprüfung', () => {
  const hash = v.ergaenzungenHash(voll)
  const text = v.verfahrensdokumentation({ stand, ergaenzungen: { ...voll, sonstiges: 'Synthetische Ergänzung' }, bestaetigung: { zeit: '2026-11-19T10:00:00Z', hash: v.ergaenzungenHash({ ...voll, sonstiges: 'Synthetische Ergänzung' }) } })
  assert.match(text, /Zustand: vollständig ausgefüllt/)
  assert.match(text, /Durchgesehen und bestätigt am 19\.11\.2026/)
  assert.match(text, /## 8\. Ergänzungen\n\nSynthetische Ergänzung/)
  assert.ok(!text.includes('Fehlt:'), 'nichts fehlt')
  const geaendert = v.verfahrensdokumentation({ stand, ergaenzungen: { ...voll, zugriff: 'zwei Personen' }, bestaetigung: { zeit: '2026-11-19T10:00:00Z', hash } })
  assert.match(geaendert, /Seit der letzten Bestätigung geändert/)
  assert.deepEqual(v.fehlend(voll), [])
  assert.equal(v.ergaenzungenHash({ ...voll, unbekannt: 'x' }), hash, 'fremde Felder zählen nicht')
  assert.throws(() => v.ergaenzungenNormalisieren({ papier: 'x'.repeat(2001) }), /Zu lang/)
})

test('Z3: Tabellenbeschreibung passt Spalte für Spalte zu den CSV-Kopfzeilen des Jahresarchivs', (t) => {
  const wurzel = fs.mkdtempSync(path.join(os.tmpdir(), 'vendo-verfahren-'))
  t.after(() => fs.rmSync(wurzel, { recursive: true, force: true }))
  const a = archiv(path.join(wurzel, 'archiv'))
  a.ablegen(Buffer.from('%PDF-1.4 erfunden'), { art: 'umsatzbeleg', jahr: 2025, name: 'Umsatzbeleg 1.pdf', meta: { bestellung: '1', version: 1 } })
  const erg = ja.zusammenstellen({ jahr: 2025, archiv: a, euer: { kz111: 1 } })
  const text = v.verfahrensdokumentation({ stand })
  for (const [datei, spalten] of Object.entries(ja.TABELLEN)) {
    const kopf = erg.dateien.find((d) => d.name === datei).inhalt.toString('utf8').replace(/^﻿/, '').split('\r\n')[0]
    assert.equal(kopf, spalten.map(([n]) => (/[;"]/.test(n) ? `"${n}"` : n)).join(';'), datei)
    assert.ok(text.includes(`**${datei}**`), `${datei} beschrieben`)
    for (const [n, typ] of spalten) assert.ok(text.includes(`| ${n} | ${typ} |`), `${datei}: ${n}`)
  }
  assert.match(text, /index\.xml .* nicht beigelegt/)
})

test('Jahresnachweis: Belege je Art, Zahlen, Integrität, Siegel, Sicherung, Befunde', () => {
  const ok = v.jahresnachweis({ jahr: '2025', stand, arten: { umsatzbeleg: 3, eingang: 2 }, euer: { einnahmen: 100, ausgaben: 40.5, gewinn: 59.5 }, fehler: [], pruefwert: 'b'.repeat(64) })
  assert.match(ok, /^# Jahresnachweis 2025 – Synthetik-Shop/)
  assert.match(ok, /Umsatzbelege \(PDF\): 3/)
  assert.match(ok, /Eingangsrechnungen \(PDF, XML\): 2/)
  assert.match(ok, /Ausgaben: 40,50 €/)
  assert.match(ok, /Hash-Kette und Dateien ohne Befund/)
  assert.match(ok, /alle passend/)
  assert.ok(ok.includes('b'.repeat(64)))
  const schlecht = v.jahresnachweis({ jahr: '2025', stand: { ...stand, wartung: null, usb: {} }, fehler: ['x'] })
  assert.match(schlecht, /Letzte vollständige Prüfung: \*\*noch keine\*\*/)
  assert.match(schlecht, /1 Befund\(e\), siehe FEHLER\.txt/)
  assert.match(schlecht, /Keine EÜR-Zahlen/)
})

test('Jahresarchiv mit Zusatz: Verfahrensdokumentation und Jahresnachweis im ZIP und in den Prüfsummen', (t) => {
  const wurzel = fs.mkdtempSync(path.join(os.tmpdir(), 'vendo-verfahren-'))
  t.after(() => fs.rmSync(wurzel, { recursive: true, force: true }))
  const a = archiv(path.join(wurzel, 'archiv'))
  a.ablegen(Buffer.from('%PDF-1.4 erfunden'), { art: 'umsatzbeleg', jahr: 2025, name: 'Umsatzbeleg 1.pdf', meta: { bestellung: '1', version: 1 } })
  a.ablegen(Buffer.from('%PDF-1.4 anderes'), { art: 'umsatzbeleg', jahr: 2024, name: 'Umsatzbeleg 0.pdf', meta: { bestellung: '0', version: 1 } })
  let gesehen = null
  const erg = ja.zusammenstellen({ jahr: 2025, archiv: a, euer: null, zusatz: (x) => { gesehen = x; return [{ name: 'verfahrensdokumentation.md', inhalt: Buffer.from('VD') }, { name: 'jahresnachweis.md', inhalt: Buffer.from('JN') }] } })
  assert.deepEqual(gesehen.arten, { umsatzbeleg: 1 }, 'nur Dateien des Jahres gezählt')
  assert.deepEqual(gesehen.fehler, ['Keine EÜR-Zahlen für 2025 vorhanden.'])
  assert.match(gesehen.pruefwert, /^[a-f0-9]{64}$/)
  const summen = erg.dateien.at(-1).inhalt.toString()
  assert.match(summen, /  verfahrensdokumentation\.md\n/)
  assert.match(summen, /  jahresnachweis\.md\n/)
  assert.match(erg.dateien[0].inhalt.toString(), /verfahrensdokumentation\.md/)
})

test('Regel-Check (Schritt 8.5) in Jahresnachweis und Verfahrensdokumentation', () => {
  const mit = { ...stand, regelcheck: { 2025: '2025-01-15', 2026: '2026-01-20' } }
  assert.match(v.jahresnachweis({ jahr: '2026', stand: mit }), /## Jährlicher Regel-Check\n\n- durchgeführt am 20\.01\.2026/)
  assert.match(v.jahresnachweis({ jahr: '2024', stand: mit }), /\*\*für dieses Jahr nicht protokolliert\*\*/)
  assert.match(v.verfahrensdokumentation({ stand: mit }), /Jährlicher Regel-Check \(Januar\).*Zuletzt: 2026 am 20\.01\.2026\./)
  assert.match(v.verfahrensdokumentation({ stand }), /Noch keiner protokolliert/)
})
