'use strict'
// Host-Schnittstelle der Buchhaltung: alles, was vom Umfeld abhängt. Die Buchhaltung läuft auf zwei Wegen mit demselben Code:
//   vendo(laden)          im Vendo-Hauptprozess (Electron): Verhalten wie bisher, kein Server.
//   eigenstaendig(opt)    eigenständig mit standalone/server.js im Browser.
// Außerhalb dieser Datei ruft das Plugin Electron nie direkt auf.
//
// Jeder Host bietet:
//   art                     'vendo' | 'eigenstaendig'
//   windows                 true unter Windows (NTFS-Schutz des Archivs, USB-Laufwerkssuche per PowerShell)
//   pfade()                 { daten, programm, archivStandard, bilder }
//   benutzerOrdner()        Ablage für verschlüsselte Schlüssel/Tokens (Vendo: Electron-userData, erst bei Bedarf)
//   oeffnen(pfad)           Datei/Ordner zeigen; liefert '' oder einen Fehlertext (wie shell.openPath)
//   tresor                  { name, verfuegbar(), verschluesseln(text) → Buffer, entschluesseln(Buffer) → text }
//   speichernUnter({ titel, name, filter })  → Zielpfad oder null (abgebrochen)
//   laufwerke()             Wechseldatenträger für die USB-Sicherung ([] ohne Windows)
//   ordnerWaehlen({ titel }) → Ordnerpfad oder null (abgebrochen); eigenständig: Unterordner im Datenordner
//   shopifyZugang()         { token, shop } aus Hermes (nur Vendo); eigenständig null: Zugang kommt aus der Oberfläche
//   zugaengeEinstellbar     true: Shopify-Zugang wird in der Oberfläche eingetragen und verschlüsselt gespeichert

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const FENSTER = process.platform === 'win32'

// ---------- Vendo: Electron im Hauptprozess ----------
// laden = require von haupt.js (in Tests ein Stub), damit Electron und das Betriebssystem austauschbar bleiben.
// Hermes-Profil wie in src/main/hermes.js; mit VENDO_HERMES_PROFIL abweichend einstellbar.
// pluginOrdner = __dirname von haupt.js (in Tests ein Temp-Ordner): daraus folgen Vendo-Ordner und daten\.
function vendo(laden = require, pluginOrdner = __dirname) {
  const os = laden('node:os')
  const electron = () => laden('electron')
  const programm = path.resolve(pluginOrdner, '..', '..')
  const hermesHome = () => process.env.VENDO_TEST_HERMES_HOME || path.join(process.env.LOCALAPPDATA || '', 'hermes')
  const profil = () => process.env.VENDO_HERMES_PROFIL || 'donnerwolf'
  return {
    art: 'vendo',
    windows: FENSTER,
    zugaengeEinstellbar: false,
    pfade: () => ({
      daten: path.join(programm, 'daten', 'buchhaltung'),
      programm,
      archivStandard: path.join(os.homedir(), 'Documents', 'Vendo-Archiv'), // Plan 7.5: getrennt vom Arbeitsordner
      bilder: process.env.VENDO_BILDSPEICHER || path.join(programm, 'daten', 'buchhaltung-bilder')
    }),
    benutzerOrdner: () => electron().app.getPath('userData'),
    oeffnen: (pfad) => electron().shell.openPath(pfad),
    tresor: {
      name: 'Der verschlüsselte Windows-Speicher',
      verfuegbar: () => electron().safeStorage.isEncryptionAvailable(),
      verschluesseln: (text) => electron().safeStorage.encryptString(text),
      entschluesseln: (puffer) => electron().safeStorage.decryptString(puffer)
    },
    async speichernUnter({ titel, name, filter } = {}) {
      const { dialog, BrowserWindow } = electron()
      const wahl = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow() || undefined, { title: titel, defaultPath: path.join(os.homedir(), 'Documents', name), filters: filter ? [filter] : [] })
      return wahl.canceled || !wahl.filePath ? null : path.resolve(wahl.filePath)
    },
    // Ordner wählen (z. B. Ziel der Wiederherstellung); Windows-Dialog mit „Neuer Ordner“
    async ordnerWaehlen({ titel } = {}) {
      const { dialog, BrowserWindow } = electron()
      const wahl = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, { title: titel, defaultPath: path.join(os.homedir(), 'Documents'), properties: ['openDirectory', 'createDirectory'] })
      return wahl.canceled || !wahl.filePaths?.[0] ? null : path.resolve(wahl.filePaths[0])
    },
    laufwerke: () => laden('./usb').laufwerke(),
    // Shopify-Token wird bei jedem Aufruf aus Hermes gelesen (nur lesen, nie schreiben); er bleibt im Hauptprozess
    shopifyZugang: () => hermesShopify(hermesHome(), profil())
  }
}

