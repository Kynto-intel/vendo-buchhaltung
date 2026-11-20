import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const parser = require('../parser.js')
const pluginFolder = path.resolve('.')
const dataFolder = path.resolve('..', '..', 'daten', 'buchhaltung') // wie in Vendo: <Plugin>/../../daten/buchhaltung (nur synthetisch, nie geschrieben)

const syntheticRoot = path.parse(process.cwd()).root
const syntheticHome = path.join(syntheticRoot, 'synthetic-home')
const syntheticReceipts = path.join(syntheticRoot, 'synthetic-receipts')

function createPluginHarness({ failOnSave = false, initialData = { dateien: [] }, steuerBefund = null, shopEintraege = [] } = {}) {
  const files = new Map()
  let storedData = structuredClone(initialData)
  let saveFailure = failOnSave
  const resolveKey = (file) => path.resolve(String(file))
  const fs = {
    constants: require('node:fs').constants,
    existsSync(file) { return files.has(resolveKey(file)) },
    readFileSync(file) {
      const value = files.get(resolveKey(file))
      if (value == null) throw new Error('synthetic file not found')
      return value
    },
    statSync(file, options = {}) {
      const value = files.get(resolveKey(file))
      if (value == null) {
        if (options.throwIfNoEntry === false) return undefined
        throw new Error('synthetic file not found')
      }
      return { size: Buffer.byteLength(value), isFile: () => true, isDirectory: () => false }
    },
    mkdirSync() {},
    copyFileSync(from, to, flags) {
      if (flags === require('node:fs').constants.COPYFILE_EXCL && files.has(resolveKey(to))) throw new Error('File already exists')
      const value = files.get(resolveKey(from))
      if (value == null) throw new Error('Synthetic source file not found')
      files.set(resolveKey(to), value)
    },
    renameSync(from, to) {
      const value = files.get(resolveKey(from))
      if (value == null) throw new Error('Synthetic source file not found')
      files.set(resolveKey(to), value)
      files.delete(resolveKey(from))
    },
    rmSync(file) { files.delete(resolveKey(file)) }
  }
  const setups = { bestellungen: [], shirtigo: [] }
  const archives = []
  const usbAufrufe = []
  const integritaetAsyncAufrufe = []
  let archivPruefung = ({ geprueft }) => ({ ok: true, geprueft, letzterHash: 'H', fehler: [] })
  let testErgebnis = { ok: true, zeit: '2026-10-29T12:00:00.000Z', stand: 'S1.vsb', erstellt: '2026-10-29T11:00:00.000Z', dateien: 1439, bytes: 108e6, letzterHash: 'H', integritaet: { ok: true, geprueft: 1440, fehler: [] }, fehler: [], dauerMs: 9000, tempGeloescht: true }
  const usbLaufwerke = [{ laufwerk: 'D:', wurzel: 'D:\\', name: 'STICK', dateisystem: 'FAT32', frei: 10 ** 9 }]
  let usbErgebnisOk = true
  let busy = false
  const neuBerechnet = []
  const emptyIntegration = {
    einrichten(value) { setups.shirtigo.push(value) },
    beschaeftigt: () => busy,
    eintraege: () => [],
    orte: () => [],
    warten: async () => {},
    zuruecksetzen: () => ({}),
    pdfDateien: () => [],
    pdfPfad: () => path.join(dataFolder, 'synthetic.pdf'),
    cacheLeeren() {},
    neuBerechnen() { neuBerechnet.push('shirtigo') },
    status: () => ({}),
    abgleichen: async () => ({}),
    integritaet: () => ({ ok: true })
  }
  const dependencies = new Map([
    ['node:fs', fs],
    ['node:os', { homedir: () => syntheticHome }],
    ['node:path', path],
    ['node:crypto', { randomBytes: (size) => Buffer.alloc(size, 0x42) }],
    ['@napi-rs/canvas', { createCanvas() { throw new Error('OCR darf im Test nicht starten') } }],
    ['tesseract.js', { createWorker() { throw new Error('OCR darf im Test nicht starten') } }],
    ['@tesseract.js-data/deu', { langPath: 'synthetic-language-data' }],
    ['./parser', parser],
    ['./textlayer', { seitenText: async () => '' }],
    ['./bestellungen', { ...emptyIntegration, einrichten(value) { setups.bestellungen.push(value) }, WURZEL: syntheticReceipts, eintraege: () => structuredClone(shopEintraege), gebuehrenEintraege: () => [], warten: async () => {}, abgleichen: async () => ({ neu: 0, geaendert: 0 }), neuBerechnen() { neuBerechnet.push('shopify') }, steuerBefund: () => { if (!steuerBefund) throw new Error('Das Belegarchiv ist nicht eingerichtet.'); return structuredClone(steuerBefund) } }],
    ['./archiv', {
      archiv(wurzel, options) {
        // minimales Archiv auf dem In-Memory-Dateisystem: ablegen (Hash, Doppelte), pfad, integritaet
        const abgelegt = []
        const a = {
          WURZEL: wurzel, options, abgelegt,
          integritaet: () => ({ ok: true, geprueft: abgelegt.length, wurzel }),
          integritaetAsync: async () => { integritaetAsyncAufrufe.push(Date.now()); return archivPruefung({ geprueft: abgelegt.length }) },
          pfad: (e) => path.resolve(wurzel, ...String(e.datei).split('/')),
          eintraege: () => abgelegt.map((e) => ({ ...e })),
          ablegen(quelle, angaben) {
            const inhalt = Buffer.isBuffer(quelle) ? quelle : files.get(resolveKey(quelle))
            if (inhalt == null) throw new Error('synthetic source file not found')
            const hash = require('node:crypto').createHash('sha256').update(inhalt).digest('hex')
            const vorhanden = abgelegt.find((e) => e.sha256 === hash && e.art === angaben.art)
            if (vorhanden) return { ...vorhanden, doppelt: true }
            const e = { art: angaben.art, jahr: angaben.jahr, meta: angaben.meta, datei: `${angaben.jahr}/${angaben.art}/${angaben.name}__${hash.slice(0, 12)}`, sha256: hash }
            abgelegt.push(e)
            files.set(a.pfad(e), inhalt)
            return e
          }
        }
        archives.push(a)
        return a
      }
    }],
    ['./schutz', { synthetischerSchutz: true }],
    ['./angaben', require('../angaben.js')],
    ['./steuer', require('../steuer.js')],
    ['./uebersicht', require('../uebersicht.js')],
    ['./datenbank-index', require('../datenbank-index.js')],
    ['./persoenlich', require('../persoenlich.js')],
    ['./jahresarchiv', require('../jahresarchiv.js')],
    ['./verfahren', require('../verfahren.js')],
    ['./dsgvo', require('../dsgvo.js')],
    ['./profil', require('../profil.js')],
    ['./bisher', { EIGENE_NAMEN: [/synthetik/i, /muster/i], FIRMA: { name: 'Synthetik-Shop', zeilen: ['Teststraße 1 / Musterstadt', '12345 / Germany', 'test@example.test', 'example.test'], schluss: ['Empfänger: Erika Muster, IBAN: DE89370400440532013000,', 'Bank: Testbank, W-IdNr: DE123456789'] } }],
    ['./schluessel', { speicher(optionen) { usbAufrufe.push({ optionen }); return { status: () => ({ vorhanden: false }), neu: () => ({ schluessel: 'K', kennung: 'ID' }), bestaetigen: (e) => ({ bestaetigt: e }), eingeben: (e) => ({ eingegeben: e }), laden: () => 'GEHEIM' } } }],
    ['electron', { app: { getPath: (n) => path.join(syntheticHome, n) }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from('ENC:' + t), decryptString: (b) => String(b).slice(4) } }],
    ['./beleg-layout', { bildspeicherSetzen: () => {} }],
    ['./usb', { wiederherstellungTesten: async (o) => { usbAufrufe.push({ test: o }); return { ...testErgebnis } }, laufwerke: () => usbLaufwerke.slice(), planen: (o) => { usbAufrufe.push({ planen: o }); return { neu: 1 } }, sichern: async (o) => { usbAufrufe.push({ sichern: o }); return { ok: usbErgebnisOk, stand: 'S1', kennung: 'ID', neu: 1 } }, pruefen: async (o) => { usbAufrufe.push({ pruefen: o }); return { ok: true } }, persoenlichLesen: async (o) => { usbAufrufe.push({ persoenlichLesen: o }); return { stand: 'S1', erstellt: '2026-11-01T00:00:00.000Z', werte: { vorname: 'Vom', nachname: 'Stick', steuerId: '86095742719' } } } }],
    ['./zeitstempel', { versiegeln: async ({ archiv }) => ({ ok: true, archiv: archiv.WURZEL }), pruefen: ({ archiv }) => ({ ok: true, archiv: archiv.WURZEL, anzahl: 2, ergebnisse: [], zuletzt: { zeit: '2026-10-29T00:00:00Z' }, nochNichtVersiegelt: 3 }) }],
    ['./shirtigo', { einrichten() {}, verbinden: () => ({}), verbunden: () => false, probe: () => ({ werkzeuge: [], datei: 'synthetic' }) }],
    ['./host', require('../host.js')], // Vendo-Host mit dem Stub-require (electron, node:os)
    ['./shirtigo-bestellungen', emptyIntegration]
  ])
  const modul = { exports: {} }
  const source = require('node:fs').readFileSync(path.join(pluginFolder, 'haupt.js'), 'utf8')
  new Function('require', 'module', 'exports', '__dirname', source)(
    (name) => {
      if (!dependencies.has(name)) throw new Error(`unerwartetes require: ${name}`)
      return dependencies.get(name)
    }, modul, modul.exports, pluginFolder
  )
  const services = new Map()
  modul.exports({
    datenLaden: () => structuredClone(storedData),
    datenSpeichern(value) {
      if (saveFailure) {
        saveFailure = false
        throw new Error('synthetic storage failure')
      }
      storedData = structuredClone(value)
    },
    bereitstellen(name, fn) { services.set(name, fn) }
  })
  return { files, services, setups, archives, neuBerechnet, usbAufrufe, integritaetAsyncAufrufe, setArchivPruefung: (fn) => { archivPruefung = fn }, setTestErgebnis: (v) => { testErgebnis = v }, setUsbOk: (v) => { usbErgebnisOk = v }, setData: (v) => { storedData = structuredClone(v) }, setBusy: (value) => { busy = value }, storedData: () => structuredClone(storedData) }
}

