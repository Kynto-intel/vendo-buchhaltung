import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// Tests für plugins/buchhaltung/host.js: Vendo-Host (Electron als Stub) und eigenständiger Host (Passwort-Tresor,
// Downloads, Pfade im Datenordner). Nur synthetische Werte in Temp-Ordnern, kein Electron, kein Netz.

const require = createRequire(import.meta.url)
const host = require('../host.js')

function tempOrdner(t, name) {
  const o = fs.mkdtempSync(path.join(os.tmpdir(), `vendo-host-${name}-`))
  t.after(() => fs.rmSync(o, { recursive: true, force: true }))
  return o
}

test('Vendo-Host: Pfade wie bisher, Electron nur über das übergebene require und erst bei Bedarf', async () => {
  const geladen = []
  const geoeffnet = []
  const dialoge = []
  let abbrechen = false
  const electron = {
    app: { getPath: (n) => path.join('C:\\synthetisch', n) },
    shell: { openPath: async (p) => { geoeffnet.push(p); return p.endsWith('fehlt.pdf') ? 'Datei fehlt' : '' } },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from('ENC:' + t), decryptString: (b) => String(b).slice(4) },
    dialog: { showSaveDialog: async (fenster, o) => { dialoge.push(o); return abbrechen ? { canceled: true } : { canceled: false, filePath: path.join('C:\\ziel', 'x.zip') } } },
    BrowserWindow: { getFocusedWindow: () => null }
  }
  const laden = (name) => {
    geladen.push(name)
    if (name === 'node:os') return { homedir: () => 'C:\\home-synthetisch' }
    if (name === 'electron') return electron
    if (name === './usb') return { laufwerke: () => [{ laufwerk: 'E:' }] }
    throw new Error(`unerwartet: ${name}`)
  }
  const pluginOrdner = path.join('C:\\vendo-synthetisch', 'plugins', 'buchhaltung')
  const h = host.vendo(laden, pluginOrdner)
  assert.deepEqual(geladen, ['node:os'], 'Electron wird beim Erzeugen nicht geladen')
  assert.equal(h.art, 'vendo')
  assert.equal(h.zugaengeEinstellbar, false)
  const vorher = process.env.VENDO_BILDSPEICHER
  delete process.env.VENDO_BILDSPEICHER
  try {
    assert.deepEqual(h.pfade(), {
      daten: path.join('C:\\vendo-synthetisch', 'daten', 'buchhaltung'),
      programm: path.resolve('C:\\vendo-synthetisch'),
      archivStandard: path.join('C:\\home-synthetisch', 'Documents', 'Vendo-Archiv'),
      bilder: path.join('C:\\vendo-synthetisch', 'daten', 'buchhaltung-bilder')
    })
  } finally { if (vorher !== undefined) process.env.VENDO_BILDSPEICHER = vorher }
  assert.equal(geladen.includes('electron'), false, 'pfade() braucht kein Electron')
  assert.equal(h.benutzerOrdner(), path.join('C:\\synthetisch', 'userData'))
  assert.equal(await h.oeffnen('C:\\a.pdf'), '')
  assert.equal(await h.oeffnen('C:\\fehlt.pdf'), 'Datei fehlt')
  assert.deepEqual(geoeffnet, ['C:\\a.pdf', 'C:\\fehlt.pdf'])
  assert.equal(String(h.tresor.verschluesseln('x')), 'ENC:x')
  assert.equal(h.tresor.entschluesseln(Buffer.from('ENC:y')), 'y')
  assert.equal(h.tresor.verfuegbar(), true)
  assert.match(h.tresor.name, /Windows-Speicher/)
  assert.equal(await h.speichernUnter({ titel: 'T', name: 'Buchhaltung-2025.zip', filter: { name: 'ZIP-Archiv', extensions: ['zip'] } }), path.join('C:\\ziel', 'x.zip'))
  assert.deepEqual(dialoge[0], { title: 'T', defaultPath: path.join('C:\\home-synthetisch', 'Documents', 'Buchhaltung-2025.zip'), filters: [{ name: 'ZIP-Archiv', extensions: ['zip'] }] })
  abbrechen = true
  assert.equal(await h.speichernUnter({ titel: 'T', name: 'y.zip' }), null)
  assert.deepEqual(h.laufwerke(), [{ laufwerk: 'E:' }])
})

