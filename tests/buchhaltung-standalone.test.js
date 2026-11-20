import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// Tests für den eigenständigen Betrieb (plugins/buchhaltung/standalone/server.js): Start auf freiem Port, Sitzungs-Token,
// Schutz gegen fremde Seiten, Passwort-Tresor, Daten als JSON-Datei, PDF-Upload, Downloads. Echte haupt.js mit echtem
// Archiv in einem Temp-Datenordner; nur synthetische Werte, kein Shopify, kein Shirtigo, kein Netz außer 127.0.0.1.

const require = createRequire(import.meta.url)
const { starten } = require('../standalone/server.js')
const { jsonSpeicher } = require('../standalone/speicher.js')
const schutz = require('../schutz.js')

const PASSWORT = 'synthetisches-test-passwort'
const PDF = Buffer.from('%PDF-1.4\n% synthetischer Testbeleg\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')

function datenordner(t) {
  const o = fs.mkdtempSync(path.join(os.tmpdir(), 'vendo-standalone-test-'))
  t.after(() => {
    // Das Archiv ist unter Windows per NTFS geschützt: für das Aufräumen wieder freigeben
    const alle = (x) => (fs.existsSync(x) ? fs.readdirSync(x, { withFileTypes: true }).flatMap((e) => [path.join(x, e.name), ...(e.isDirectory() ? alle(path.join(x, e.name)) : [])]) : [])
    const liste = alle(o)
    if (process.platform === 'win32' && liste.length) schutz.entsperren({ dateien: liste.filter((p) => fs.statSync(p).isFile()), ordner: [o, ...liste.filter((p) => fs.statSync(p).isDirectory())] })
    for (const p of liste) { try { fs.chmodSync(p, 0o666) } catch { /* egal */ } }
    fs.rmSync(o, { recursive: true, force: true })
  })
  return o
}

// Roh-Anfrage, damit Host- und Origin-Kopfzeilen frei gesetzt werden können
function anfrage(port, { pfad = '/', methode = 'GET', kopf = {}, koerper = null } = {}) {
  return new Promise((fertig, fehler) => {
    const r = http.request({ host: '127.0.0.1', port, path: pfad, method: methode, headers: kopf }, (a) => {
      const teile = []
      a.on('data', (t) => teile.push(t))
      a.on('end', () => fertig({ status: a.statusCode, kopf: a.headers, text: Buffer.concat(teile).toString('utf8'), roh: Buffer.concat(teile) }))
    })
    r.on('error', fehler)
    if (koerper != null) r.write(koerper)
    r.end()
  })
}

async function serverStarten(t, optionen = {}) {
  const d = optionen.datenordner || datenordner(t)
  process.env.VENDO_BELEGE = path.join(d, 'belege') // Arbeitsordner der Bestellungen nur im Temp-Ordner
  const s = await starten({ port: 0, datenordner: d, protokoll: () => {}, ...optionen })
  t.after(() => s.schliessen())
  const api = async (name, argumente = [], { token = s.token, kopf = {} } = {}) => {
    const r = await anfrage(s.port, { pfad: `/api/${name}`, methode: 'POST', kopf: { 'Content-Type': 'application/json', ...(token ? { 'X-Sitzung': token } : {}), ...kopf }, koerper: JSON.stringify(Array.isArray(argumente) ? { argumente } : argumente) })
    return { status: r.status, ...JSON.parse(r.text) }
  }
  return { s, d, api }
}

