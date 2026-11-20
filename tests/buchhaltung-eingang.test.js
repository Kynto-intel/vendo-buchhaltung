import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// Durchgehender Test für den PDF-Eingang (haupt.js: hinzufuegen, scannen, liste, ausblenden), Plan-Schritt 1.6 (B14).
// Echtes archiv.js, echtes pdfjs, echter Parser – alles in einem frischen Temp-Ordner (Vendo-Ordner, Home, Archiv).
// Stubs: OCR, Electron, Shopify-/Shirtigo-Module, Windows-Schutz. Synthetische PDF, kein Netz, keine echten Daten.

const require = createRequire(import.meta.url)
const pluginFolder = path.resolve('.')
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex')

// Kleinste gültige PDF mit Textebene (Helvetica, WinAnsi; € = \200)
function minimalPdf(text) {
  const zeilen = text.split('\n').map((z) => `(${z.replace(/[()\\]/g, '\\$&').replace(/€/g, '\\200')}) '`)
  const inhalt = `BT /F1 11 Tf 50 800 Td 14 TL ${zeilen.join(' ')} ET`
  const objekte = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(inhalt, 'latin1')} >>\nstream\n${inhalt}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  ]
  let pdf = '%PDF-1.4\n'
  const versatz = objekte.map((o, i) => { const v = Buffer.byteLength(pdf, 'latin1'); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return v })
  const xref = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objekte.length + 1}\n0000000000 65535 f \n${versatz.map((v) => `${String(v).padStart(10, '0')} 00000 n \n`).join('')}`
  pdf += `trailer\n<< /Size ${objekte.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}
const RECHNUNG = 'Synthetische Lieferant GmbH\nRechnungsnummer: TEST-EINGANG-1\n04.10.2026\nArtikel 1 10,00 € 10,00 €\nNetto: 10,00 €\nMwSt. 1,90 €\nRechnungsbetrag: 11,90 €'

function starten(t) {
  const basis = fs.mkdtempSync(path.join(os.tmpdir(), 'vendo-eingang-test-'))
  t.after(() => {
    const alle = (o) => fs.existsSync(o) ? fs.readdirSync(o, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? alle(path.join(o, d.name)) : [path.join(o, d.name)]) : []
    for (const d of alle(basis)) fs.chmodSync(d, 0o666)
    fs.rmSync(basis, { recursive: true, force: true })
  })
  const vendo = path.join(basis, 'Vendo')
  const plugin = path.join(vendo, 'plugins', 'buchhaltung') // nur als __dirname: daten/buchhaltung liegt dann in <basis>/Vendo/daten
  const home = path.join(basis, 'home')
  const schutzAufrufe = []
  const leer = { einrichten() {}, eintraege: () => [], beschaeftigt: () => false, WURZEL: path.join(home, 'Documents', 'Arbeit', 'Rechnungen') }
  const abh = new Map([
    ['node:fs', fs], ['node:path', path], ['node:crypto', require('node:crypto')], ['node:os', { homedir: () => home }],
    ['@napi-rs/canvas', { createCanvas() { throw new Error('OCR darf im Test nicht starten') } }],
    ['tesseract.js', { createWorker() { throw new Error('OCR darf im Test nicht starten') } }],
    ['@tesseract.js-data/deu', { langPath: 'synthetisch' }],
    ['./parser', require('../parser.js')], ['./profil', require('../profil.js')], ['./textlayer', require('../textlayer.js')],
    ['./bestellungen', { ...leer, gebuehrenEintraege: () => [] }], ['./shirtigo', { einrichten() {}, verbunden: () => false }], ['./host', require('../host.js')], ['./shirtigo-bestellungen', leer],
    ['./archiv', require('../archiv.js')], ['./zeitstempel', require('../zeitstempel.js')], ['./schluessel', require('../schluessel.js')], ['./usb', require('../usb.js')], ['./beleg-layout', { bildspeicherSetzen: () => {} }], ['./angaben', require('../angaben.js')], ['./steuer', require('../steuer.js')], ['./uebersicht', require('../uebersicht.js')],
 ['./datenbank-index', require('../datenbank-index.js')],
 ['./persoenlich', require('../persoenlich.js')],
 ['./jahresarchiv', require('../jahresarchiv.js')], ['./verfahren', require('../verfahren.js')], ['./dsgvo', require('../dsgvo.js')], ['./erechnung', require('../erechnung.js')], ['./schutz', { schuetzen: (z) => { schutzAufrufe.push(z); return { erfolgreich: true } } }]
  ])
  const modul = { exports: {} }
  new Function('require', 'module', 'exports', '__dirname', fs.readFileSync(path.join(pluginFolder, 'haupt.js'), 'utf8'))(
    (n) => { if (!abh.has(n)) throw new Error(`unerwartetes require: ${n}`); return abh.get(n) }, modul, modul.exports, plugin)
  let daten = {}
  const dienste = new Map()
  modul.exports({ datenLaden: () => structuredClone(daten), datenSpeichern: (d) => { daten = structuredClone(d) }, bereitstellen: (n, fn) => dienste.set(n, fn) })
  const archivOrdner = path.join(home, 'Documents', 'Vendo-Archiv')
  return { dienste, schutzAufrufe, archivOrdner, datenOrdner: path.join(vendo, 'daten', 'buchhaltung'), basis, daten: () => daten, a: require('../archiv.js').archiv(archivOrdner) }
}