test('Vendo-Host: Shopify-Zugang aus Hermes (Profil, dann Hauptordner; Profil einstellbar), nie geschrieben', (t) => {
  const home = tempOrdner(t, 'hermes')
  const profilOrdner = (p) => { const o = path.join(home, 'profiles', p); fs.mkdirSync(o, { recursive: true }); return o }
  const token = (z) => `shpat_${z.repeat(32)}`
  fs.writeFileSync(path.join(profilOrdner('testprofil'), '.env'), `SHOPIFY_ACCESS_TOKEN=${token('a')}\n`)
  fs.writeFileSync(path.join(home, 'config.yaml'), `SHOPIFY_STORE: https://synthetik-shop.myshopify.com/\nSHOPIFY_ACCESS_TOKEN: ${token('b')}\n`)
  assert.deepEqual(host.hermesShopify(home, 'testprofil'), { token: token('a'), shop: 'synthetik-shop.myshopify.com' }, 'Token aus dem Profil, Shop aus dem Hauptordner')
  assert.deepEqual(host.hermesShopify(home, 'anderes'), { token: token('b'), shop: 'synthetik-shop.myshopify.com' })
  const leer = tempOrdner(t, 'hermes-leer')
  assert.throws(() => host.hermesShopify(leer, 'x'), /Kein Shopify-Zugang in den Hermes-Einstellungen/)

  const vorher = { home: process.env.VENDO_TEST_HERMES_HOME, profil: process.env.VENDO_HERMES_PROFIL }
  process.env.VENDO_TEST_HERMES_HOME = home
  process.env.VENDO_HERMES_PROFIL = 'testprofil'
  try {
    const h = host.vendo((n) => (n === 'node:os' ? { homedir: () => home } : null), home)
    assert.equal(h.shopifyZugang().token, token('a'))
  } finally {
    for (const [k, v] of [['VENDO_TEST_HERMES_HOME', vorher.home], ['VENDO_HERMES_PROFIL', vorher.profil]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
  assert.equal(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8').includes(token('b')), true, 'Hermes-Dateien unverändert')
})

test('Passwort-Tresor: festlegen, falsches Passwort abweisen, AES-GCM-Rundweg, Manipulation erkennen', (t) => {
  const o = tempOrdner(t, 'tresor')
  const datei = path.join(o, 'tresor.json')
  const tr = host.passwortTresor(datei)
  assert.equal(tr.neu(), true)
  assert.equal(tr.verfuegbar(), false)
  assert.throws(() => tr.verschluesseln('x'), /gesperrt/)
  assert.throws(() => tr.entsperren('kurz'), /mindestens 8 Zeichen/)
  assert.deepEqual(tr.entsperren('synthetisches-passwort'), { neu: true })
  const stand = JSON.parse(fs.readFileSync(datei, 'utf8'))
  assert.deepEqual(Object.keys(stand).sort(), ['pruefung', 'salz', 'version'])
  assert.equal(fs.readFileSync(datei, 'utf8').includes('synthetisches-passwort'), false, 'Passwort steht nirgends')

  const geheim = 'Steuer-ID 00000000000 (synthetisch)'
  const a = tr.verschluesseln(geheim)
  const b = tr.verschluesseln(geheim)
  assert.ok(Buffer.isBuffer(a))
  assert.equal(a.subarray(0, 3).toString(), 'BH1')
  assert.notDeepEqual(a, b, 'jedes Mal ein neuer IV')
  assert.equal(a.includes(Buffer.from('synthetisch')), false, 'kein Klartext im Geheimtext')
  assert.equal(tr.entschluesseln(a), geheim)
  const verfaelscht = Buffer.from(a)
  verfaelscht[verfaelscht.length - 1] ^= 1
  assert.throws(() => tr.entschluesseln(verfaelscht))
  assert.throws(() => tr.entschluesseln(Buffer.from('ENC:alt')), /Unbekanntes Verschlüsselungsformat/)

  const zweiter = host.passwortTresor(datei) // wie nach einem Neustart
  assert.equal(zweiter.neu(), false)
  assert.throws(() => zweiter.entsperren('falsches-passwort'), /stimmt nicht/)
  assert.equal(zweiter.verfuegbar(), false, 'nach falschem Passwort weiter gesperrt')
  assert.deepEqual(zweiter.entsperren('synthetisches-passwort'), { neu: false })
  assert.equal(zweiter.entschluesseln(a), geheim, 'gleiches Passwort öffnet alte Werte')
  zweiter.sperren()
  assert.throws(() => zweiter.entschluesseln(a), /gesperrt/)
})

test('Eigenständiger Host: Pfade im Datenordner, Öffnen = Download anbieten, Speichern unter = Export mit Download', async (t) => {
  const d = tempOrdner(t, 'eigen')
  const angeboten = []
  assert.throws(() => host.eigenstaendig({ datenordner: 'relativ' }), /absoluter Datenordner/)
  const h = host.eigenstaendig({ datenordner: d, anbieten: (pfad, name) => angeboten.push([pfad, name]) })
  assert.equal(h.art, 'eigenstaendig')
  assert.equal(h.zugaengeEinstellbar, true)
  assert.equal(h.shopifyZugang, null)
  assert.deepEqual(h.pfade(), { daten: path.join(d, 'arbeit'), programm: path.resolve('.'), archivStandard: path.join(d, 'archiv'), bilder: path.join(d, 'bilder') })
  assert.equal(h.benutzerOrdner(), d)
  assert.equal(h.tresor.verfuegbar(), false, 'Tresor startet gesperrt')

  const datei = path.join(d, 'beleg.pdf')
  fs.writeFileSync(datei, '%PDF-1.4 synthetisch')
  assert.equal(h.oeffnen(datei), '')
  assert.equal(h.oeffnen(d), '', 'Ordner: kein Fehler, kein Download')
  assert.equal(h.oeffnen(path.join(d, 'fehlt.pdf')), 'Datei nicht gefunden.')
  assert.deepEqual(angeboten, [[datei, 'beleg.pdf']])

  const z1 = await h.speichernUnter({ titel: 'egal', name: 'Buchhaltung-2025.zip' })
  assert.equal(z1, path.join(d, 'exporte', 'Buchhaltung-2025.zip'))
  fs.writeFileSync(z1, 'x')
  const z2 = await h.speichernUnter({ name: '../../böse/Buchhaltung-2025.zip' })
  assert.equal(z2, path.join(d, 'exporte', 'Buchhaltung-2025 (2).zip'), 'kein Pfad aus dem Namen, vorhandene Datei bleibt')
  assert.deepEqual(angeboten.slice(1).map((x) => x[1]), ['Buchhaltung-2025.zip', 'Buchhaltung-2025 (2).zip'])
  if (process.platform !== 'win32') assert.deepEqual(h.laufwerke(), [], 'ohne Windows keine Laufwerkssuche')
  assert.equal(h.windows, process.platform === 'win32')
})
