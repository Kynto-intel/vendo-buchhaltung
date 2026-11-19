'use strict'
// Persönliche Angaben und ELSTER-Zuordnung (plugins/buchhaltung/persoenlich.js, Plan 11.3 M.2/M.5). Nur erfundene Werte;
// die Steuer-IDs sind die bekannten Musternummern aus öffentlichen Beispielen.
//   node --test tests/buchhaltung-persoenlich.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const p = require('../persoenlich.js')

test('Steuer-ID: Prüfziffer, Länge, erste Ziffer, Ziffernhäufigkeit', () => {
  assert.equal(p.steuerIdGueltig('86095742719'), true)
  assert.equal(p.steuerIdGueltig('47036892816'), true)
  assert.equal(p.steuerIdGueltig('86095742710'), false) // falsche Prüfziffer
  assert.equal(p.steuerIdGueltig('06095742719'), false) // erste Ziffer 0
  assert.equal(p.steuerIdGueltig('8609574271'), false) // zu kurz
  assert.equal(p.steuerIdGueltig('12345678901'), false) // keine Ziffer doppelt
  assert.equal(p.steuerIdGueltig('11123456789'), false) // dreimal direkt hintereinander
})

test('normalisieren: Leerzeichen und Trenner in der Steuer-ID, unbekannte Felder und Auswahlwerte fallen weg', () => {
  const w = p.normalisieren({ steuerId: '86 095 742 719', vorname: '  Erika  ', anrede: 'Frau', veranlagung: 'xyz', fremd: 'weg' })
  assert.equal(w.steuerId, '86095742719')
  assert.equal(w.vorname, 'Erika')
  assert.equal(w.anrede, 'Frau')
  assert.equal(w.veranlagung, '')
  assert.equal('fremd' in w, false)
  assert.deepEqual(Object.keys(w), p.FELDER.map((f) => f.feld))
})

test('pruefen: ungültige Steuer-IDs und Daten, Zusammenveranlagung braucht den Ehegatten', () => {
  assert.equal(p.pruefen(p.normalisieren({})).ok, true)
  const f = p.pruefen(p.normalisieren({ steuerId: '1', ehegatteSteuerId: '2', geburtsdatum: '31.12.1980', veranlagung: 'zusammen' })).fehler.map((x) => x.feld)
  assert.deepEqual(f.sort(), ['ehegatteSteuerId', 'ehegatteVorname', 'geburtsdatum', 'steuerId'])
})

test('elster: Anlage nach Einkunftsart, nur Kennzahlen mit Betrag, Ehegatte nur wenn vorhanden', () => {
  const euer = { jahr: '2025', kz111: 1500, kz112: 0, kz140: 0, kz100: 900, sonstige: 20, kz186: 0, gewinn: 580 }
  const u = p.elster({ person: { vorname: 'Erika', nachname: 'Muster', veranlagung: 'zusammen', ehegatteVorname: 'Max', ehegatteNachname: 'Muster' }, firma: { einkunftsart: 'gewerbe', steuernummer: '12/345/67890' }, euer, jahr: '2025' })
  assert.equal(u.gewinn.anlage, 'Anlage G')
  assert.equal(u.gewinn.wert, 580)
  assert.deepEqual(u.euer.map((z) => z.kz), ['Kz 111', 'Kz 100', '–'])
  assert.ok(u.hauptvordruck.some((z) => z.label === 'Ehegatte: Name' && z.wert === 'Max Muster'))
  assert.equal(p.elster({ firma: { einkunftsart: 'selbstaendig' } }).gewinn.anlage, 'Anlage S')
  assert.equal(p.elster({}).gewinn.wert, null)
})
