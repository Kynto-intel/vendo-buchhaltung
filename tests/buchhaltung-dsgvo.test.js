'use strict'
// Datenschutz (dsgvo.js, Schritt 7.3): Suche, Sperrfrist, Auskunft, Verzeichnis – erfundene Personen und Bestellungen.
//   node --test tests/buchhaltung-dsgvo.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { unzipSync, strFromU8 } = require('fflate')
const { archiv } = require('../archiv.js')
const ds = require('../dsgvo.js')
const ja = require('../jahresarchiv.js')

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const bestellung = (nr, datum, name, email) => ({ id: `s${nr}`, beleg: { version: 1 }, rechnung: { referenz: nr, datum, empfaenger: { name, email, strasse: 'Erfundener Weg 1', plz: '12345', ort: 'Musterstadt', land: 'DE' }, positionen: [{ typ: 'artikel', bezeichnung: 'Synthetik-Shirt', farbe: 'Schwarz', groesse: 'M', menge: 1, gesamt: 25 }], summen: { brutto: 25, mwst: 0, netto: 25 }, zahlung: { art: 'paypal', datum, bezahlt: true } } })
const shop = [bestellung('1001', '2024-05-02', 'Erika Synthetisch', 'erika@example.test'), bestellung('1002', '2025-02-10', 'Erika Synthetisch', 'Erika@Example.test'), bestellung('1003', '2025-03-01', 'Max Erfunden', 'max@example.test')]

function aufbauen(t) {
  const wurzel = fs.mkdtempSync(path.join(os.tmpdir(), 'vendo-dsgvo-'))
  t.after(() => fs.rmSync(wurzel, { recursive: true, force: true }))
  const a = archiv(path.join(wurzel, 'archiv'))
  for (const b of shop) {
    const nr = b.rechnung.referenz
    const jahr = Number(b.rechnung.datum.slice(0, 4))
    a.ablegen(Buffer.from(JSON.stringify({ bestellung: nr, kunde: b.rechnung.empfaenger.name })), { art: 'shopify-original', jahr, name: `Shopify Bestellung ${nr} v1.json`, meta: { bestellung: nr, version: 1 } })
    a.ablegen(Buffer.from(`%PDF-1.4 Beleg ${nr}`), { art: 'umsatzbeleg', jahr, name: `Umsatzbeleg ${nr}.pdf`, meta: { bestellung: nr, version: 1 } })
  }
  return { wurzel, a }
}

test('suchen: E-Mail genau (ohne Groß/klein), Name als Teil, mindestens 3 Zeichen', () => {
  assert.deepEqual(ds.suchen(shop, ' ERIKA@example.test ').map((x) => x.nr), ['1001', '1002'])
  assert.deepEqual(ds.suchen(shop, 'erfund').map((x) => x.nr), ['1003'])
  assert.deepEqual(ds.suchen(shop, 'rika@example.test'), [], 'E-Mail nur genau')
  assert.throws(() => ds.suchen(shop, 'ab'), /mindestens 3 Zeichen/)
  assert.deepEqual(Object.keys(ds.suchen(shop, 'max@example.test')[0]).sort(), ['datum', 'email', 'name', 'nr', 'ort'])
})

test('gesperrtBis: Ende des Entstehungsjahres des jüngsten Belegs plus 8 Jahre', (t) => {
  const { a } = aufbauen(t)
  const jetzt = new Date().getFullYear() // Ablagezeit im Archiv = heute
  assert.equal(ds.gesperrtBis({ archiv: a, shop, nrs: ['1001'] }), `${jetzt + 8}-12-31`)
  assert.equal(ds.gesperrtBis({ archiv: { eintraege: () => [] }, shop, nrs: ['1001'] }), '2032-12-31', 'ohne Archiv: Bestelljahr')
  assert.equal(ds.gesperrtBis({ archiv: { eintraege: () => [] }, shop, nrs: ['1001', '1002'] }), '2033-12-31', 'jüngste Bestellung zählt')
  assert.equal(ds.gesperrtBis({ archiv: { eintraege: () => [] }, shop, nrs: ['999'] }), null)
})

