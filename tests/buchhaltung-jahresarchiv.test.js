'use strict'
// Jahresarchiv als ZIP (plugins/buchhaltung/jahresarchiv.js, Plan 11.4 E.1) mit einem erfundenen Belegarchiv im Temp-Ordner.
//   node --test tests/buchhaltung-jahresarchiv.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { unzipSync, strFromU8 } = require('fflate')
const { archiv } = require('../archiv.js')
const ja = require('../jahresarchiv.js')

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
function aufbauen(t) {
  const wurzel = fs.mkdtempSync(path.join(os.tmpdir(), 'vendo-jahresarchiv-'))
  t.after(() => { for (const d of fs.readdirSync(wurzel, { recursive: true })) try { fs.chmodSync(path.join(wurzel, d), 0o666) } catch {} fs.rmSync(wurzel, { recursive: true, force: true }) })
  const a = archiv(path.join(wurzel, 'archiv'))
  const pdf = Buffer.from('%PDF-1.4 erfunden 1001')
  const beleg = a.ablegen(pdf, { art: 'umsatzbeleg', jahr: 2025, name: 'Umsatzbeleg Bestellung 1001.pdf', meta: { bestellung: '1001', version: 1 } })
  const orig = a.ablegen(Buffer.from(JSON.stringify({ bestellung: { name: '#1001', shippingAddress: { name: 'Erika Muster' } } })), { art: 'shopify-original', jahr: 2025, name: 'Shopify Bestellung 1001 v1.json', meta: { bestellung: '1001', version: 1 } })
  a.ablegen(Buffer.from('%PDF-1.4 Rechnung R-1'), { art: 'eingang', jahr: 2025, name: 'Rechnung R-1.pdf', meta: { shirtigo: 55 } })
  a.ablegen(Buffer.from('%PDF-1.4 anderes Jahr'), { art: 'umsatzbeleg', jahr: 2024, name: 'Umsatzbeleg Bestellung 900.pdf', meta: { bestellung: '900', version: 1 } })
  return { wurzel, a, beleg, orig }
}
const shop = [{ id: 's1001', beleg: { version: 1, pdf: 'x/Umsatzbeleg Bestellung 1001__abc.pdf', sha256: 'abc' }, rechnung: { referenz: '1001', datum: '2025-03-05', storniert: false, kleinunternehmer: true, wirksam: 29.9, summen: { brutto: 29.9, mwst: 0, netto: 29.9, mwstSatz: 0 }, zahlung: { art: 'paypal; "Test"', bezahlt: true, datum: '2025-03-06', eingaenge: [{ datum: '2025-03-06', betrag: 29.9, gateway: 'paypal' }], erstattungen: [] } } }]
const euer = { jahr: '2025', kz111: 29.9, kz112: 0, kz140: 0, kz100: 12.5, sonstige: 0, kz186: 0, einnahmen: 29.9, ausgaben: 12.5, gewinn: 17.4 }

test('zusammenstellen: Belege des Jahres byte-genau, CSV-Format, Prüfsummen, keine persönlichen Angaben', (t) => {
  const { a } = aufbauen(t)
  const erg = ja.zusammenstellen({ jahr: 2025, archiv: a, shop, euer, firma: { firmenname: 'Synthetik-Shop', persoenlich: 'GEHEIM' }, version: '1.0.0', jetzt: '2026-01-02T10:00:00Z' })
  const namen = erg.dateien.map((d) => d.name)
  assert.deepEqual(erg.fehler, [])
  assert.equal(namen[0], 'LIESMICH.txt')
  assert.equal(namen.at(-1), 'pruefsummen.sha256')
  assert.ok(namen.some((n) => n.startsWith('umsatzbelege/Umsatzbeleg Bestellung 1001')))
  assert.ok(namen.some((n) => n.startsWith('originale/shopify/')))
  assert.ok(namen.some((n) => n.startsWith('eingang/Rechnung R-1')))
  assert.ok(!namen.some((n) => n.includes('900')), 'anderes Jahr nicht dabei')
  const datei = (n) => erg.dateien.find((d) => d.name === n).inhalt
  const csv = datei('bestellungen.csv').toString('utf8')
  assert.ok(csv.startsWith('\uFEFFBestellnummer;'), 'BOM und Semikolon')
  assert.ok(csv.includes('\r\n1001;1;2025-03-05;2025-03-06;nein;ja;29,90;0,00;29,90;29,90;0,00;ja;"paypal; ""Test""";'), 'Dezimalkomma, ja/nein, RFC 4180')
  assert.match(datei('euer.csv').toString('utf8'), /111;Betriebseinnahmen als Kleinunternehmer;29,90\r\n/)
  assert.match(datei('euer.csv').toString('utf8'), /;Gewinn;17,40\r\n/)
  assert.deepEqual(JSON.parse(datei('angaben.json')), { firmenname: 'Synthetik-Shop' })
  assert.equal(datei('protokoll/index-2025.jsonl').toString().trim().split('\n').length, 3)
  assert.match(datei('protokoll/pruefwert.txt').toString(), /[a-f0-9]{64}/)
  for (const z of datei('pruefsummen.sha256').toString().trim().split('\n')) {
    const [hash, n] = z.split('  ')
    assert.equal(sha(datei(n)), hash, n)
  }
})