const invoiceText = `Synthetic Vendor GmbH\nRechnungsnummer: TEST-MAIN-1\n04.10.2026\nArtikel 1 10,00 € 10,00 €\nNetto: 10,00 €\nMwSt. 1,90 €\nRechnungsbetrag: 11,90 €`

test('Main process registers services and handles text using synthetic storage', async () => {
  const app = createPluginHarness()
  const source = path.join(path.parse(process.cwd()).root, 'synthetic-input.PDF')
  app.files.set(path.resolve(source), 'synthetic pdf bytes')
  const entry = await app.services.get('hinzufuegen')({ pfad: source, name: 'synthetic-input.PDF' })

  assert.match(entry.id, /^r[0-9a-f]{20}$/)
  // Schritt 1.6: die PDF liegt im Belegarchiv (Art „eingang“), nicht mehr als Kopie unter daten/buchhaltung
  const archiv = app.archives[0]
  assert.equal(archiv.abgelegt.length, 1)
  assert.deepEqual([archiv.abgelegt[0].art, archiv.abgelegt[0].jahr, archiv.abgelegt[0].meta], ['eingang', new Date().getFullYear(), { quelle: 'pdf-eingang', eintrag: entry.id, name: 'synthetic-input.PDF' }])
  assert.deepEqual(entry.archiv, { datei: archiv.abgelegt[0].datei, sha256: archiv.abgelegt[0].sha256 })
  assert.equal(app.files.get(archiv.pfad(entry.archiv)), 'synthetic pdf bytes')
  assert.equal(app.files.has(path.join(dataFolder, `${entry.id}.pdf`)), false, 'keine Kopie mehr unter daten/buchhaltung')
  assert.equal(app.files.get(path.resolve(source)), 'synthetic pdf bytes', 'Quelle unberührt')
  assert.equal(app.storedData().dateien.length, 1)
  assert.equal((await app.services.get('liste')()).length, 1)
  assert.throws(() => app.services.get('textHolen')(entry.id), /noch kein Text/)
  app.files.set(path.join(dataFolder, `${entry.id}.txt`), invoiceText)
  assert.equal(app.services.get('textHolen')(entry.id), invoiceText)

  const updatedEntry = app.services.get('neuAuswerten')(entry.id)
  assert.equal(updatedEntry.rechnung.rechnungsnummer, 'TEST-MAIN-1')
  assert.equal(app.services.get('uebersicht')().gesamt.ausgaben, updatedEntry.rechnung.wirksam)
  assert.equal(app.services.get('integritaet')().archiv.ok, true)
  // Ausblenden statt Löschen (B14): Eintrag weg aus Liste und Summen, Beleg und Text bleiben
  assert.equal(app.services.has('loeschen'), false)
  assert.equal(app.services.get('ausblenden')(entry.id), true)
  const gespeichert = app.storedData().dateien
  assert.equal(gespeichert.length, 1)
  assert.match(gespeichert[0].ausgeblendet, /^\d{4}-\d\d-\d\dT/)
  assert.equal((await app.services.get('liste')()).length, 0)
  assert.equal(app.services.get('uebersicht')().gesamt.ausgaben, 0, 'ausgeblendete zählen nicht')
  assert.equal(app.files.get(archiv.pfad(entry.archiv)), 'synthetic pdf bytes', 'Beleg bleibt im Archiv')
  assert.equal(app.files.has(path.join(dataFolder, `${entry.id}.txt`)), true, 'Text bleibt')
  const zeit = gespeichert[0].ausgeblendet
  app.services.get('ausblenden')(entry.id)
  assert.equal(app.storedData().dateien[0].ausgeblendet, zeit, 'erneutes Ausblenden ändert den Zeitpunkt nicht')
})

test('Main process validates PDFs/IDs; after a storage failure the receipt stays archived and is found again (step 1.6)', async () => {
  const app = createPluginHarness({ failOnSave: true })
  const source = path.join(path.parse(process.cwd()).root, 'synthetic-rollback.PDF')
  app.files.set(path.resolve(source), 'synthetic pdf bytes')

  assert.throws(() => app.services.get('hinzufuegen')({ pfad: source, name: 'synthetic-rollback.PDF' }), /synthetic storage failure/)
  assert.equal(app.files.has(path.join(dataFolder, `${'r' + '42'.repeat(10)}.pdf`)), false)
  assert.equal(app.storedData().dateien.length, 0)
  assert.equal(app.archives[0].abgelegt.length, 1, 'Archivbelege werden nie zurückgenommen')
  const zweit = app.services.get('hinzufuegen')({ pfad: source, name: 'synthetic-rollback.PDF' })
  assert.deepEqual([zweit.schonImArchiv, zweit.archiv.datei, app.archives[0].abgelegt.length, app.storedData().dateien.length], [true, app.archives[0].abgelegt[0].datei, 1, 1])
  assert.throws(() => app.services.get('hinzufuegen')({ pfad: source, name: 'not-a-pdf.txt' }), /PDF-Datei/)
  await assert.rejects(app.services.get('scannen')('bad-id'), /PDF-Eintrag nicht gefunden/)
  assert.throws(() => app.services.get('neuAuswerten')('bad-id'), /PDF-Eintrag nicht gefunden/)
  assert.throws(() => app.services.get('ausblenden')('bad-id'), /PDF-Eintrag/)
  assert.throws(() => app.services.get('ausblenden')('r' + '0'.repeat(20)), /nicht gefunden/)
})