const TOKEN = /^[ \t]*SHOPIFY_ACCESS_TOKEN[ \t]*[:=][ \t]*['"]?(shp(?:at|ca|pa)_[A-Za-z0-9]{20,})/m
const SHOP = /^[ \t]*SHOPIFY_STORE(?:_DOMAIN)?[ \t]*[:=][ \t]*['"]?([^'"\r\n\s]+)/m
function hermesShopify(home, profil) {
  let token = null
  let shop = null
  for (const ordner of [path.join(home, 'profiles', profil), home]) {
    for (const datei of [path.join(ordner, 'config.yaml'), path.join(ordner, '.env')]) {
      let text
      try { text = fs.readFileSync(datei, 'utf8') } catch { continue }
      token ||= TOKEN.exec(text)?.[1] || null
      shop ||= SHOP.exec(text)?.[1]?.replace(/^https?:\/\//, '').replace(/\/$/, '') || null
    }
  }
  if (!token || !shop) throw new Error('Kein Shopify-Zugang in den Hermes-Einstellungen gefunden (SHOPIFY_ACCESS_TOKEN / SHOPIFY_STORE).')
  return { token, shop }
}

// ---------- Passwort-Tresor (eigenständig): scrypt + AES-256-GCM ----------
// Format eines verschlüsselten Werts: "BH1" | IV (12) | Tag (16) | Geheimtext. Salz und Prüfwert in <daten>/tresor.json,
// der Schlüssel nur im Arbeitsspeicher. Ohne Entsperren ist der Tresor „nicht verfügbar“ (wie DPAPI ohne Anmeldung).
const KOPF = Buffer.from('BH1')
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const PRUEFTEXT = 'buchhaltung-tresor'

function aesVerschluesseln(schluessel, text) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', schluessel, iv)
  const daten = Buffer.concat([c.update(String(text), 'utf8'), c.final()])
  return Buffer.concat([KOPF, iv, c.getAuthTag(), daten])
}
function aesEntschluesseln(schluessel, puffer) {
  const b = Buffer.isBuffer(puffer) ? puffer : Buffer.from(puffer)
  if (b.length < 31 || !b.subarray(0, 3).equals(KOPF)) throw new Error('Unbekanntes Verschlüsselungsformat.')
  const d = crypto.createDecipheriv('aes-256-gcm', schluessel, b.subarray(3, 15))
  d.setAuthTag(b.subarray(15, 31))
  return Buffer.concat([d.update(b.subarray(31)), d.final()]).toString('utf8')
}

function passwortTresor(datei) {
  let schluessel = null
  const lesen = () => { try { return JSON.parse(fs.readFileSync(datei, 'utf8')) } catch { return null } }
  return {
    name: 'Der Passwort-Tresor',
    neu: () => !lesen(),
    entsperrt: () => !!schluessel,
    // Erstes Mal: Passwort festlegen. Danach: Passwort prüfen (falsches Passwort → Fehler, Schlüssel bleibt gesperrt).
    entsperren(passwort) {
      passwort = String(passwort ?? '')
      if (passwort.length < 8) throw new Error('Das Passwort braucht mindestens 8 Zeichen.')
      const stand = lesen()
      if (!stand) {
        const salz = crypto.randomBytes(16)
        const k = crypto.scryptSync(passwort, salz, 32, SCRYPT)
        fs.mkdirSync(path.dirname(datei), { recursive: true })
        const temp = `${datei}.${process.pid}.neu`
        fs.writeFileSync(temp, JSON.stringify({ version: 1, salz: salz.toString('base64'), pruefung: aesVerschluesseln(k, PRUEFTEXT).toString('base64') }, null, 2), { encoding: 'utf8', mode: 0o600 })
        fs.renameSync(temp, datei)
        schluessel = k
        return { neu: true }
      }
      const k = crypto.scryptSync(passwort, Buffer.from(stand.salz, 'base64'), 32, SCRYPT)
      let ok = false
      try { ok = aesEntschluesseln(k, Buffer.from(stand.pruefung, 'base64')) === PRUEFTEXT } catch { ok = false }
      if (!ok) throw new Error('Das Passwort stimmt nicht.')
      schluessel = k
      return { neu: false }
    },
    sperren() { schluessel = null },
    verfuegbar: () => !!schluessel,
    verschluesseln(text) { if (!schluessel) throw new Error('Der Passwort-Tresor ist gesperrt.'); return aesVerschluesseln(schluessel, text) },
    entschluesseln(puffer) { if (!schluessel) throw new Error('Der Passwort-Tresor ist gesperrt.'); return aesEntschluesseln(schluessel, puffer) }
  }
}

// ---------- Eigenständig: lokaler Server, Browser ----------
// datenordner: alle veränderlichen Daten (Plugin-Daten, Archiv, Arbeitsordner, Bilder, Exporte, Tresor).
// anbieten(pfad, name): stellt eine Datei zum Herunterladen bereit (vom Server, z. B. als Einmal-Link für den Browser).
function eigenstaendig({ datenordner, anbieten = () => {}, laden = require } = {}) {
  if (!datenordner || !path.isAbsolute(datenordner)) throw new Error('Eigenständiger Betrieb: absoluter Datenordner nötig.')
  const d = path.resolve(datenordner)
  const tresor = passwortTresor(path.join(d, 'tresor.json'))
  const exporte = path.join(d, 'exporte')
  return {
    art: 'eigenstaendig',
    windows: FENSTER,
    zugaengeEinstellbar: true,
    tresor,
    pfade: () => ({
      daten: path.join(d, 'arbeit'),
      programm: __dirname,
      archivStandard: path.join(d, 'archiv'),
      bilder: path.join(d, 'bilder')
    }),
    benutzerOrdner: () => d,
    // Im Browser gibt es kein „Öffnen“ im Dateisystem: Dateien werden heruntergeladen, Ordner nur genannt.
    oeffnen(pfad) {
      const info = fs.statSync(pfad, { throwIfNoEntry: false })
      if (!info) return 'Datei nicht gefunden.'
      if (info.isFile()) anbieten(pfad, path.basename(pfad))
      return ''
    },
    // „Speichern unter“: Datei landet in <daten>/exporte und wird zusätzlich zum Herunterladen angeboten
    async speichernUnter({ name } = {}) {
      fs.mkdirSync(exporte, { recursive: true })
      const sauber = path.basename(String(name || 'export')).replace(/[^\w.\- ]+/g, '_') || 'export'
      let ziel = path.join(exporte, sauber)
      for (let i = 2; fs.existsSync(ziel); i++) ziel = path.join(exporte, sauber.replace(/(\.[^.]*)?$/, ` (${i})$1`))
      anbieten(ziel, path.basename(ziel))
      return ziel
    },
    // Im Browser gibt es keinen Ordnerdialog: Ziel ist ein Unterordner im Datenordner
    async ordnerWaehlen() { const ziel = path.join(d, 'wiederherstellung'); fs.mkdirSync(ziel, { recursive: true }); return ziel },
    laufwerke: () => (FENSTER ? laden('./usb').laufwerke() : []),
    shopifyZugang: null
  }
}

module.exports = { vendo, eigenstaendig, passwortTresor, aesVerschluesseln, aesEntschluesseln, hermesShopify }
