import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// Tests für das neue Belegarchiv (plugins/buchhaltung/archiv.js), Plan-Schritt 1.1.
// Nur synthetische Inhalte in einem frischen Temp-Ordner je Test.

const require = createRequire(import.meta.url)
const { archiv, sichererName } = require('../archiv.js')
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex')

function neu(t) {
  const wurzel = fs.mkdtempSync(path.join(os.tmpdir(), 'vendo-archiv-test-'))
  t.after(() => {
    const alle = (o) => fs.readdirSync(o, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? alle(path.join(o, d.name)) : [path.join(o, d.name)])
    for (const datei of alle(wurzel)) fs.chmodSync(datei, 0o666)
    fs.rmSync(wurzel, { recursive: true, force: true })
  })
  return { a: archiv(wurzel), wurzel }
}
const beschreibbar = (datei) => fs.chmodSync(datei, 0o666)

test('Ablegen: Pfad mit Jahr/Art/Hash, schreibgeschützt, Index als Hash-Kette', (t) => {
  const { a, wurzel } = neu(t)
  const inhalt = Buffer.from('%PDF synthetischer Beleg 1')
  const e1 = a.ablegen(inhalt, { art: 'umsatzbeleg', jahr: 2026, name: 'Umsatzbeleg Bestellung 9001.PDF', meta: { bestellung: '9001' } })
  const e2 = a.ablegen(Buffer.from('<xml>synthetisch</xml>'), { art: 'e-rechnung', jahr: 2025, name: 'rechnung.xml' })

  assert.equal(e1.datei, `2026/umsatzbeleg/Umsatzbeleg Bestellung 9001__${sha(inhalt).slice(0, 12)}.pdf`)
  assert.deepEqual([e1.nr, e1.sha256, e1.bytes, e1.meta.bestellung, e1.vorher], [1, sha(inhalt), inhalt.length, '9001', '0'.repeat(64)])
  assert.deepEqual([e2.nr, e2.vorher], [2, e1.hash])
  const datei = path.join(wurzel, ...e1.datei.split('/'))
  assert.deepEqual(fs.readFileSync(datei), inhalt)
  assert.equal(fs.statSync(datei).mode & 0o200, 0, 'Archivdatei ist schreibgeschützt')
  assert.equal(a.eintraege().length, 2)
  assert.deepEqual(a.finden(sha(inhalt)).map((e) => e.nr), [1])

  const pruefung = a.integritaet()
  assert.deepEqual([pruefung.ok, pruefung.geprueft, pruefung.letzterHash], [true, 2, e2.hash], pruefung.fehler.join('; '))
})

test('Gleicher Inhalt derselben Art wird nicht doppelt abgelegt, in anderer Art schon', (t) => {
  const { a } = neu(t)
  const inhalt = Buffer.from('gleicher Inhalt')
  const e1 = a.ablegen(inhalt, { art: 'eingang', jahr: 2026, name: 'a.pdf' })
  const e2 = a.ablegen(inhalt, { art: 'eingang', jahr: 2026, name: 'anderer-name.pdf' })
  assert.equal(e2.doppelt, true)
  assert.equal(e2.nr, e1.nr)
  const e3 = a.ablegen(inhalt, { art: 'pruefbericht', jahr: 2026, name: 'a.pdf' })
  assert.equal(e3.nr, 2)
  assert.equal(a.eintraege().length, 2)
})

test('Ablegen aus einer Quelldatei kopiert nur – die Quelle bleibt unverändert', (t) => {
  const { a, wurzel } = neu(t)
  const quelle = path.join(wurzel, '..', `vendo-archiv-quelle-${process.pid}-${Date.now()}.pdf`)
  fs.writeFileSync(quelle, 'synthetische Quelle')
  t.after(() => fs.rmSync(quelle, { force: true }))
  const e = a.ablegen(quelle, { art: 'eingang', jahr: 2024 })
  assert.equal(fs.readFileSync(quelle, 'utf8'), 'synthetische Quelle')
  assert.match(e.datei, /^2024\/eingang\/vendo-archiv-quelle-.*__[0-9a-f]{12}\.pdf$/)
})

test('Ungültige Eingaben werden abgelehnt', (t) => {
  const { a } = neu(t)
  const ok = { art: 'eingang', jahr: 2026, name: 'x.pdf' }
  assert.throws(() => archiv('relativer/ordner'), /absoluter Pfad/)
  assert.throws(() => a.ablegen(Buffer.from('x'), { ...ok, art: '../ausbruch' }), /Belegart/)
  assert.throws(() => a.ablegen(Buffer.from('x'), { ...ok, art: 'GROSS' }), /Belegart/)
  assert.throws(() => a.ablegen(Buffer.from('x'), { ...ok, jahr: 1999 }), /Jahr/)
  assert.throws(() => a.ablegen(Buffer.from('x'), { ...ok, jahr: '2026x' }), /Jahr/)
  assert.throws(() => a.ablegen(Buffer.alloc(0), ok), /Leere Datei/)
  assert.throws(() => a.ablegen('relativ.pdf', ok), /absoluter Pfad/)
  assert.throws(() => a.ablegen(path.join(os.tmpdir(), 'gibt-es-nicht-vendo.pdf'), ok), /nicht gefunden/)
  assert.throws(() => a.ablegen(Buffer.from('x'), { ...ok, meta: [] }), /Zusatzangaben/)
  assert.throws(() => a.ablegen(Buffer.from('x'), { ...ok, meta: { gross: 'x'.repeat(5000) } }), /zu groß/)
  assert.equal(a.eintraege().length, 0)
})