test('auskunft: nur die Bestellungen der Person, Kopien byte-genau, lesbare Auskunft mit Rechten und Frist', async (t) => {
  const { wurzel, a } = aufbauen(t)
  const shirtigo = [{ id: 't77', rechnung: { referenz: '1002' } }]
  const erg = ds.auskunft({ archiv: a, shop, shirtigo, nrs: ['1001', '1002'], firma: { firmenname: 'Synthetik-Shop', inhaber: 'Inhaberin', strasse: 'Teststraße 1', plz: '12345', ort: 'Musterstadt', iban: 'DE00GEHEIM' }, jetzt: '2026-11-20T10:00:00Z' })
  const namen = erg.dateien.map((d) => d.name)
  assert.deepEqual(namen.slice(0, 2), ['auskunft.md', 'daten.json'])
  assert.equal(namen.filter((n) => n.startsWith('belege/')).length, 2)
  assert.equal(namen.filter((n) => n.startsWith('originale/')).length, 2)
  assert.ok(!namen.some((n) => n.includes('1003')), 'fremde Bestellung nicht dabei')
  assert.deepEqual(erg.fehler, [])
  assert.equal(erg.name, 'Erika Synthetisch')
  for (const e of a.eintraege().filter((x) => ['1001', '1002'].includes(x.meta.bestellung))) {
    const d = erg.dateien.find((x) => x.name.endsWith(e.datei.split('/').pop()))
    assert.equal(sha(d.inhalt), e.sha256, e.datei)
  }
  const daten = JSON.parse(erg.dateien[1].inhalt)
  assert.deepEqual(daten.map((x) => x.bestellung), ['1001', '1002'])
  assert.deepEqual(daten[1].weitergabeShirtigo, ['77'])
  assert.equal(daten[0].positionen[0].groesse, 'M')
  const text = erg.dateien[0].inhalt.toString()
  assert.match(text, /Art\. 15 DSGVO/)
  assert.match(text, /Synthetik-Shop, Inhaberin, Teststraße 1, 12345 Musterstadt/)
  assert.match(text, /Shirtigo/)
  assert.match(text, /Keine Weitergabe an KI-Dienste/)
  assert.match(text, /bis 31\.12\.\d{4}/)
  assert.ok(!text.includes('DE00GEHEIM'))
  assert.ok(!text.includes('Max Erfunden'))
  const z = await ja.schreiben(erg.dateien, path.join(wurzel, 'aus', 'Auskunft.zip'))
  assert.equal(Object.keys(unzipSync(new Uint8Array(fs.readFileSync(z.datei)))).length, erg.dateien.length)
  assert.throws(() => ds.auskunft({ archiv: a, shop, nrs: ['999'] }), /Keine passenden/)
})

test('auskunft: verfälschte Datei wird nicht herausgegeben, sondern gemeldet', (t) => {
  const { a } = aufbauen(t)
  const e = a.eintraege().find((x) => x.art === 'umsatzbeleg' && x.meta.bestellung === '1003')
  const p = a.pfad(e)
  fs.chmodSync(p, 0o666)
  fs.writeFileSync(p, 'verändert')
  const erg = ds.auskunft({ archiv: a, shop, nrs: ['1003'] })
  assert.equal(erg.fehler.length, 1)
  assert.match(strFromU8(erg.dateien.at(-1).inhalt), /passt nicht zur Prüfsumme/)
  assert.ok(!erg.dateien.some((d) => d.name.startsWith('belege/')))
})

test('verzeichnis: Tätigkeiten aus dem Aufbau, Zahlungsarten, Fehlendes markiert, Grundsatz KI', () => {
  const mit = ds.verzeichnis({ firma: { firmenname: 'Synthetik-Shop', inhaber: 'Inhaberin' }, zahlungsarten: ['paypal', 'shopify_payments'], shirtigo: true, jetzt: '2026-11-20T10:00:00Z' })
  assert.match(mit, /Art\. 30 Abs\. 1 DSGVO\) – Entwurf/)
  assert.match(mit, /Zahlungsanbieter: paypal, shopify_payments/)
  assert.match(mit, /## 2\. Herstellung und Versand/)
  assert.match(mit, /## 4\. Datensicherung/)
  assert.match(mit, /\*\*Fehlt: Anschrift\*\*/)
  assert.match(mit, /Keine Weitergabe an Hermes oder KI-Anbieter/)
  const ohne = ds.verzeichnis({ firma: {}, shirtigo: false })
  assert.ok(!ohne.includes('Herstellung und Versand'))
  assert.match(ohne, /## 2\. Buchführung und Belegarchiv/)
})