test('Archive path setting: default, validation, separation from work folder, no switch away from a filled archive (step 1.2)', () => {
  const app = createPluginHarness({ initialData: { dateien: [], einstellungen: { anderes: 'bleibt' } } })
  const standard = path.join(syntheticHome, 'Documents', 'Vendo-Archiv')
  assert.deepEqual(app.services.get('archivPfad')(), { pfad: standard, standard, eigen: false })

  const eigenerPfad = path.join(syntheticRoot, 'synthetic-archive')
  assert.equal(app.services.get('archivPfadSetzen')(eigenerPfad).pfad, eigenerPfad)
  assert.deepEqual(app.storedData().einstellungen, { anderes: 'bleibt', archivPfad: eigenerPfad })
  assert.equal(app.services.get('archivPfad')().eigen, true)

  const setzen = app.services.get('archivPfadSetzen')
  assert.throws(() => setzen('relativ/archiv'), /vollständigen Ordnerpfad/)
  assert.throws(() => setzen(syntheticRoot), /Laufwerk/)
  assert.throws(() => setzen(path.join(pluginFolder, 'archiv')), /Vendo-Ordner/)
  assert.throws(() => setzen(path.join(syntheticReceipts, 'Archiv')), /getrennt vom Arbeitsordner/)
  assert.throws(() => setzen(syntheticRoot + 'x'.repeat(300)), /vollständigen Ordnerpfad/)
  const datei = path.join(syntheticRoot, 'synthetic-file-not-folder')
  app.files.set(path.resolve(datei), 'x')
  assert.throws(() => setzen(datei), /Datei, kein Ordner/)

  app.files.set(path.join(eigenerPfad, 'index.jsonl'), '{"nr":1}\n') // aktuelles Archiv enthält Belege
  assert.throws(() => setzen(path.join(syntheticRoot, 'other-archive')), /nur über die geprüfte Migration/)
  assert.equal(setzen(eigenerPfad).pfad, eigenerPfad, 'gleicher Pfad bleibt erlaubt')
  assert.throws(() => setzen(null), /nur über die geprüfte Migration/, 'auch Zurück auf Standard ist dann gesperrt')
})

test('Saving receipt entries keeps settings; collective reset is no longer offered (step 1.2, B6)', async () => {
  const app = createPluginHarness({ initialData: { dateien: [], einstellungen: { archivPfad: path.join(syntheticRoot, 'kept-archive') } } })
  const source = path.join(syntheticRoot, 'synthetic-keep.PDF')
  app.files.set(path.resolve(source), 'synthetic pdf bytes')
  const entry = await app.services.get('hinzufuegen')({ pfad: source, name: 'synthetic-keep.PDF' })
  assert.equal(app.storedData().einstellungen.archivPfad, path.join(syntheticRoot, 'kept-archive'))
  app.services.get('ausblenden')(entry.id)
  assert.equal(app.storedData().einstellungen.archivPfad, path.join(syntheticRoot, 'kept-archive'))
  assert.equal(app.services.has('alleZuruecksetzen'), false)
})

test('View no longer contains the collective reset button or call (step 1.2, B6)', () => {
  const view = require('node:fs').readFileSync(path.join(pluginFolder, 'ansicht.js'), 'utf8')
  assert.equal(/data-zuruecksetzen|alleZuruecksetzen/.test(view), false)
})

test('Receipt archive is set up for Shopify and Shirtigo, sync state lives in plugin data, path change re-connects (step 1.5)', () => {
  const app = createPluginHarness({ initialData: { dateien: [{ id: 'r' + '42'.repeat(10), name: 'x.pdf' }], einstellungen: { anderes: 'bleibt' } } })
  const standard = path.join(syntheticHome, 'Documents', 'Vendo-Archiv')
  assert.equal(app.archives.length, 1)
  assert.equal(app.archives[0].WURZEL, standard)
  assert.deepEqual(app.archives[0].options.schutz, { synthetischerSchutz: true }, 'archive uses the Windows protection module')
  assert.equal(app.setups.bestellungen[0].archiv, app.archives[0])
  assert.equal(app.setups.shirtigo[0].archiv, app.archives[0], 'one shared archive')

  const stand = app.setups.bestellungen[0].stand
  assert.deepEqual(stand.lesen(), {})
  stand.schreiben({ seit: '2026-10-01T00:00:00Z' })
  assert.deepEqual(stand.lesen(), { seit: '2026-10-01T00:00:00Z' })
  const daten = app.storedData()
  assert.deepEqual([daten.abgleich, daten.einstellungen, daten.dateien.length], [{ shopify: { seit: '2026-10-01T00:00:00Z' } }, { anderes: 'bleibt' }, 1], 'sync state stored without losing other data')

  assert.deepEqual(app.services.get('integritaet')(), { archiv: { ok: true, geprueft: 0, wurzel: standard } })
  const eigen = path.join(syntheticRoot, 'synthetic-archive-15')
  app.setBusy(true)
  assert.throws(() => app.services.get('archivPfadSetzen')(eigen), /Abgleich läuft/)
  app.setBusy(false)
  app.services.get('archivPfadSetzen')(eigen)
  assert.equal(app.archives.at(-1).WURZEL, eigen)
  assert.equal(app.setups.bestellungen.at(-1).archiv, app.archives.at(-1))
  assert.equal(app.setups.shirtigo.at(-1).archiv, app.archives.at(-1))
  assert.equal(app.services.get('integritaet')().archiv.wurzel, eigen)
  assert.equal(app.storedData().abgleich.shopify.seit, '2026-10-01T00:00:00Z', 'path change keeps sync state')
})

test('Main process no longer uses the old per-source archives (step 1.5)', () => {
  const main = require('node:fs').readFileSync(path.join(pluginFolder, 'haupt.js'), 'utf8')
  assert.equal(/bestellungen\.ARCHIV|bestellungen\.integritaet|shirtigoB\.integritaet|pdfDateien|cacheLeeren/.test(main), false)
  const view = require('node:fs').readFileSync(path.join(pluginFolder, 'ansicht.js'), 'utf8')
  assert.equal(view.includes('Shirtigo: Unterordner shirtigo'), false)
})

test('Older entries without archive reference still work from daten/buchhaltung; hidden ones are not listed (step 1.6)', async () => {
  const alt = 'r' + 'ab'.repeat(10)
  const versteckt = 'r' + 'cd'.repeat(10)
  const app = createPluginHarness({ initialData: { dateien: [{ id: alt, name: 'alt.pdf' }, { id: versteckt, name: 'weg.pdf', ausgeblendet: '2026-10-29T00:00:00.000Z' }] } })
  app.files.set(path.join(dataFolder, `${alt}.pdf`), 'alte Kopie')
  app.files.set(path.join(dataFolder, `${versteckt}.pdf`), 'alte Kopie 2')
  assert.deepEqual((await app.services.get('liste')()).map((d) => d.id), [alt])
})

test('View hides instead of deleting and explains that the receipt stays archived (step 1.6, B14)', () => {
  const view = require('node:fs').readFileSync(path.join(pluginFolder, 'ansicht.js'), 'utf8')
  assert.equal(/data-loeschen|'loeschen'/.test(view), false)
  assert.equal((view.match(/data-ausblenden/g) || []).length, 3, 'two buttons + one handler')
  assert.ok(view.includes("ctx.aufrufen('ausblenden', id)"))
  assert.ok(view.includes('bleibt unverändert im Belegarchiv'))
})

test('Seal services use the current archive and refuse while a sync is running (step 1.7)', async () => {
  const app = createPluginHarness()
  const standard = path.join(syntheticHome, 'Documents', 'Vendo-Archiv')
  assert.deepEqual(await app.services.get('versiegeln')(), { ok: true, archiv: standard })
  assert.deepEqual([app.services.get('siegelPruefen')().ok, app.services.get('siegelPruefen')().archiv], [true, standard])
  app.setBusy(true)
  await assert.rejects(app.services.get('versiegeln')(), /Abgleich läuft/)
  app.setBusy(false)
  const view = require('node:fs').readFileSync(path.join(pluginFolder, 'ansicht.js'), 'utf8')
  assert.ok(view.includes("ctx.aufrufen('versiegeln')") && view.includes("ctx.aufrufen('siegelPruefen')"))
  assert.ok(view.includes('nur einen Prüfwert'), 'view explains that only a hash is sent')
})