test('verfälschte oder fehlende Archivdatei: kommt nicht ins ZIP, steht in FEHLER.txt, Export bricht nicht ab', (t) => {
  const { a, beleg } = aufbauen(t)
  const p = a.pfad(beleg)
  fs.chmodSync(p, 0o666)
  fs.writeFileSync(p, 'verfälscht')
  const erg = ja.zusammenstellen({ jahr: 2025, archiv: a, shop, euer: null, firma: {} })
  assert.equal(erg.fehler.length, 2) // verfälschte Datei + keine EÜR
  assert.ok(!erg.dateien.some((d) => d.name.startsWith('umsatzbelege/')))
  assert.match(erg.dateien.find((d) => d.name === 'FEHLER.txt').inhalt.toString(), /passt nicht zur Prüfsumme/)
})

test('schreiben: ZIP lässt sich entpacken, Inhalt identisch, Prüfsumme des ZIP stimmt', async (t) => {
  const { wurzel, a } = aufbauen(t)
  const erg = ja.zusammenstellen({ jahr: 2025, archiv: a, shop, euer, firma: { firmenname: 'Synthetik-Shop' } })
  const ziel = path.join(wurzel, 'aus', 'Buchhaltung-2025.zip')
  const z = await ja.schreiben(erg.dateien, ziel)
  const roh = fs.readFileSync(ziel)
  assert.equal(z.sha256, sha(roh))
  assert.equal(z.bytes, roh.length)
  assert.equal(fs.existsSync(`${ziel}.teil`), false)
  const entpackt = unzipSync(new Uint8Array(roh))
  assert.deepEqual(Object.keys(entpackt).sort(), erg.dateien.map((d) => d.name).sort())
  for (const d of erg.dateien) assert.equal(sha(Buffer.from(entpackt[d.name])), sha(d.inhalt), d.name)
  assert.match(strFromU8(entpackt['LIESMICH.txt']), /Jahresarchiv 2025 – Synthetik-Shop/)
})

test('jahre: nur Jahre mit exportierbaren Einträgen, neueste zuerst', (t) => {
  const { a } = aufbauen(t)
  assert.deepEqual(ja.jahre(a), ['2025', '2024'])
})

test('Siegel aus späteren Jahren und die vollständige Kette kommen mit, damit Auszug und Siegel nachprüfbar sind', (t) => {
  const { a } = aufbauen(t)
  a.ablegen(Buffer.from('{"siegel":"synthetisch"}'), { art: 'siegel', jahr: 2026, name: 'Archivsiegel 2026.json', meta: { quelle: 'zeitstempel' } })
  a.ablegen(Buffer.from('TSR synthetisch'), { art: 'zeitstempel', jahr: 2026, name: 'Zeitstempel test 2026.tsr', meta: { quelle: 'zeitstempel' } })
  const erg = ja.zusammenstellen({ jahr: 2025, archiv: a, shop, euer, firma: { firmenname: 'Synthetik-Shop' }, version: '1.0.0', jetzt: '2026-01-02T10:00:00Z' })
  const namen = erg.dateien.map((d) => d.name)
  assert.ok(namen.some((n) => n.startsWith('protokoll/siegel/Archivsiegel 2026')), namen.join(', '))
  assert.ok(namen.some((n) => n.startsWith('protokoll/zeitstempel/Zeitstempel test 2026')))
  assert.ok(!namen.some((n) => n.includes('Bestellung 900')), 'Belege anderer Jahre bleiben draußen')
  const kette = erg.dateien.find((d) => d.name === 'protokoll/kette-gesamt.jsonl').inhalt.toString().trim().split('\n').map(JSON.parse)
  assert.equal(kette.length, a.eintraege().length)
  for (let i = 1; i < kette.length; i++) assert.equal(kette[i].vorher, kette[i - 1].hash, 'Kette lückenlos')
})
