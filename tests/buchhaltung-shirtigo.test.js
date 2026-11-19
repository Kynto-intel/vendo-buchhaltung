import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// Tests für den Shirtigo-Abgleich (plugins/buchhaltung/shirtigo-bestellungen.js), Ablage im Belegarchiv seit Plan-Schritt 1.5.
// Nur synthetische Bestellungen in Temp-Ordnern; Shirtigo (MCP + REST) ist ein Stub: kein Netz, kein Token.

const require = createRequire(import.meta.url)
const pluginFolder = path.resolve('.')
const parser = require('../parser.js')
const { archiv } = require('../archiv.js')
const ohneHash = (datei) => datei.replace(/__[0-9a-f]{12}(\.[a-z]+)$/, '$1')
const betrag = (cent) => ({ amount: cent, currency_factor: 100, currency_code: 'EUR' })

function auftrag(ref, overrides = {}) {
  return {
    reference: ref, invoice_reference: `R-${ref}`, created_at: '2026-03-02 10:00:00', updated_at: '2026-03-02 11:00:00',
    net_price: betrag(1000), gross_price: betrag(1190), vat_amount: betrag(190), vat_rate: 19,
    products: [{ name: 'Synthetisches Shirt', amount: 1, net_total_price: betrag(1000), color: 'Schwarz', size: 'M' }],
    payments: [{ status: 'paid', type: 'synthetic', updated_at: '2026-03-03 09:00:00' }],
    fulfillment: { type: 'shopify', reference: '9010' },
    ...overrides
  }
}

function modulLaden(datei, abhaengig) {
  const modul = { exports: {} }
  const quelle = fs.readFileSync(path.join(pluginFolder, datei), 'utf8')
  new Function('require', 'module', 'exports', '__dirname', quelle)((name) => {
    if (!abhaengig.has(name)) throw new Error(`unerwartetes require in ${datei}: ${name}`)
    return abhaengig.get(name)
  }, modul, modul.exports, pluginFolder)
  return modul.exports
}

// seiten: je Abgleich eine Liste von Aufträgen; pdfs: Referenz -> Buffer | null | Error
function laden(t, seiten = [], pdfs = {}, { schutz = null } = {}) {
  const wurzel = fs.mkdtempSync(path.join(os.tmpdir(), 'vendo-shirtigo-test-'))
  t.after(() => {
    const alle = (o) => fs.existsSync(o) ? fs.readdirSync(o, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? alle(path.join(o, d.name)) : [path.join(o, d.name)]) : []
    for (const d of alle(wurzel)) fs.chmodSync(d, 0o666)
    fs.rmSync(wurzel, { recursive: true, force: true })
  })
  const arbeit = path.join(wurzel, 'Rechnungen')
  const vorher = process.env.VENDO_BELEGE
  process.env.VENDO_BELEGE = arbeit
  let bestellungen
  try {
    bestellungen = modulLaden('bestellungen.js', new Map([
      ['node:fs', fs], ['node:os', os], ['node:path', path], ['node:crypto', require('node:crypto')],
      ['./shopify', { API_VERSION: 'synthetic', graphql: async () => { throw new Error('kein Shopify im Test') } }],
      ['./beleg', { belegPdf: async () => Buffer.from('%PDF') }], ['./parser', parser], ['./geo', { finde: () => null }], ['./profil', require('../profil.js')]
    ]))
  } finally {
    if (vorher === undefined) delete process.env.VENDO_BELEGE
    else process.env.VENDO_BELEGE = vorher
  }
  const pdfAbrufe = []
  const shirtigo = {
    nutzdaten: (x) => x,
    async aufrufen(werkzeug, { page }) {
      assert.equal(werkzeug, 'list_orders')
      const daten = page === 1 ? seiten.shift() || [] : []
      return { data: daten, meta: { pagination: { total_pages: 1 } } }
    },
    async rechnungPdf(o) {
      pdfAbrufe.push(o.reference)
      const x = typeof pdfs === 'function' ? pdfs(o) : pdfs[o.reference]
      if (x instanceof Error) throw x
      return x ?? null
    }
  }
  const s = modulLaden('shirtigo-bestellungen.js', new Map([['node:fs', fs], ['./shirtigo', shirtigo], ['./bestellungen', bestellungen], ['./parser', parser], ['./profil', require('../profil.js')]]))
  const a = archiv(path.join(wurzel, 'Vendo-Archiv'), { schutz })
  s.einrichten({ archiv: a })
  return { s, a, arbeit, pdfAbrufe }
}
const pdf = (text) => Buffer.from(`%PDF-1.4 synthetische Shirtigo-Rechnung ${text}`)