test('Recovery key services: encrypted with safeStorage in the app user folder, key never in the status (step 1.8)', () => {
  const app = createPluginHarness()
  assert.equal(app.usbAufrufe.length, 0, 'no Electron access before first use')
  assert.deepEqual(app.services.get('usbSchluesselStatus')(), { vorhanden: false })
  assert.equal(app.usbAufrufe.length, 1)
  const { datei, tresor } = app.usbAufrufe[0].optionen
  assert.equal(datei, path.join(syntheticHome, 'userData', 'rechnungen-usb-schluessel.bin'))
  assert.equal(tresor.verfuegbar(), true)
  assert.equal(String(tresor.verschluesseln('x')), 'ENC:x', 'uses safeStorage.encryptString')
  assert.equal(tresor.entschluesseln(Buffer.from('ENC:y')), 'y')
  assert.deepEqual(app.services.get('usbSchluesselNeu')(), { schluessel: 'K', kennung: 'ID' })
  assert.deepEqual(app.services.get('usbSchluesselBestaetigen')('abc'), { bestaetigt: 'abc' })
  assert.equal(app.services.get('usbSchluesselEingeben')('x'.repeat(500)).eingegeben.length, 100, 'input length limited')
  assert.equal(app.services.has('usbSchluesselLaden'), false, 'the key itself is not offered to the view')
  assert.equal(app.usbAufrufe.length, 1, 'store created once')
  const view = require('node:fs').readFileSync(path.join(pluginFolder, 'ansicht.js'), 'utf8')
  for (const name of ['usbSchluesselStatus', 'usbSchluesselNeu', 'usbSchluesselBestaetigen', 'usbSchluesselEingeben']) assert.ok(view.includes(`ctx.aufrufen('${name}'`), name)
  assert.ok(view.includes('nicht</strong> beim USB-Stick'), 'sheet warns not to keep it with the stick')
})

test('USB backup services: only listed removable drives, confirmed key from the main process, result stored without data loss (step 1.9)', async () => {
  const app = createPluginHarness({ initialData: { dateien: [{ id: 'r' + '42'.repeat(10), name: 'x.pdf' }], einstellungen: { anderes: 'bleibt' } } })
  assert.deepEqual(app.services.get('usbLaufwerke')().map((l) => l.laufwerk), ['D:'])
  await assert.rejects(app.services.get('usbPlan')('C:'), /nicht gefunden/, 'internal disk is never a target')
  await assert.rejects(app.services.get('usbSichern')('Z:'), /nicht gefunden/)
  await app.services.get('usbPlan')('d:')
  const plan = app.usbAufrufe.find((x) => x.planen).planen
  assert.deepEqual([plan.wurzel, plan.wiederherstellungsschluessel, plan.freiBytes], ['D:\\', null, 10 ** 9], 'unconfirmed key is not passed')
  const r = await app.services.get('usbSichern')('D:')
  assert.deepEqual([r.ok, r.laufwerk.laufwerk], [true, 'D:'])
  const s = app.usbAufrufe.find((x) => x.sichern).sichern
  assert.deepEqual([s.wurzel, s.wiederherstellungsschluessel, s.archiv, s.freiBytes], ['D:\\', 'GEHEIM', app.archives[0], 10 ** 9], 'key loaded in the main process only')
  const d = app.storedData()
  assert.deepEqual([d.usb.stand, d.usb.kennung, d.usb.laufwerk, d.usb.letztesErgebnis, d.einstellungen.anderes, d.dateien.length], ['S1', 'ID', 'STICK', 'ok', 'bleibt', 1])
  assert.deepEqual([app.services.get('usbStatus')().tageSeit, app.services.get('usbStatus')().erinnern], [0, false])
  app.setUsbOk(false)
  const letzte = '2026-01-01T00:00:00.000Z' // festes altes Datum, damit der Vergleich eindeutig ist (nicht dieselbe Millisekunde)
  app.setData({ ...app.storedData(), usb: { ...app.storedData().usb, letzteSicherung: letzte } })
  await app.services.get('usbSichern')('D:')
  assert.deepEqual([app.storedData().usb.letztesErgebnis, app.storedData().usb.letzteSicherung], ['fehler', letzte], 'failed run does not count as backup')
  app.setBusy(true)
  await assert.rejects(app.services.get('usbSichern')('D:'), /Abgleich läuft/)
  app.setBusy(false)
  assert.equal((await app.services.get('usbPruefen')('D:')).ok, true)
})

test('USB reminder after 7 days (step 1.9)', () => {
  const alt = new Date(Date.now() - 8 * 86_400_000).toISOString()
  const app = createPluginHarness({ initialData: { dateien: [], usb: { letzteSicherung: alt, laufwerk: 'STICK' } } })
  assert.deepEqual([app.services.get('usbStatus')().tageSeit, app.services.get('usbStatus')().erinnern], [8, true])
  assert.equal(createPluginHarness().services.get('usbStatus')().erinnern, false, 'never backed up: no nagging')
})

test('Weekly maintenance check: runs when due (never or ≥ 7 days), otherwise returns the stored result; failures are stored (step 1.10)', async () => {
  const app = createPluginHarness({ initialData: { dateien: [], einstellungen: { anderes: 'bleibt' } } })
  const erst = await app.services.get('wartungLauf')()
  assert.deepEqual([erst.neu, erst.ok, erst.archiv.ok, erst.siegel.anzahl, erst.siegel.nochNichtVersiegelt], [true, true, true, 2, 3])
  assert.equal(app.integritaetAsyncAufrufe.length, 1, 'uses the non-blocking check')
  const zweit = await app.services.get('wartungLauf')()
  assert.deepEqual([zweit.neu, zweit.zeit, app.integritaetAsyncAufrufe.length], [false, erst.zeit, 1], 'not due again within 7 days')
  app.setArchivPruefung(() => ({ ok: false, geprueft: 5, letzterHash: 'H', fehler: ['Datei verändert: 2026/x.pdf', 'b', 'c', 'd', 'e', 'f'] }))
  const erzwungen = await app.services.get('wartungLauf')({ erzwingen: true })
  assert.deepEqual([erzwungen.neu, erzwungen.ok, erzwungen.archiv.anzahlFehler, erzwungen.archiv.fehler.length], [true, false, 6, 5])
  const d = app.storedData()
  assert.deepEqual([d.wartung.ok, d.einstellungen.anderes], [false, 'bleibt'])
  // 8 Tage alt → wieder fällig
  app.setData({ ...app.storedData(), wartung: { ...app.storedData().wartung, zeit: new Date(Date.now() - 8 * 86_400_000).toISOString() } })
  assert.equal((await app.services.get('wartungLauf')()).neu, true)
})

test('Restore test: stick from the list, key from the main process, test report archived as pruefbericht, result stored (step 1.10)', async () => {
  const app = createPluginHarness()
  await assert.rejects(app.services.get('wiederherstellungTesten')('C:'), /nicht gefunden/)
  const r = await app.services.get('wiederherstellungTesten')('D:')
  assert.deepEqual([r.ok, r.dateien, r.laufwerk.laufwerk], [true, 1439, 'D:'])
  const aufruf = app.usbAufrufe.find((x) => x.test).test
  assert.deepEqual([aufruf.wurzel, aufruf.wiederherstellungsschluessel], ['D:\\', 'GEHEIM'])
  const bericht = app.archives[0].abgelegt.at(-1)
  assert.deepEqual([bericht.art, bericht.jahr, bericht.meta], ['pruefbericht', 2026, { vorgang: 'wiederherstellungstest', ok: true, stand: 'S1.vsb' }])
  assert.equal(r.bericht, bericht.datei)
  const inhalt = JSON.parse(app.files.get(app.archives[0].pfad(bericht)))
  assert.deepEqual([inhalt.ok, inhalt.dateien, inhalt.laufwerk, inhalt.tempGeloescht], [true, 1439, 'STICK', true])
  assert.equal(JSON.stringify(inhalt).includes('GEHEIM'), false, 'no key in the report')
  assert.deepEqual(app.storedData().usb.letzterWiederherstellungstest, { zeit: '2026-10-29T12:00:00.000Z', ok: true, stand: 'S1.vsb', dateien: 1439 })
  app.setTestErgebnis({ ok: false, zeit: '2026-10-30T12:00:00.000Z', fehler: ['Inhalt stimmt nicht'], dateien: 0, bytes: 0, tempGeloescht: true })
  const f = await app.services.get('wiederherstellungTesten')('D:')
  assert.deepEqual([f.ok, f.fehler[0], app.storedData().usb.letzterWiederherstellungstest.ok], [false, 'Inhalt stimmt nicht', false])
})