test('Server startet auf freiem Port nur auf 127.0.0.1 und liefert nur die feste Dateiliste aus', async (t) => {
  const { s } = await serverStarten(t, { passwort: PASSWORT })
  assert.ok(s.port > 0)
  assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.match(s.adresse, /#t=[A-Za-z0-9_-]{40,}$/, 'Startadresse trägt das Token im Fragment (geht nicht an den Server)')
  const seite = await anfrage(s.port, { kopf: { Host: `127.0.0.1:${s.port}` } })
  assert.equal(seite.status, 200)
  assert.match(seite.text, /<script type="module" src="\/app\/client\.js">/)
  assert.equal(seite.text.includes(s.token), false, 'Token steht nicht in der Seite')
  assert.match(seite.kopf['content-security-policy'], /frame-ancestors 'none'/)
  assert.equal(seite.kopf['x-content-type-options'], 'nosniff')
  for (const p of ['/plugin/ansicht.js', '/plugin/angaben-bereiche.js', '/plugin/stil.css', '/app/client.js', '/app/basis.css']) assert.equal((await anfrage(s.port, { pfad: p })).status, 200, p)
  for (const p of ['/plugin/haupt.js', '/plugin/bisher.js', '/plugin/STAND.md', '/../haupt.js', '/plugin/../haupt.js', '/buchhaltung.json', '/tresor.json']) assert.equal((await anfrage(s.port, { pfad: p })).status, 404, p)
  assert.equal((await anfrage(s.port, { kopf: { Host: `boese.example:${s.port}` } })).status, 421, 'fremder Host (DNS-Rebinding) abgewiesen')
  assert.equal((await anfrage(s.port, { kopf: { Host: `localhost:${s.port}` } })).status, 200)
})

test('API verlangt Sitzungs-Token, JSON, POST und eigene Herkunft', async (t) => {
  const { s, api } = await serverStarten(t, { passwort: PASSWORT })
  assert.equal((await api('umgebung', [], { token: null })).status, 403)
  assert.equal((await api('umgebung', [], { token: 'falsch' })).status, 403)
  assert.equal((await api('umgebung', [], { token: s.token.slice(0, -1) + (s.token.endsWith('A') ? 'B' : 'A') })).status, 403)
  assert.equal((await api('umgebung', [], { kopf: { Origin: 'https://boese.example' } })).status, 403, 'fremde Seite')
  assert.equal((await api('umgebung', [], { kopf: { 'Content-Type': 'text/plain' } })).status, 415, 'einfache Formular-Anfragen gehen nicht durch')
  assert.equal((await anfrage(s.port, { pfad: '/api/umgebung', kopf: { 'X-Sitzung': s.token } })).status, 405)
  const ok = await api('umgebung', [], { kopf: { Origin: s.url } })
  assert.equal(ok.status, 200)
  assert.deepEqual({ ...ok.wert, tresor: undefined }, { art: 'eigenstaendig', windows: process.platform === 'win32', zugaengeEinstellbar: true, tresor: undefined })
  assert.deepEqual(ok.wert.tresor, { name: 'Der Passwort-Tresor', verfuegbar: true })
  const fehlt = await api('gibtEsNicht')
  assert.equal(fehlt.status, 404)
  assert.equal((await api('constructor')).status, 404)
  assert.equal((await api('__proto__')).status, 404)
  const fehler = await api('p13bAngemeldet', ['kein-monat'])
  assert.deepEqual([fehler.status, fehler.ok, fehler.fehler], [200, false, 'Ungültiger Monat.'], 'Fehler aus haupt.js kommen als Meldung zurück')
})

test('Tresor: gesperrt bis Passwort festgelegt, danach API frei; nach Neustart falsches Passwort abgewiesen', async (t) => {
  const d = datenordner(t)
  const erst = await serverStarten(t, { datenordner: d })
  assert.deepEqual((await erst.api('_zustand', {})).wert, { gesperrt: true, neu: true })
  const gesperrt = await erst.api('dashboard')
  assert.deepEqual([gesperrt.status, gesperrt.gesperrt], [423, true])
  assert.equal((await erst.api('_entsperren', { passwort: 'kurz' })).ok, false)
  assert.deepEqual((await erst.api('_entsperren', { passwort: PASSWORT })).wert, { neu: true })
  assert.deepEqual((await erst.api('_zustand', {})).wert, { gesperrt: false, neu: false })
  assert.equal((await erst.api('dashboard')).ok, true)
  await erst.s.schliessen()

  const zweit = await serverStarten(t, { datenordner: d })
  const falsch = await zweit.api('_entsperren', { passwort: 'falsches-passwort' })
  assert.deepEqual([falsch.ok, falsch.fehler], [false, 'Das Passwort stimmt nicht.'])
  assert.equal((await zweit.api('dashboard')).status, 423)
  assert.equal((await zweit.api('_entsperren', { passwort: PASSWORT })).ok, true)
  assert.equal((await zweit.api('dashboard')).ok, true)
})

test('Daten landen atomar in buchhaltung.json, überleben den Neustart; Geheimnisse nur verschlüsselt', async (t) => {
  const d = datenordner(t)
  const a = await serverStarten(t, { datenordner: d, passwort: PASSWORT })
  assert.deepEqual((await a.api('menueSpeichern', [['steuer', 'unbekannt']])).wert, { ausblendbar: ['bestellungen', 'rechnungen', 'steuer'], aus: ['steuer'] })
  const pers = await a.api('persoenlichSpeichern', [{ vorname: 'Erika', nachname: 'Synthetisch' }])
  assert.equal(pers.ok, true, pers.fehler)
  const token = `shpat_${'s'.repeat(32)}`
  assert.equal((await a.api('shopifyZugangSpeichern', [{ shop: 'nicht-shopify.example', token }])).ok, false)
  assert.equal((await a.api('shopifyZugangSpeichern', [{ shop: 'synthetik-shop.myshopify.com', token: 'falsch' }])).ok, false)
  assert.deepEqual((await a.api('shopifyZugangSpeichern', [{ shop: 'https://synthetik-shop.myshopify.com/admin', token }])).wert, { eingerichtet: true, shop: 'synthetik-shop.myshopify.com' })
  const zugaenge = (await a.api('zugaengeLaden')).wert
  assert.deepEqual(zugaenge, { einstellbar: true, shopify: { quelle: 'eigen', eingerichtet: true, shop: 'synthetik-shop.myshopify.com' }, shirtigo: { verbunden: false } })
  assert.equal(JSON.stringify(zugaenge).includes(token), false, 'Token geht nie an die Oberfläche')

  const datei = path.join(d, 'buchhaltung.json')
  const text = fs.readFileSync(datei, 'utf8')
  const gespeichert = JSON.parse(text)
  assert.deepEqual(gespeichert.menue, { aus: ['steuer'] })
  assert.equal(typeof gespeichert.persoenlich, 'string')
  assert.equal(typeof gespeichert.zugaenge.shopify, 'string')
  for (const klar of ['Erika', 'Synthetisch', token, 'synthetik-shop']) assert.equal(text.includes(klar), false, `${klar} nicht im Klartext gespeichert`)
  assert.deepEqual(fs.readdirSync(d).filter((n) => n.endsWith('.neu')), [], 'keine halbfertigen Dateien')
  await a.s.schliessen()

  const b = await serverStarten(t, { datenordner: d, passwort: PASSWORT })
  assert.deepEqual((await b.api('menueLaden')).wert.aus, ['steuer'], 'nach Neustart noch da')
  const p = (await b.api('persoenlichLaden')).wert
  assert.deepEqual([p.gespeichert, p.werte.vorname, p.werte.nachname], [true, 'Erika', 'Synthetisch'])
  assert.deepEqual((await b.api('shopifyZugangSpeichern', [{ shop: '', token: '' }])).wert, { eingerichtet: false })
  assert.equal((await b.api('zugaengeLaden')).wert.shopify.eingerichtet, false)
})

test('JSON-Speicher: kaputte Datei verhindert den Start statt sie mit {} zu überschreiben', (t) => {
  const d = datenordner(t)
  const datei = path.join(d, 'buchhaltung.json')
  const s = jsonSpeicher(datei)
  assert.deepEqual(s.laden(), {})
  s.speichern({ a: 1 })
  const kopie = s.laden()
  kopie.a = 2
  assert.deepEqual(s.laden(), { a: 1 }, 'laden liefert eine Kopie')
  fs.writeFileSync(datei, '{ kaputt')
  assert.throws(() => jsonSpeicher(datei), SyntaxError)
  assert.equal(fs.readFileSync(datei, 'utf8'), '{ kaputt', 'Datei unberührt')
})

test('PDF hochladen (Browser-Weg) legt ins Archiv; Jahresarchiv kommt als einmaliger Download', async (t) => {
  const { s, d, api } = await serverStarten(t, { passwort: PASSWORT })
  assert.equal((await api('hinzufuegen', [{ inhalt: Buffer.from('kein pdf').toString('base64'), name: 'x.pdf' }])).fehler, 'Das ist keine PDF-Datei.')
  assert.equal((await api('hinzufuegen', [{ inhalt: PDF.toString('base64'), name: 'x.txt' }])).ok, false)
  const neu = await api('hinzufuegen', [{ inhalt: PDF.toString('base64'), name: 'Synthetischer Beleg.pdf' }])
  assert.equal(neu.ok, true, neu.fehler)
  assert.match(neu.wert.id, /^r[0-9a-f]{20}$/)
  assert.equal(neu.wert.groesse, PDF.length)
  const imArchiv = path.join(d, 'archiv', ...neu.wert.archiv.datei.split('/'))
  assert.deepEqual(fs.readFileSync(imArchiv), PDF, 'Beleg liegt unverändert im Archiv des Datenordners')
  assert.equal((await api('liste')).wert.some((x) => x.id === neu.wert.id), true)
  assert.equal((await api('integritaet')).wert.archiv.ok, true)

  const oeffnen = await api('archivOeffnen')
  assert.deepEqual([oeffnen.ok, oeffnen.wert, oeffnen.downloads], [true, path.join(d, 'archiv'), []], 'Ordner: nur genannt, kein Download')

  const jahr = String(new Date().getFullYear())
  assert.deepEqual((await api('jahresarchivJahre')).wert, [jahr])
  const exp = await api('jahresarchivExport', [{ jahr }])
  assert.equal(exp.ok, true, exp.fehler)
  assert.equal(exp.downloads.length, 1)
  assert.match(exp.downloads[0].url, /^\/download\/[A-Za-z0-9_-]{30,}$/)
  assert.match(exp.downloads[0].name, new RegExp(`^Buchhaltung-${jahr}-\\d{4}-\\d{2}-\\d{2}\\.zip$`))
  const zip = await anfrage(s.port, { pfad: exp.downloads[0].url })
  assert.equal(zip.status, 200)
  assert.equal(zip.kopf['content-type'], 'application/zip')
  assert.match(zip.kopf['content-disposition'], /^attachment; filename="Buchhaltung-/)
  assert.equal(zip.roh.subarray(0, 2).toString('latin1'), 'PK')
  assert.equal(zip.roh.length, exp.wert.bytes)
  // 7.2 / E.4: Verfahrensdokumentation und Jahresnachweis liegen im ZIP; die Fassung aus dem ZIP ist im Archiv protokolliert
  const { unzipSync, strFromU8 } = require('fflate')
  const inhalt = unzipSync(new Uint8Array(zip.roh))
  const vd = strFromU8(inhalt['verfahrensdokumentation.md'])
  assert.match(vd, /^# Verfahrensdokumentation Buchführung und Belegarchiv/)
  assert.match(vd, /eigenständig im Browser/)
  assert.match(strFromU8(inhalt['jahresnachweis.md']), new RegExp(`^# Jahresnachweis ${jahr}`))
  const index = fs.readFileSync(path.join(d, 'archiv', 'index.jsonl'), 'utf8').trim().split('\n').map((z) => JSON.parse(z))
  const vdEintrag = index.find((e) => e.meta?.vorgang === 'verfahrensdokumentation')
  assert.equal(vdEintrag?.meta.anlass, `jahresarchiv ${jahr}`)
  assert.deepEqual(fs.readFileSync(path.join(d, 'archiv', ...vdEintrag.datei.split('/'))), Buffer.from(inhalt['verfahrensdokumentation.md']), 'Fassung im Archiv = Fassung im ZIP')
  assert.equal(fs.existsSync(path.join(d, 'exporte', exp.downloads[0].name)), true, 'Export bleibt im Datenordner')
  assert.equal((await anfrage(s.port, { pfad: exp.downloads[0].url })).status, 404, 'Download-Adresse gilt nur einmal')
  assert.equal((await anfrage(s.port, { pfad: '/download/geraten' })).status, 404)
})

test('Verfahrensdokumentation und Datenschutz über die Dienste: ergänzen, bestätigen, protokollieren, Verzeichnis', async (t) => {
  const { d, api } = await serverStarten(t, { passwort: PASSWORT })
  const leer = (await api('verfahrenLaden')).wert
  assert.equal(leer.fehlend.length, 8)
  assert.equal(leer.bestaetigung, null)
  assert.match(leer.text, /Noch nicht durchgesehen und bestätigt/)
  const werte = Object.fromEntries(leer.felder.map((f) => [f.feld, `Synthetisch ${f.feld}`]))
  assert.deepEqual((await api('verfahrenSpeichern', [werte])).wert.fehlend, [])
  const b = (await api('verfahrenBestaetigen')).wert
  assert.match(b.datei, /protokoll\/Verfahrensdokumentation .*\.md$/)
  const abgelegt = fs.readFileSync(path.join(d, 'archiv', ...b.datei.split('/')), 'utf8')
  assert.match(abgelegt, /Durchgesehen und bestätigt am/)
  assert.match(abgelegt, /Synthetisch stickOrt/)
  assert.equal((await api('verfahrenLaden')).wert.bestaetigtGueltig, true)
  await api('verfahrenSpeichern', [{ ...werte, zugriff: 'geändert' }])
  assert.equal((await api('verfahrenLaden')).wert.bestaetigtGueltig, false, 'Änderung verlangt neue Bestätigung')
  assert.equal((await api('verfahrenSpeichern', [{ papier: 'x'.repeat(2001) }])).ok, false)

  const ds = (await api('datenschutzLaden')).wert
  assert.match(ds.verzeichnis, /Verzeichnis von Verarbeitungstätigkeiten/)
  assert.deepEqual(ds.anfragen, [])
  assert.match((await api('datenschutzSuchen', ['ab'])).fehler, /mindestens 3 Zeichen/)
  assert.deepEqual((await api('datenschutzSuchen', ['niemand@example.test'])).wert, [])
  assert.match((await api('datenschutzSperren', [{ nrs: [] }])).fehler, /Bestellungen auswählen/)
})

test('K.3: E-Rechnung als XML hochladen – byte-genau im Archiv, Beträge in der Liste, Scannen abgelehnt, keine Fremd-XML', async (t) => {
  const { d, api } = await serverStarten(t, { passwort: PASSWORT })
  const { CII } = require('./fixtures/erechnung.js')
  const bytes = Buffer.from(CII, 'utf8')
  const neu = await api('hinzufuegen', [{ inhalt: bytes.toString('base64'), name: 'Erfundene Rechnung.xml' }])
  assert.equal(neu.ok, true, neu.fehler)
  assert.deepEqual([neu.wert.xml, neu.wert.rechnung.lieferant, neu.wert.rechnung.summen.brutto], ['CII', 'Erfundene Druckerei GmbH & Co. KG', 119])
  assert.deepEqual(fs.readFileSync(path.join(d, 'archiv', ...neu.wert.archiv.datei.split('/'))), bytes, 'XML unverändert im Archiv')
  const index = fs.readFileSync(path.join(d, 'archiv', 'index.jsonl'), 'utf8').trim().split('\n').map((z) => JSON.parse(z))
  assert.deepEqual(index.at(-1).meta, { quelle: 'xml-eingang', eintrag: neu.wert.id, name: 'Erfundene Rechnung.xml', format: 'CII' })
  assert.equal((await api('liste')).wert.find((x) => x.id === neu.wert.id).rechnung.wirksam, 119)
  assert.match((await api('scannen', [neu.wert.id])).fehler, /nicht gescannt/)
  assert.match((await api('hinzufuegen', [{ inhalt: Buffer.from('<?xml version="1.0"?><Bestellung/>').toString('base64'), name: 'fremd.xml' }])).fehler, /keine E-Rechnung/)
  assert.match((await api('hinzufuegen', [{ inhalt: bytes.toString('base64'), name: 'rechnung.txt' }])).fehler, /PDF- oder XML-Datei/)
})

test('Eigenes Repository vorbereitet: private Dateien ausgeschlossen, keine festen Bezüge im Code', () => {
  const ordner = path.resolve('.')
  const ignoriert = fs.readFileSync(path.join(ordner, '.gitignore'), 'utf8').split(/\r?\n/).map((z) => z.trim())
  for (const privat of ['bisher.js', 'LOGO.png', 'PLAN.md', 'STAND.md', 'test-results/', '*.result.md', 'daten/', 'node_modules/']) assert.ok(ignoriert.includes(privat), `${privat} in .gitignore`)
  const paket = JSON.parse(fs.readFileSync(path.join(ordner, 'package.json'), 'utf8'))
  assert.equal(paket.scripts.start, 'node standalone/server.js --browser')
  assert.ok(paket.files.includes('!bisher.js'))
  for (const f of paket.files) assert.equal(/PLAN|STAND|LOGO|result/.test(f), false, f)
  assert.ok(fs.existsSync(path.join(ordner, 'LIZENZ.md')))
  assert.ok(fs.existsSync(path.join(ordner, 'README.md')))
  // Electron nur in host.js; kein fester Hermes-Profilname außer im Vendo-Standard von host.js
  const code = fs.readdirSync(ordner).filter((n) => n.endsWith('.js') && n !== 'bisher.js').map((n) => [n, fs.readFileSync(path.join(ordner, n), 'utf8')])
  for (const [n, text] of code) {
    if (n !== 'host.js') assert.equal(/require\(['"]electron['"]\)|laden\(['"]electron['"]\)/.test(text), false, `${n} ruft Electron auf`)
    if (n !== 'host.js') assert.equal(/donnerwolf/i.test(text), false, `${n} enthält einen festen Namen`)
    assert.equal(/window\.vendo\./.test(text), false, `${n} greift an ctx vorbei auf window.vendo zu`)
  }
})

test('Optional PostgreSQL über eine Verbindungsangabe: Index wird in der Test-Datenbank aufgebaut', async (t) => {
  const url = process.env.VENDO_DB_URL || 'postgres://postgres:nurtest@127.0.0.1:55432/vendo_test' // nur die Test-Datenbank
  const { Client } = require('pg')
  const aufraeumen = async () => {
    const c = new Client({ connectionString: url, connectionTimeoutMillis: 3000 })
    await c.connect()
    try { await c.query('DROP SCHEMA IF EXISTS buchhaltung CASCADE'); await c.query('DROP TABLE IF EXISTS public.buchhaltung_schema_version') } finally { await c.end() }
  }
  try { await aufraeumen() } catch { return t.skip('Test-Datenbank nicht erreichbar') }
  t.after(aufraeumen)
  const { api } = await serverStarten(t, { passwort: PASSWORT, dbUrl: url })
  let status
  for (let i = 0; i < 50; i++) { status = (await api('datenbankStatus')).wert; if (status.zustand.zustand !== 'startet') break; await new Promise((r) => setTimeout(r, 100)) }
  assert.equal(status.zustand.zustand, 'bereit', status.zustand.meldung)
  const neu = await api('hinzufuegen', [{ inhalt: PDF.toString('base64'), name: 'Synthetischer Beleg.pdf' }])
  assert.equal(neu.ok, true, neu.fehler)
  const aufbau = await api('datenbankAufbauen')
  assert.equal(aufbau.ok, true, aufbau.fehler)
  assert.deepEqual([aufbau.wert.ok, aufbau.wert.neu, aufbau.wert.anzahl.belege], [true, true, 1])
  const danach = (await api('datenbankStatus')).wert
  assert.equal(danach.index.anzahl.belege, 1)
})