test('Dateinamen können den Archivordner nicht verlassen und enthalten keine Windows-Sonderzeichen', (t) => {
  const { a } = neu(t)
  const e = a.ablegen(Buffer.from('y'), { art: 'eingang', jahr: 2026, name: '..\\..\\böse:na*me?.PDF' })
  assert.match(e.datei, /^2026\/eingang\/böse_na_me___[0-9a-f]{12}\.pdf$/)
  assert.deepEqual(sichererName('...'), { stamm: 'datei', endung: '' })
  assert.deepEqual(sichererName('CON.txt '), { stamm: 'CON', endung: '.txt' }, 'Hash-Endung im Namen verhindert reservierte Gerätenamen')
})

test('Integritätsprüfung erkennt veränderte, fehlende und fremde Dateien sowie manipulierten Index', (t) => {
  const { a, wurzel } = neu(t)
  const e1 = a.ablegen(Buffer.from('eins'), { art: 'eingang', jahr: 2026, name: 'eins.pdf', meta: { betrag: 10 } })
  const e2 = a.ablegen(Buffer.from('zwei'), { art: 'eingang', jahr: 2026, name: 'zwei.pdf' })
  a.ablegen(Buffer.from('drei'), { art: 'eingang', jahr: 2026, name: 'drei.pdf' })
  assert.equal(a.integritaet().ok, true)

  const d1 = a.pfad(e1)
  beschreibbar(d1)
  fs.appendFileSync(d1, ' manipuliert')
  assert.ok(a.integritaet().fehler.some((f) => f === `Datei verändert: ${e1.datei}`))

  const d2 = a.pfad(e2)
  beschreibbar(d2)
  fs.rmSync(d2)
  assert.ok(a.integritaet().fehler.some((f) => f === `Datei fehlt: ${e2.datei}`))

  fs.writeFileSync(path.join(wurzel, '2026', 'eingang', 'untergeschoben.pdf'), 'fremd')
  assert.ok(a.integritaet().fehler.some((f) => f === 'Datei nicht im Index: 2026/eingang/untergeschoben.pdf'))

  const zeilen = fs.readFileSync(a.INDEX, 'utf8').trim().split('\n').map((z) => JSON.parse(z))
  zeilen[0].meta.betrag = 999
  fs.writeFileSync(a.INDEX, zeilen.map((z) => JSON.stringify(z)).join('\n') + '\n')
  assert.ok(a.integritaet().fehler.includes('Indexeintrag verändert: 1'))

  zeilen.splice(1, 1)
  fs.writeFileSync(a.INDEX, zeilen.map((z) => JSON.stringify(z)).join('\n') + '\n')
  const fehler = a.integritaet().fehler
  assert.ok(fehler.some((f) => /Index-Kette unterbrochen bei Eintrag 3/.test(f)))
  assert.ok(fehler.some((f) => /Indexnummer 3 an Position 2/.test(f)))
})

test('Unlesbare Indexzeile wird gemeldet und blockiert weiteres Ablegen', (t) => {
  const { a } = neu(t)
  a.ablegen(Buffer.from('eins'), { art: 'eingang', jahr: 2026, name: 'eins.pdf' })
  fs.appendFileSync(a.INDEX, '{"abgebrochen": \n')
  assert.ok(a.integritaet().fehler.includes('Indexzeile 2 ist unlesbar'))
  assert.throws(() => a.ablegen(Buffer.from('zwei'), { art: 'eingang', jahr: 2026, name: 'zwei.pdf' }), /beschädigt/)
})

test('Nach einem Abbruch (Datei geschrieben, Index fehlt) wird die Datei beim nächsten Ablegen nachgetragen', (t) => {
  const { a, wurzel } = neu(t)
  const inhalt = Buffer.from('abgebrochen')
  const relativ = path.join('2026', 'eingang', `x__${sha(inhalt).slice(0, 12)}.pdf`)
  fs.mkdirSync(path.join(wurzel, '2026', 'eingang'), { recursive: true })
  fs.writeFileSync(path.join(wurzel, relativ), inhalt)
  assert.equal(a.integritaet().ok, false, 'verwaiste Datei wird gemeldet')

  const e = a.ablegen(inhalt, { art: 'eingang', jahr: 2026, name: 'x.pdf' })
  assert.equal(e.nr, 1)
  assert.equal(a.integritaet().ok, true)

  const anderer = Buffer.from('anderer Inhalt, gleicher Name')
  const konflikt = path.join(wurzel, '2026', 'eingang', `y__${sha(anderer).slice(0, 12)}.pdf`)
  fs.writeFileSync(konflikt, 'etwas ganz anderes')
  assert.throws(() => a.ablegen(anderer, { art: 'eingang', jahr: 2026, name: 'y.pdf' }), /EEXIST/, 'fremde Datei wird nie überschrieben')
  assert.equal(fs.readFileSync(konflikt, 'utf8'), 'etwas ganz anderes')
})