test('Archive status summarises check, seals, USB, restore test and key without secrets (step 1.10)', async () => {
  const alt = new Date(Date.now() - 400 * 86_400_000).toISOString()
  const app = createPluginHarness({ initialData: { dateien: [], usb: { letzteSicherung: new Date().toISOString(), laufwerk: 'STICK', letztesErgebnis: 'ok', letzterWiederherstellungstest: { zeit: alt, ok: true, dateien: 9 } } } })
  let s = app.services.get('archivStatus')()
  assert.deepEqual([s.archiv.eintraege, s.pruefung.faellig, s.usb.tageSeit, s.usb.laufwerk, s.wiederherstellungstest.faellig, s.wiederherstellungstest.tageSeit, s.schluessel.bestaetigt], [0, true, 0, 'STICK', true, 400, false])
  await app.services.get('wartungLauf')()
  s = app.services.get('archivStatus')()
  assert.deepEqual([s.pruefung.faellig, s.pruefung.tageSeit, s.pruefung.siegel.anzahl], [false, 0, 2])
  assert.equal(JSON.stringify(s).includes('GEHEIM'), false)
  const view = require('node:fs').readFileSync(path.join(pluginFolder, 'ansicht.js'), 'utf8')
  for (const name of ['archivStatus', 'wartungLauf', 'wiederherstellungTesten']) assert.ok(view.includes(`ctx.aufrufen('${name}'`), name)
  assert.ok(view.includes('setTimeout(wartungPruefen, 120_000)') && view.includes('setInterval(wartungPruefen, 6 * 3_600_000)'), 'background check scheduled')
})

test('Meine Angaben: proposal only while nothing is saved, invalid formats are not saved, changes are logged with date, other data kept (step 2.1)', () => {
  const app = createPluginHarness({ initialData: { dateien: [{ id: 'r' + '42'.repeat(10), name: 'x.pdf' }], einstellungen: { anderes: 'bleibt' }, usb: { laufwerk: 'STICK' } } })
  const erst = app.services.get('angabenLaden')()
  assert.equal(erst.gespeichert, false)
  assert.equal(erst.felder.length, require('../angaben.js').FELDER.length) // M.4: gegen die Feldliste, nicht gegen eine feste Zahl
  assert.ok(erst.felder.length >= 29)
  assert.deepEqual([erst.werte.land, erst.vorschau, erst.pruefung.vollstaendig], ['DE', `RE-${new Date().getFullYear()}-0001`, false])
  assert.deepEqual([erst.vorschlag.firmenname, erst.vorschlag.iban, erst.vorschlag.wId, erst.vorschlag.eigeneNamen], ['Synthetik-Shop', 'DE89370400440532013000', 'DE123456789', ['Synthetik', 'Muster']], 'proposal from bisher.js (stub)')
  assert.equal(erst.archiv.pfad, path.join(syntheticHome, 'Documents', 'Vendo-Archiv'))

  const falsch = app.services.get('angabenSpeichern')({ ...erst.vorschlag, iban: 'DE89370400440532013001' })
  assert.deepEqual([falsch.ok, Object.keys(falsch.pruefung.fehler)], [false, ['iban']])
  assert.equal(app.storedData().angaben, undefined, 'nothing saved with a format error')

  const gut = app.services.get('angabenSpeichern')({ ...erst.vorschlag, eigeneNamen: ['Synthetik', 'Muster', 'Synthetik'], geheim: 'x' })
  assert.equal(gut.ok, true)
  const d = app.storedData()
  assert.deepEqual([d.angaben.firmenname, d.angaben.eigeneNamen, 'geheim' in d.angaben, d.einstellungen.anderes, d.usb.laufwerk, d.dateien.length], ['Synthetik-Shop', ['Synthetik', 'Muster'], false, 'bleibt', 'STICK', 1])
  assert.equal(d.angabenVerlauf.length, 1)
  assert.ok(d.angabenVerlauf[0].aenderungen.some((x) => x.feld === 'iban' && x.alt === null && x.neu === 'DE89370400440532013000'))

  const nochmal = app.services.get('angabenSpeichern')(d.angaben)
  assert.deepEqual([nochmal.ok, nochmal.geaendert, app.storedData().angabenVerlauf.length], [true, 0, 1], 'unchanged → no new log entry')
  const geaendert = app.services.get('angabenSpeichern')({ ...d.angaben, naechsteNummer: '12' })
  assert.deepEqual([geaendert.geaendert, app.storedData().angabenVerlauf.at(-1).aenderungen], [1, [{ feld: 'naechsteNummer', alt: '1', neu: '12' }]])
  const danach = app.services.get('angabenLaden')()
  assert.deepEqual([danach.gespeichert, danach.vorschlag, danach.vorschau, danach.verlauf.length], [true, null, `RE-${new Date().getFullYear()}-0012`, 2])
  assert.throws(() => app.services.get('angabenSpeichern')(['x']), /Ungültige Angaben/)
})

test('Steuerstatus je Zeitraum: Vorschlag aus der Shopify-Steuer bis zum Speichern, Abgleich danach, Fehler blockieren das Speichern (step 2.2)', () => {
  const befund = [
    { nr: '9001', datum: '2024-03-30', steuer: 0, brutto: 20, storniert: false },
    { nr: '9002', datum: '2024-04-03', steuer: 3.8, brutto: 23.8, storniert: false },
    { nr: '9003', datum: '2024-05-28', steuer: 1.9, brutto: 11.9, storniert: false },
    { nr: '9004', datum: '2024-06-02', steuer: 0, brutto: 20, storniert: false }
  ]
  const ohneDaten = createPluginHarness().services.get('angabenLaden')()
  assert.deepEqual([ohneDaten.steuer.daten, ohneDaten.steuer.vorschlag, ohneDaten.steuer.abgleich, ohneDaten.werte.steuerzeitraeume], [false, null, null, []], 'archive not readable → no proposal, no crash')
  assert.deepEqual(ohneDaten.steuerarten, { klein: 'Kleinunternehmer (§ 19 UStG)', regel: 'Regelbesteuerung' })

  const app = createPluginHarness({ steuerBefund: befund })
  const erst = app.services.get('angabenLaden')()
  assert.deepEqual([erst.steuer.daten, erst.steuer.bestellungen, erst.steuer.vorschlag.anzahl, erst.steuer.vorschlag.von, erst.steuer.vorschlag.bis, erst.steuer.vorschlag.satz], [true, 4, 2, '2024-04-03', '2024-05-28', 19])
  assert.ok(erst.pruefung.fehlend.includes('steuerzeitraeume'), 'missing tax status is reported as required')
  assert.equal(app.storedData().angaben, undefined, 'the proposal alone saves nothing')

  const kaputt = app.services.get('angabenSpeichern')({ ...erst.vorschlag, steuerzeitraeume: [{ von: '', bis: '2024-04-01', art: 'klein' }, { von: '2024-04-03', bis: '', art: 'regel', satz: '19' }] })
  assert.deepEqual([kaputt.ok, kaputt.pruefung.fehler.steuerzeitraeume], [false, 'Zwischen 01.04.2024 und 03.04.2024 fehlt ein Zeitraum.'])
  assert.equal(app.storedData().angaben, undefined)

  const gut = app.services.get('angabenSpeichern')({ ...erst.vorschlag, steuerzeitraeume: erst.steuer.vorschlag.zeitraeume })
  assert.equal(gut.ok, true)
  assert.deepEqual(app.storedData().angaben.steuerzeitraeume.map((z) => [z.von, z.bis, z.art, z.satz]), [['', '2024-04-02', 'klein', null], ['2024-04-03', '2024-05-28', 'regel', 19], ['2024-05-29', '', 'klein', null]])
  assert.ok(app.storedData().angabenVerlauf.at(-1).aenderungen.some((x) => x.feld === 'steuerzeitraeume'), 'confirmation is logged with date')
  const danach = app.services.get('angabenLaden')()
  assert.deepEqual([danach.steuer.vorschlag, danach.pruefung.fehlend.includes('steuerzeitraeume')], [null, false], 'no proposal once confirmed')
  assert.deepEqual([danach.steuer.abgleich.geprueft, danach.steuer.abgleich.steuerTrotzKlein, danach.steuer.abgleich.ohneSteuerBeiRegel], [4, [], []])

  const anders = app.services.get('angabenSpeichern')({ ...app.storedData().angaben, steuerzeitraeume: [{ von: '', bis: '', art: 'klein' }] })
  assert.equal(anders.ok, true)
  assert.deepEqual(app.services.get('angabenLaden')().steuer.abgleich.steuerTrotzKlein.map((x) => x.nr), ['9002', '9003'], 'orders with tax although small business are flagged')
})