test('Abgleich legt Originale und Rechnungs-PDF im Archiv ab, Ansichtskopie im Monatsordner (Schritt 1.5)', async (t) => {
  const { s, a, arbeit, pdfAbrufe } = laden(t, [[auftrag('T-100'), auftrag('T-101', { invoice_reference: null })]], { 'T-100': pdf('R-100') })
  const erg = await s.abgleichen()
  assert.deepEqual([erg.neu, erg.geaendert, erg.ohneRechnung, erg.pdfNeu, erg.pdfOffen, erg.hinweise], [2, 0, 1, 1, 0, undefined])
  assert.deepEqual(pdfAbrufe, ['T-100'], 'nur für Aufträge mit Rechnungsnummer')
  assert.deepEqual(a.eintraege().map((x) => [x.art, ohneHash(x.datei), x.meta]), [
    ['shirtigo-original', '2026/shirtigo-original/Shirtigo Bestellung T-100 v1.json', { quelle: 'shirtigo-mcp', shirtigo: 'T-100', version: 1 }],
    ['shirtigo-original', '2026/shirtigo-original/Shirtigo Bestellung T-101 v1.json', { quelle: 'shirtigo-mcp', shirtigo: 'T-101', version: 1 }],
    ['eingang', '2026/eingang/Shirtigo Rechnung R-T-100.pdf', { quelle: 'shirtigo-api', shirtigo: 'T-100', rechnungsnummer: 'R-T-100' }]
  ])
  const kopie = path.join(arbeit, '2026', '03 - März', 'Shirtigo Rechnungen', 'Shirtigo Rechnung R-T-100.pdf')
  assert.deepEqual(fs.readFileSync(kopie), pdf('R-100'))
  const liste = s.eintraege()
  assert.deepEqual(liste.map((e) => [e.id, e.rechnung.nurDaten, e.rechnung.datum, e.rechnung.art]), [['tT-100', false, '2026-03-03', 'ausgabe']])
  assert.equal(s.pdfPfad('tT-100'), a.pfad(a.eintraege()[2]))
  assert.equal(a.integritaet().ok, true)
})

test('Unveränderte Aufträge bleiben, Änderungen werden Version 2 und behalten die PDF ohne neuen Abruf (Schritt 1.5)', async (t) => {
  const { s, a, pdfAbrufe } = laden(t, [[auftrag('T-200')], [auftrag('T-200')], [auftrag('T-200', { updated_at: '2026-04-01 08:00:00' })]], { 'T-200': pdf('R-200') })
  await s.abgleichen()
  const zweit = await s.abgleichen()
  assert.deepEqual([zweit.neu, zweit.geaendert, a.eintraege().length], [0, 0, 2])
  const dritt = await s.abgleichen()
  assert.equal(dritt.geaendert, 1)
  assert.deepEqual(a.eintraege().map((x) => [x.art, x.meta.version ?? null]), [['shirtigo-original', 1], ['eingang', null], ['shirtigo-original', 2]])
  assert.deepEqual(pdfAbrufe, ['T-200'], 'PDF nur einmal geholt')
  assert.equal(s.eintraege()[0].rechnung.version, 'shirtigo-api-2')
  assert.ok(s.eintraege()[0].beleg)
})

test('Noch keine PDF bei Shirtigo: Eintrag ohne Beleg, nächster Abgleich holt sie; ein Fehler blockiert die übrigen nicht (Schritt 1.5)', async (t) => {
  let freigegeben = false
  const { s, a } = laden(t, [[auftrag('T-300'), auftrag('T-301')], []], (o) => o.reference === 'T-301' ? new Error('synthetischer Netzfehler') : freigegeben ? pdf('R-300') : null)
  const erst = await s.abgleichen()
  assert.deepEqual([erst.pdfNeu, erst.pdfKeine, erst.pdfOffen], [0, 1, 2])
  assert.deepEqual(erst.pdfFehler, ['T-301: synthetischer Netzfehler'])
  assert.deepEqual(s.eintraege().map((e) => e.rechnung.nurDaten), [true, true])
  assert.throws(() => s.pdfPfad('tT-300'), /noch keine PDF/)

  freigegeben = true
  const zweit = await s.abgleichen()
  assert.deepEqual([zweit.pdfNeu, zweit.pdfOffen], [1, 1])
  assert.equal(s.eintraege().find((e) => e.id === 'tT-300').rechnung.nurDaten, false)
  assert.equal(a.eintraege().filter((x) => x.art === 'eingang').length, 1)
})