test('Ein neues Archiv-Objekt auf demselben Ordner setzt die Kette fort', (t) => {
  const { a, wurzel } = neu(t)
  const e1 = a.ablegen(Buffer.from('eins'), { art: 'eingang', jahr: 2026, name: 'eins.pdf' })
  const b = archiv(wurzel)
  const e2 = b.ablegen(Buffer.from('zwei'), { art: 'eingang', jahr: 2026, name: 'zwei.pdf' })
  assert.deepEqual([e2.nr, e2.vorher], [2, e1.hash])
  assert.equal(a.eintraege().length, 2, 'erstes Objekt sieht den neuen Eintrag ebenfalls')
  assert.equal(b.integritaet().ok, true)
})

test('Schutz-Anbindung: Datei, ihre Ordner und der Index werden übergeben; Fehler verhindern das Ablegen nicht', (t) => {
  const wurzel = fs.mkdtempSync(path.join(os.tmpdir(), 'vendo-archiv-test-'))
  t.after(() => fs.rmSync(wurzel, { recursive: true, force: true }))
  const aufrufe = []
  let antwort = { erfolgreich: true }
  const a = archiv(wurzel, { schutz: { schuetzen(ziele) { aufrufe.push(ziele); if (antwort instanceof Error) throw antwort; return antwort } } })

  const e = a.ablegen(Buffer.from('eins'), { art: 'eingang', jahr: 2026, name: 'eins.pdf' })
  assert.equal(e.geschuetzt, true)
  assert.deepEqual(aufrufe[0], {
    dateien: [a.pfad(e)], nurLoeschen: [a.INDEX],
    ordner: [wurzel, path.join(wurzel, '2026', 'eingang'), path.join(wurzel, '2026')]
  })

  antwort = { erfolgreich: false, fehler: ['synthetischer Fehler'] }
  const e2 = a.ablegen(Buffer.from('zwei'), { art: 'eingang', jahr: 2026, name: 'zwei.pdf' })
  assert.deepEqual([e2.geschuetzt, e2.schutzFehler], [false, ['synthetischer Fehler']])
  antwort = new Error('PowerShell fehlt')
  const e3 = a.ablegen(Buffer.from('drei'), { art: 'eingang', jahr: 2026, name: 'drei.pdf' })
  assert.deepEqual([e3.geschuetzt, e3.schutzFehler], [false, ['PowerShell fehlt']])
  assert.equal(a.eintraege().length, 3, 'Belege sind trotzdem archiviert')

  assert.equal(a.ablegen(Buffer.from('eins'), { art: 'eingang', jahr: 2026, name: 'eins.pdf' }).doppelt, true)
  assert.equal(aufrufe.length, 3, 'Doppelte lösen keinen neuen Schutzaufruf aus')

  antwort = { erfolgreich: true }
  assert.equal(a.alleSchuetzen().geschuetzt, true)
  assert.deepEqual(aufrufe.at(-1).dateien, a.eintraege().map((x) => a.pfad(x)))
  assert.equal(archiv(wurzel).ablegen(Buffer.from('vier'), { art: 'eingang', jahr: 2026, name: 'vier.pdf' }).geschuetzt, false, 'ohne Schutz-Option kein Schutz')
})

test('integritaetAsync liefert dasselbe wie integritaet und gibt dabei den Prozess frei (Schritt 1.10)', async (t) => {
  const { a } = neu(t)
  for (let i = 0; i < 120; i++) a.ablegen(Buffer.from(`synthetischer Beleg ${i}`), { art: 'eingang', jahr: 2026, name: `b${i}.pdf` })
  assert.deepEqual(await a.integritaetAsync(), a.integritaet())
  let ticks = 0
  const zaehler = setInterval(() => { ticks++ }, 0)
  const p = a.integritaetAsync()
  const erg = await p
  clearInterval(zaehler)
  assert.equal(erg.ok, true)
  assert.ok(ticks > 0, 'andere Aufgaben kamen während der Prüfung dran')
  const datei = a.pfad(a.eintraege()[5])
  beschreibbar(datei)
  fs.appendFileSync(datei, 'x')
  const asy = await a.integritaetAsync()
  assert.deepEqual(asy, a.integritaet())
  assert.deepEqual([asy.ok, asy.fehler.length], [false, 1])
})