test('Meine Angaben gelten sofort (Schritt 2.3): Vorschlag nur für leere Felder, nach dem Speichern Neuberechnung, eingelesene PDFs neu ausgewertet', async () => {
  const profil = require('../profil.js')
  const steuer = [{ von: '', bis: '2024-03-03', art: 'klein', satz: null }, { von: '2024-03-04', bis: '2024-04-12', art: 'regel', satz: 19 }, { von: '2024-04-13', bis: '', art: 'klein', satz: null }]
  // wie auf dem echten PC: nur der Steuerstatus ist gespeichert
  const app = createPluginHarness({ initialData: { dateien: [], angaben: { land: 'DE', hinweis19: 'Steuerfrei.', nummernFormat: 'RE-{JJJJ}-{NNNN}', naechsteNummer: '1', steuerzeitraeume: steuer } } })
  assert.deepEqual([profil.steuerAm('2024-04-01').art, profil.eigenerShop(), profil.vollstaendig()], ['regel', 'Eigener Shop', false], 'beim Start aus den Plugin-Daten gesetzt')
  const erst = app.services.get('angabenLaden')()
  assert.equal(erst.gespeichert, true)
  assert.deepEqual(Object.keys(erst.vorschlag).sort(), ['email', 'eigeneNamen', 'firmenname', 'iban', 'inhaber', 'kontoinhaber', 'ort', 'plz', 'strasse', 'website', 'wId', 'bank'].sort(), 'Vorschlag trotz gespeicherter Angaben, aber nur für leere Felder (nicht Land/Steuerstatus)')

  const id = 'r' + '42'.repeat(10)
  app.files.set(path.join(dataFolder, `${id}.txt`), ['Synthetik Handel GmbH', 'Rechnungsnummer: TEST-1', '05.03.2026', 'Service 1 100,00 € 100,00 €', 'Netto: 100,00 €', 'USt. 19,00 €', 'Rechnungsbetrag: 119,00 €', 'Paid'].join('\n'))
  app.files.set(path.join(dataFolder, `${id}.pdf`), 'synthetic pdf')
  const alt = parser.parseRechnung(app.files.get(path.join(dataFolder, `${id}.txt`)))
  assert.equal(alt.art, 'ausgabe', 'vorher: eigener Name unbekannt')
  app.setData({ ...app.storedData(), dateien: [{ id, name: 'x.pdf', scanStand: 1, rechnung: alt }] })

  const r = app.services.get('angabenSpeichern')({ ...erst.werte, ...erst.vorschlag, steuernummer: '123/456/78901' })
  assert.deepEqual([r.ok, r.pruefung.vollstaendig], [true, true])
  assert.deepEqual(app.neuBerechnet, ['shopify', 'shirtigo'], 'Shopify- und Shirtigo-Einträge werden neu berechnet')
  assert.deepEqual([profil.eigenerShop(), profil.vollstaendig(), profil.istEigen('Synthetik Handel GmbH')], ['Synthetik-Shop', true, true])
  assert.equal(app.services.get('angabenLaden')().vorschlag, null, 'alles ausgefüllt → kein Vorschlag mehr')
  const liste = await app.services.get('liste')()
  assert.equal(liste.find((d) => d.id === id).rechnung.art, 'einnahme', 'gespeicherter Text mit den neuen Angaben neu ausgewertet')
  assert.equal(app.storedData().dateien[0].rechnung.profil, profil.stand())
  profil.setzen(null)
})

test('Umsatz je Jahr (Schritt 4.2): Shopify aus dem Archiv plus eigene Einnahmen, ein Shop-Beleg zur selben Bestellung zählt nicht doppelt', async () => {
  const z = (datum, betrag) => ({ bekannt: true, datum, eingaenge: [{ datum, betrag }], erstattungen: [] })
  const shop = { anbieter: 'shopify-api', art: 'einnahme', referenz: '9001', datum: '2025-12-31', wirksam: 40, summen: { brutto: 40, mwst: 0 }, zahlung: z('2026-01-02', 40) }
  const id1 = 'r' + '11'.repeat(10)
  const id2 = 'r' + '22'.repeat(10)
  const id3 = 'r' + '33'.repeat(10)
  const app = createPluginHarness({
    shopEintraege: [{ id: 's9001', rechnung: shop }],
    initialData: { dateien: [
      { id: id1, name: 'a.pdf', rechnung: { anbieter: 'shopify-bestellung', art: 'einnahme', referenz: '9001', datum: '2025-12-31', wirksam: 40, summen: { brutto: 40 } } }, // dieselbe Bestellung als PDF
      { id: id2, name: 'b.pdf', rechnung: { anbieter: 'shop-rechnung', art: 'einnahme', referenz: '7777', datum: '2025-05-05', wirksam: 100, summen: { brutto: 100 } } },
      { id: id3, name: 'c.pdf', ausgeblendet: '2026-01-01T00:00:00Z', rechnung: { anbieter: 'shop-rechnung', art: 'einnahme', referenz: '8888', datum: '2025-05-06', wirksam: 500, summen: { brutto: 500 } } }
    ] }
  })
  const { jahre } = app.services.get('umsatzJahre')()
  assert.deepEqual(jahre.map((j) => [j.jahr, j.umsatz, j.bestellungen, j.sonstige, j.nachBestelldatum]), [['2026', 40, 1, 0, 0], ['2025', 100, 0, 1, 140]], 'Bestellung zählt im Zahlungsjahr 2026, PDF-Duplikat und ausgeblendeter Beleg zählen nicht')
  const view = require('node:fs').readFileSync(path.join(pluginFolder, 'ansicht.js'), 'utf8')
  assert.ok(view.includes("ctx.aufrufen('umsatzJahre')"), 'Ansicht nutzt den Dienst')
})