test('Hinzufügen legt die PDF unveränderlich im Archiv ab, Scannen liest sie dort, Ausblenden lässt sie dort (Schritt 1.6)', async (t) => {
  const { dienste, archivOrdner, datenOrdner, basis, daten, a } = starten(t)
  const quelle = path.join(basis, 'Download', 'Rechnung TEST-EINGANG-1.pdf')
  fs.mkdirSync(path.dirname(quelle), { recursive: true })
  const bytes = minimalPdf(RECHNUNG)
  fs.writeFileSync(quelle, bytes)

  const e = dienste.get('hinzufuegen')({ pfad: quelle, name: path.basename(quelle) })
  assert.match(e.archiv.datei, new RegExp(`^${new Date().getFullYear()}/eingang/Rechnung TEST-EINGANG-1__${sha(bytes).slice(0, 12)}\\.pdf$`))
  const archivDatei = a.pfad(e.archiv)
  assert.deepEqual(fs.readFileSync(archivDatei), bytes)
  assert.equal(fs.statSync(archivDatei).mode & 0o200, 0, 'schreibgeschützt')
  assert.deepEqual(fs.readFileSync(quelle), bytes, 'Quelle unberührt')
  assert.equal(fs.existsSync(datenOrdner), false, 'keine Kopie unter daten/buchhaltung')
  assert.deepEqual(a.eintraege().map((x) => [x.art, x.meta.quelle, x.meta.eintrag]), [['eingang', 'pdf-eingang', e.id]])
  assert.equal(path.relative(archivOrdner, archivDatei).startsWith('..'), false)

  const gescannt = await dienste.get('scannen')(e.id)
  assert.equal(gescannt.methode, 'text')
  assert.match(gescannt.text, /TEST-EINGANG-1/)
  assert.equal(gescannt.rechnung.rechnungsnummer, 'TEST-EINGANG-1')
  assert.equal(fs.readFileSync(path.join(datenOrdner, `${e.id}.txt`), 'utf8'), gescannt.text, 'Text liegt veränderlich in daten/buchhaltung')
  assert.equal((await dienste.get('liste')()).length, 1)
  const summe = dienste.get('uebersicht')().gesamt.ausgaben
  assert.ok(summe > 0)

  dienste.get('ausblenden')(e.id)
  assert.equal((await dienste.get('liste')()).length, 0)
  assert.equal(dienste.get('uebersicht')().gesamt.ausgaben, 0)
  assert.deepEqual(fs.readFileSync(archivDatei), bytes, 'Beleg bleibt im Archiv')
  assert.equal(daten().dateien.length, 1, 'Eintrag bleibt gespeichert (ausgeblendet)')
  const pruefung = a.integritaet()
  assert.deepEqual([pruefung.ok, pruefung.geprueft], [true, 2], pruefung.fehler.join('; ')) // Beleg + Änderungsprotokoll „ausblenden“ (K.1)
  assert.deepEqual(a.eintraege().map((x) => [x.art, x.meta?.bereich ?? null]), [['eingang', null], ['protokoll', 'ausblenden']])

  // dieselbe Datei erneut: derselbe Archivbeleg, neuer sichtbarer Eintrag
  const wieder = dienste.get('hinzufuegen')({ pfad: quelle, name: path.basename(quelle) })
  assert.deepEqual([wieder.schonImArchiv, wieder.archiv.datei, a.eintraege().length], [true, e.archiv.datei, 2]) // kein zweiter Beleg, nur das Protokoll „ausblenden“
  assert.equal((await dienste.get('liste')()).length, 1)
  assert.equal(dienste.get('integritaet')().archiv.ok, true)
})

test('Eingang wird mit dem Windows-Schutz-Modul sofort geschützt (Schritt 1.6)', (t) => {
  const { dienste, basis, schutzAufrufe, a } = starten(t)
  const quelle = path.join(basis, 'x.pdf')
  fs.writeFileSync(quelle, minimalPdf('Synthetisch'))
  const e = dienste.get('hinzufuegen')({ pfad: quelle, name: 'x.pdf' })
  assert.equal(e.schutzFehler, undefined)
  assert.equal(schutzAufrufe.length, 1)
  assert.deepEqual(schutzAufrufe[0].dateien, [a.pfad(e.archiv)])
  assert.deepEqual(schutzAufrufe[0].nurLoeschen, [a.INDEX])
})