test('Eigene gleichnamige Datei im Monatsordner bleibt, Ansichtskopie heißt „(API)“ (Schritt 1.5)', async (t) => {
  const { s, arbeit } = laden(t, [[auftrag('T-400')]], { 'T-400': pdf('R-400') })
  const ordner = path.join(arbeit, '2026', '03 - März', 'Shirtigo Rechnungen')
  fs.mkdirSync(ordner, { recursive: true })
  fs.writeFileSync(path.join(ordner, 'Shirtigo Rechnung R-T-400.pdf'), 'vom Nutzer selbst gespeichert')
  const erg = await s.abgleichen()
  assert.equal(erg.hinweise, undefined)
  assert.equal(fs.readFileSync(path.join(ordner, 'Shirtigo Rechnung R-T-400.pdf'), 'utf8'), 'vom Nutzer selbst gespeichert')
  assert.deepEqual(fs.readFileSync(path.join(ordner, 'Shirtigo Rechnung R-T-400 (API).pdf')), pdf('R-400'))
})

test('Migrierter Altbestand wird gelesen, ohne PDF erneut zu holen; Schutz einmal je Abgleich; alte Funktionen entfernt (Schritt 1.5)', async (t) => {
  const aufrufe = []
  const alt = auftrag('T-500')
  const { s, a, pdfAbrufe } = laden(t, [[alt], [auftrag('T-501')]], { 'T-501': pdf('R-501') }, { schutz: { schuetzen(z) { aufrufe.push(z); return { erfolgreich: true } } } })
  // so legt migration.umziehen den Altbestand ab (Schritt 1.4)
  a.ablegen(Buffer.from(JSON.stringify({ meta: { abgerufen: '2026-01-01T00:00:00Z' }, bestellung: alt })), { art: 'shirtigo-original', jahr: 2026, name: 'Shirtigo Bestellung T-500 v1.json', meta: { quelle: 'migration', shirtigo: 'T-500', version: 1 }, sofortSchuetzen: false })
  a.ablegen(pdf('R-500'), { art: 'eingang', jahr: 2026, name: 'Shirtigo Rechnung R-T-500.pdf', meta: { quelle: 'migration', shirtigo: 'T-500', rechnungsnummer: 'R-T-500' }, sofortSchuetzen: false })
  assert.equal(s.eintraege()[0].beleg.pdf, a.eintraege()[1].datei)
  assert.equal(s.eintraege()[0].scanStand, Date.parse('2026-01-01T00:00:00Z'), 'Abrufzeit aus dem Original, nicht die Umzugszeit')

  const erst = await s.abgleichen()
  assert.deepEqual([erst.neu, erst.geaendert, erst.pdfNeu, pdfAbrufe.length, aufrufe.length], [0, 0, 0, 0, 0])
  await s.abgleichen()
  assert.deepEqual(pdfAbrufe, ['T-501'])
  assert.equal(aufrufe.length, 1, 'neue Datei + PDF in einem Schutzaufruf')
  assert.equal(aufrufe[0].dateien.length, 2)

  assert.deepEqual(Object.keys(s).sort(), ['abgleichen', 'beschaeftigt', 'einrichten', 'eintraege', 'neuBerechnen', 'pdfPfad', 'status', 'warten', 'zuRechnung'])
})

test('Selbst eingelesene, byte-gleiche PDF wird per Zuordnung verbunden, kein zweites Exemplar, auch nach Neustart (Schritt 1.6)', async (t) => {
  const { s, a, pdfAbrufe } = laden(t, [[auftrag('T-600')], []], { 'T-600': pdf('R-600') })
  // vorher selbst über „PDF hinzufügen“ eingelesen (haupt.js, Schritt 1.6)
  const eigen = a.ablegen(pdf('R-600'), { art: 'eingang', jahr: 2026, name: 'Rechnung Shirtigo.pdf', meta: { quelle: 'pdf-eingang', eintrag: 'r' + '0'.repeat(20), name: 'Rechnung Shirtigo.pdf' } })
  const erg = await s.abgleichen()
  assert.deepEqual([erg.pdfNeu, erg.pdfFehler, erg.pdfOffen], [1, [], 0])
  const arten = a.eintraege().map((x) => x.art)
  assert.deepEqual(arten, ['eingang', 'shirtigo-original', 'zuordnung'], 'kein zweites Exemplar der PDF')
  const z = a.eintraege()[2]
  assert.deepEqual(z.meta, { quelle: 'shirtigo-api', shirtigo: 'T-600', beleg: eigen.sha256 })
  assert.deepEqual(JSON.parse(fs.readFileSync(a.pfad(z), 'utf8')), { shirtigo: 'T-600', rechnungsnummer: 'R-T-600', beleg: eigen.datei, sha256: eigen.sha256 })
  assert.equal(s.pdfPfad('tT-600'), a.pfad(eigen))

  s.einrichten({ archiv: a }) // Neustart: Zwischenspeicher wird aus dem Archiv neu gebaut
  assert.equal(s.eintraege()[0].beleg.pdf, eigen.datei)
  await s.abgleichen()
  assert.deepEqual(pdfAbrufe, ['T-600'], 'nach Neustart nicht erneut geholt')
  assert.equal(a.integritaet().ok, true)
})