test('Grenzwert-Wächter im Dienst (Schritt 4.3): laufendes Jahr nach Berliner Datum, Warnung, wenn der Steuerstatus noch Kleinunternehmer sagt', () => {
  const bezahlt = (nr, datum, betrag) => ({ id: 's' + nr, rechnung: { anbieter: 'shopify-api', art: 'einnahme', referenz: String(nr), datum, wirksam: betrag, summen: { brutto: betrag, mwst: 0 }, empfaenger: { land: 'DE' }, zahlung: { bekannt: true, datum, eingaenge: [{ datum, betrag }], erstattungen: [] } } })
  const klein = [{ von: '', bis: '', art: 'klein', satz: null }]
  const ueber = [bezahlt(1, '2024-03-01', 100), bezahlt(2, '2025-05-01', 25000.01), bezahlt(3, '2026-02-01', 50)]
  const app = createPluginHarness({ shopEintraege: ueber, initialData: { dateien: [], angaben: { steuerzeitraeume: klein } } })
  const r = app.services.get('umsatzJahre')({ heute: '2026-03-01' })
  assert.deepEqual([r.heute, r.waechter.jahr, r.waechter.stufe, r.waechter.kleinunternehmer, r.statusPasst], ['2026-03-01', '2026', 'rot', false, false], 'Vorjahr über 25.000 €, Steuerstatus sagt noch Kleinunternehmer')
  const regel = createPluginHarness({ shopEintraege: ueber, initialData: { dateien: [], angaben: { steuerzeitraeume: [{ von: '', bis: '2025-12-31', art: 'klein', satz: null }, { von: '2026-01-01', bis: '', art: 'regel', satz: 19 }] } } })
  assert.equal(regel.services.get('umsatzJahre')({ heute: '2026-03-01' }).statusPasst, true, 'Steuerstatus schon umgestellt')
  const gut = createPluginHarness({ shopEintraege: [bezahlt(1, '2024-03-01', 100), bezahlt(2, '2025-05-01', 25000)], initialData: { dateien: [], angaben: { steuerzeitraeume: klein } } })
  const g = gut.services.get('umsatzJahre')({ heute: '2026-03-01' })
  assert.deepEqual([g.waechter.stufe, g.statusPasst], ['gruen', true])
  assert.equal(gut.services.get('umsatzJahre')({ heute: 'kaputt' }).heute.length, 10, 'ungültiges Datum → heute')
})

test('§ 13b-Dienste (Schritt 4.4): Kennzeichen je Beleg, Einstufung je Lieferant, Monat angemeldet, Steuer zählt als Ausgabe in Liste und Übersicht', async () => {
  const id1 = 'r' + 'a1'.repeat(10)
  const id2 = 'r' + 'b2'.repeat(10)
  const r = (lieferant, datum, netto, extra = {}) => ({ art: 'ausgabe', lieferant, datum, waehrung: 'EUR', summen: { netto, mwst: 0, brutto: netto }, wirksam: netto, wirksamArt: 'inkl. MwSt', version: parser.VERSION, ...extra })
  const app = createPluginHarness({ initialData: { dateien: [
    { id: id1, name: 'meta.pdf', rechnung: r('Meta Platforms Ireland Limited', '2026-09-30', 100, { reverseCharge: true, herkunft: 'eu' }) },
    { id: id2, name: 'viva.pdf', rechnung: r('Viva Wallet', '2026-09-15', 12) }
  ] } })
  for (const id of [id1, id2]) app.files.set(path.join(dataFolder, `${id}.pdf`), 'synthetic pdf')
  let u = app.services.get('p13bUebersicht')({ heute: '2026-10-13' })
  assert.deepEqual([u.faelle.length, u.faelle.filter((x) => x.fall).length, u.monate.map((x) => [x.monat, x.steuer, x.ueberfaellig]), u.lieferanten.map((x) => x.lieferant)], [2, 1, [['2026-09', 19, true]], ['Meta Platforms Ireland Limited']])

  const liste = await app.services.get('liste')()
  const meta = liste.find((d) => d.id === id1).rechnung
  assert.deepEqual([meta.wirksam, meta.wirksamArt, meta.p13b.steuer], [119, 'inkl. § 13b-Steuer', 19], 'Steuer zählt zusätzlich als Ausgabe')
  assert.equal(app.services.get('uebersicht')().gesamt.ausgaben, 131, '100 + 19 + 12')
  assert.equal(app.storedData().dateien[0].rechnung.wirksam, 100, 'gespeichert bleibt der Rechnungsbetrag')

  assert.deepEqual(app.services.get('p13bSetzen')(id2, { aktiv: true, monat: '2026-10' }), { aktiv: true, monat: '2026-10' })
  u = app.services.get('p13bUebersicht')({ heute: '2026-10-13' })
  assert.deepEqual(u.lieferanten.map((x) => [x.lieferant, x.vermutetFrei]), [['Meta Platforms Ireland Limited', false], ['Viva Wallet', true]])
  assert.deepEqual(u.monate.map((x) => [x.monat, x.steuerfrei, x.steuer]), [['2026-10', 1, 0], ['2026-09', 0, 19]], 'Zahlungsdienst vermutlich steuerfrei')
  assert.deepEqual(app.services.get('p13bAnbieter')('Viva Wallet', { einstufung: 'steuerpflichtig', herkunft: 'quatsch' }), { einstufung: 'steuerpflichtig' })
  assert.equal(app.services.get('p13bUebersicht')({ heute: '2026-10-13' }).monate[0].steuer, 2.28)
  assert.equal(app.services.get('p13bAnbieter')('Viva Wallet', {}), null, 'zurück auf automatisch')
  assert.equal(app.storedData().p13bAnbieter['Viva Wallet'], undefined)

  assert.deepEqual(app.services.get('p13bAngemeldet')('2026-09', '2026-10-08'), { am: '2026-10-08' })
  assert.deepEqual(app.services.get('p13bUebersicht')({ heute: '2026-10-13' }).monate.find((x) => x.monat === '2026-09').ueberfaellig, false)
  assert.equal(app.services.get('p13bAngemeldet')('2026-09', null), null)

  assert.equal(app.services.get('p13bSetzen')(id1, { aktiv: false }).aktiv, false)
  assert.equal((await app.services.get('liste')()).find((d) => d.id === id1).rechnung.p13b, undefined, 'abgewählt: kein § 13b')
  assert.equal(app.services.get('p13bSetzen')(id1, {}), null, 'leere Angaben → Eintrag entfernt (wieder automatisch)')
  assert.equal('p13b' in app.storedData().dateien[0], false)
  assert.equal(app.services.get('p13bSetzen')(id1, { aktiv: true, betragEur: '46,10' }).betragEur, 46.1)

  assert.throws(() => app.services.get('p13bSetzen')('r' + 'ff'.repeat(10), { aktiv: true }), /Beleg nicht gefunden/)
  assert.throws(() => app.services.get('p13bSetzen')(id1, { monat: '2026-13' }), /Monat/)
  assert.throws(() => app.services.get('p13bSetzen')(id1, { betragEur: '-5' }), /Euro-Betrag/)
  assert.throws(() => app.services.get('p13bAngemeldet')('2026-9', '2026-10-01'), /Ungültiger Monat/)
  assert.throws(() => app.services.get('p13bAngemeldet')('2026-09', 'gestern'), /Ungültiges Datum/)
  assert.throws(() => app.services.get('p13bAnbieter')('', { einstufung: 'steuerfrei' }), /Ungültiger Lieferant/)
})

test('Dashboard-Dienste (Schritt 4.5): Aufgaben aus Angaben/Archiv/§ 13b, EÜR je Jahr, Jahresaufgaben abhaken, rote Aufgaben einmal am Tag melden', () => {
  const id1 = 'r' + 'a1'.repeat(10)
  const bezahlt = (nr, datum, betrag, beleg = true) => ({ id: 's' + nr, beleg: beleg ? { pdf: 'x' } : undefined, rechnung: { anbieter: 'shopify-api', art: 'einnahme', referenz: String(nr), datum, wirksam: betrag, summen: { brutto: betrag, mwst: 0 }, empfaenger: { land: 'DE' }, zahlung: { bekannt: true, datum, eingaenge: [{ datum, betrag }], erstattungen: [] } } })
  const app = createPluginHarness({
    shopEintraege: [bezahlt(1, '2025-05-01', 200), bezahlt(2, '2026-09-01', 50, false)],
    initialData: { dateien: [{ id: id1, name: 'meta.pdf', rechnung: { art: 'ausgabe', lieferant: 'Meta Platforms Ireland Limited', datum: '2026-09-30', waehrung: 'EUR', summen: { netto: 100, mwst: 0, brutto: 100 }, wirksam: 100, reverseCharge: true, herkunft: 'eu' } }] }
  })
  const d = app.services.get('dashboard')({ heute: '2026-10-29' })
  assert.equal(d.heute, '2026-10-29')
  assert.deepEqual(d.aufgaben.map((a) => [a.schluessel, a.stufe]), [
    ['euer-2025', 'rot'], ['p13b-2026-09', 'rot'], ['angaben', 'rot'], ['usb', 'gelb'], ['wiederherstellungstest', 'gelb'], ['konto-2025', 'info']
  ], 'Pflichtangaben fehlen und ein Umsatzbeleg wartet → rot; § 13b 09.2026 überfällig; keine USB-Sicherung')
  assert.deepEqual(d.euer.map((j) => [j.jahr, j.kz111, j.sonstige, j.kz186, j.gewinn]), [['2026', 50, 100, 19, -69], ['2025', 200, 0, 0, 200]], '§ 13b-Steuer 09.2026 im Jahr der Fälligkeit (Oktober 2026)')

  assert.equal(app.services.get('aufgabeErledigt')('euer-2025', '2026-10-29'), '2026-10-29')
  const nachher = app.services.get('dashboard')({ heute: '2026-10-29' })
  assert.deepEqual([nachher.aufgaben.some((a) => a.schluessel === 'euer-2025'), nachher.erledigt], [false, { 'euer-2025': '2026-10-29' }])
  assert.equal(app.services.get('aufgabeErledigt')('euer-2025', null), null)
  assert.throws(() => app.services.get('aufgabeErledigt')('usb', '2026-10-29'), /kann nicht abgehakt/)
  assert.throws(() => app.services.get('aufgabeErledigt')('konto-2025', 'heute'), /Ungültiges Datum/)

  const erst = app.services.get('aufgabenMelden')({ heute: '2026-10-29' })
  assert.deepEqual(erst.map((a) => a.schluessel), ['euer-2025', 'p13b-2026-09', 'angaben'], 'nur rote Aufgaben')
  assert.deepEqual(app.services.get('aufgabenMelden')({ heute: '2026-10-29' }), [], 'am selben Tag nicht noch einmal')
  assert.equal(app.services.get('aufgabenMelden')({ heute: '2026-10-30' }).length, 3, 'am nächsten Tag wieder')
  app.services.get('p13bAngemeldet')('2026-09', '2026-10-30')
  app.services.get('aufgabenMelden')({ heute: '2026-10-31' })
  assert.equal('p13b-2026-09' in app.storedData().aufgabenGemeldet, false, 'erledigte Aufgaben werden vergessen')
})


test('Persönliche Angaben (Plan 11.3, M.2): nur verschlüsselt gespeichert, Steuer-ID geprüft, ungültige Eingaben nicht gespeichert', () => {
  const app = createPluginHarness()
  assert.equal(app.services.get('persoenlichLaden')().gespeichert, false)
  const falsch = app.services.get('persoenlichSpeichern')({ vorname: 'Erika', steuerId: '12345678901' })
  assert.equal(falsch.ok, false)
  assert.equal(falsch.pruefung.fehler[0].feld, 'steuerId')
  assert.equal(app.storedData().persoenlich, undefined)
  const ok = app.services.get('persoenlichSpeichern')({ vorname: ' Erika ', nachname: 'Muster', steuerId: '86095742719', religion: 'keine', veranlagung: 'unsinn' })
  assert.equal(ok.ok, true)
  const roh = app.storedData().persoenlich
  assert.equal(typeof roh, 'string')
  assert.ok(Buffer.from(roh, 'base64').toString().startsWith('ENC:'), 'über safeStorage verschlüsselt')
  const geladen = app.services.get('persoenlichLaden')()
  assert.equal(geladen.gespeichert, true)
  assert.equal(geladen.werte.vorname, 'Erika')
  assert.equal(geladen.werte.veranlagung, '') // ungültige Auswahl wird leer
  assert.equal(app.storedData().angaben, undefined, 'Firmendaten bleiben unberührt')
})

test('P-2: USB-Sicherung nimmt die persönlichen Angaben mit; Rückholung vom Stick nur, wenn noch keine gespeichert sind', async () => {
  const app = createPluginHarness()
  await app.services.get('usbSichern')('D:')
  assert.equal(app.usbAufrufe.find((x) => x.sichern).sichern.persoenlich, null, 'ohne gespeicherte Angaben nichts mitgeben')
  const zurueck = await app.services.get('persoenlichVomStick')('D:')
  assert.deepEqual([zurueck.ok, zurueck.stand, zurueck.felder], [true, 'S1', 3])
  assert.ok(Buffer.from(app.storedData().persoenlich, 'base64').toString().startsWith('ENC:'), 'zurückgeholt wieder nur verschlüsselt')
  assert.equal(app.services.get('persoenlichLaden')().werte.nachname, 'Stick')
  await assert.rejects(app.services.get('persoenlichVomStick')('D:'), /nicht überschrieben/)
  app.usbAufrufe.length = 0
  await app.services.get('usbSichern')('D:')
  assert.deepEqual(app.usbAufrufe.find((x) => x.sichern).sichern.persoenlich?.vorname, 'Vom', 'gespeicherte Angaben gehen entschlüsselt nur an usb.sichern')
})

test('Bereiche im Menü (M.1): nur Bestellungen, Rechnungen und Steuer ausblendbar', () => {
  const app = createPluginHarness()
  assert.deepEqual(app.services.get('menueLaden')(), { ausblendbar: ['bestellungen', 'rechnungen', 'steuer'], aus: [] })
  assert.deepEqual(app.services.get('menueSpeichern')(['steuer', 'uebersicht', 'angaben', 'steuer', 'quatsch']).aus, ['steuer'])
  assert.deepEqual(app.storedData().menue, { aus: ['steuer'] })
  assert.deepEqual(app.services.get('menueLaden')().aus, ['steuer'])
})

test('ELSTER-Übersicht (M.5): Hauptvordruck aus den persönlichen Angaben, Anlage nach Einkunftsart, Kennzahlen der EÜR', () => {
  const app = createPluginHarness()
  app.services.get('persoenlichSpeichern')({ vorname: 'Erika', nachname: 'Muster', steuerId: '47036892816', religion: 'keine' })
  const u = app.services.get('elsterUebersicht')({ heute: '2026-10-29' })
  assert.ok(Array.isArray(u.jahre))
  assert.deepEqual(u.hauptvordruck.slice(0, 2), [{ label: 'Steuer-ID', wert: '47036892816' }, { label: 'Name', wert: 'Erika Muster' }])
  assert.ok(!u.hauptvordruck.some((z) => z.label.startsWith('Ehegatte')), 'ohne Ehegatte keine Ehegatten-Zeilen')
  assert.match(u.gewinn.anlage, /Anlage G oder S/)
  assert.match(u.hinweis, /ohne Gewähr/i)
})

test('Prüfwert (E.2): Kopf der Hash-Kette, ungültige Eingaben werden abgewiesen', () => {
  const app = createPluginHarness()
  assert.deepEqual(app.services.get('pruefwertVergleichen')('abc'), { gueltig: false })
  const v = app.services.get('pruefwertVergleichen')('a'.repeat(64))
  assert.equal(v.gueltig, true)
  assert.equal(v.bekannt, false)
  assert.equal(typeof app.services.get('pruefwert')().eintraege, 'number')
})

test('Datenbank-Dienste ohne Datenbank (Plan 11.2): melden „aus“ statt zu scheitern', async () => {
  const app = createPluginHarness()
  const s = await app.services.get('datenbankStatus')()
  assert.equal(s.zustand.zustand, 'aus')
  assert.equal(s.index, null)
  assert.equal((await app.services.get('datenbankAufbauen')()).ok, false)
  assert.equal(await app.services.get('datenbankJahre')(), null)
})
