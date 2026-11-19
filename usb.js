'use strict'
// Verschlüsselte, inkrementelle Sicherung des Belegarchivs auf einen USB-Stick (Plan 7.5 Punkt 6, Schritt 1.9).
//
// Aufbau auf dem Stick (<Laufwerk>\Vendo-Sicherung\):
//   sicherung.json            Kopf, unverschlüsselt: Format, Kennung des Wiederherstellungsschlüssels, Salz, KDF-Parameter,
//                             Schlüsselprobe (AES-GCM eines festen Textes). Enthält keine Belegdaten.
//   daten/<name>.vsb          je Archivdatei ein verschlüsselter Block (AES-256-GCM). <name> = HMAC des Datei-Hashes, damit
//                             auf dem Stick nicht einmal die Hashwerte der Belege stehen. Einmal geschrieben, nie gelöscht.
//   staende/<Zeit>.vsb        verschlüsselter Sicherungsstand: kompletter Archivindex (Hash-Kette) zum Zeitpunkt der Sicherung.
//                             Alle Stände bleiben erhalten. Ab Version 2 zusätzlich die persönlichen Angaben (Plan 11.5 P-2),
//                             ebenso verschlüsselt; ältere Stände (ohne „version“) haben keine.
//   protokoll.txt             lesbares Protokoll ohne Belegdaten (Zeit, Stand, Anzahl, Ergebnis).
// Schlüssel: scrypt(Wiederherstellungsschlüssel, Salz) → HKDF → getrennte Schlüssel für Daten und Namen. Der
// Wiederherstellungsschlüssel selbst kommt nie auf den Stick.
// Nach jeder Sicherung wird der neueste Stand auf dem Stick vollständig geprüft: jeder Block entschlüsselt, Hash = Index.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const schluessel = require('./schluessel')

const ORDNER = 'Vendo-Sicherung'
const MAGIE = Buffer.from('VSB1')
const PROBE = 'vendo-usb-schluesselprobe'
const FAT32_MAX = 4 * 1024 ** 3 - 1
const STAND_VERSION = 2 // 2: mit persönlichen Angaben
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex')
const atmen = () => new Promise((r) => setImmediate(r)) // Hauptprozess zwischendurch freigeben, damit die App nicht einfriert

// ---------- Verschlüsselung (AES-256-GCM, zusätzlich an den Blocknamen gebunden) ----------
function verschluesseln(schl, klar, bezug) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', schl, iv)
  c.setAAD(Buffer.from(bezug))
  const daten = Buffer.concat([c.update(klar), c.final()])
  return Buffer.concat([MAGIE, iv, c.getAuthTag(), daten])
}
function entschluesseln(schl, block, bezug) {
  if (block.length < 32 || !block.subarray(0, 4).equals(MAGIE)) throw new Error('kein Vendo-Sicherungsblock')
  const d = crypto.createDecipheriv('aes-256-gcm', schl, block.subarray(4, 16))
  d.setAAD(Buffer.from(bezug))
  d.setAuthTag(block.subarray(16, 32))
  return Buffer.concat([d.update(block.subarray(32)), d.final()]) // wirft bei falschem Schlüssel oder Veränderung
}

// Atomar und nie überschreibend schreiben, danach zurücklesen
function einmalSchreiben(datei, inhalt) {
  const temp = `${datei}.tmp`
  fs.writeFileSync(temp, inhalt) // Rest eines Abbruchs wird überschrieben
  if (fs.existsSync(datei)) { fs.rmSync(temp, { force: true }); throw new Error(`${path.basename(datei)} existiert schon`) }
  fs.renameSync(temp, datei)
  if (!fs.readFileSync(datei).equals(inhalt)) throw new Error(`Zurücklesen von ${path.basename(datei)} fehlgeschlagen – Stick prüfen`)
}

// ---------- Sicherung öffnen bzw. anlegen ----------
// optionen.kdf nur für Tests (schnellere scrypt-Parameter); auf dem Stick stehen die tatsächlich benutzten Parameter.
// Schlüsselableitung asynchron (Thread-Pool), damit der Electron-Hauptprozess nicht einfriert
const scrypt = (geheim, salz, laenge, optionen) => new Promise((ok, nein) => crypto.scrypt(geheim, salz, laenge, optionen, (f, k) => f ? nein(f) : ok(k)))
async function oeffnen(wurzel, wiederherstellungsschluessel, { anlegen = false, kdf = null, jetzt = new Date() } = {}) {
  const ordner = path.join(wurzel, ORDNER)
  const kopfDatei = path.join(ordner, 'sicherung.json')
  const kennung = schluessel.kennung(wiederherstellungsschluessel)
  let kopf = null
  if (fs.existsSync(kopfDatei)) kopf = JSON.parse(fs.readFileSync(kopfDatei, 'utf8'))
  else if (!anlegen) throw new Error('Auf diesem Laufwerk liegt keine Vendo-Sicherung.')
  if (kopf && kopf.format !== 'vendo-usb-sicherung') throw new Error('Unbekanntes Sicherungsformat auf dem Stick.')
  if (kopf && kopf.kennung !== kennung) throw new Error(`Diese Sicherung gehört zu einem anderen Wiederherstellungsschlüssel (Kennung ${kopf.kennung}, deiner: ${kennung}).`)
  const parameter = kopf?.kdf || kdf || { N: 2 ** 17, r: 8, p: 1 }
  const salz = kopf ? Buffer.from(kopf.salz, 'base64') : crypto.randomBytes(16)
  const haupt = await scrypt(schluessel.normalisieren(wiederherstellungsschluessel), salz, 32, { ...parameter, maxmem: 256 * 1024 * 1024 }) // wie schluessel.ableiten
  const kDaten = Buffer.from(crypto.hkdfSync('sha256', haupt, salz, 'vendo-usb-daten', 32))
  const kName = Buffer.from(crypto.hkdfSync('sha256', haupt, salz, 'vendo-usb-namen', 32))
  if (kopf) {
    try { if (entschluesseln(kDaten, Buffer.from(kopf.probe, 'base64'), 'probe').toString() !== PROBE) throw new Error() } catch { throw new Error('Der Wiederherstellungsschlüssel passt nicht zu dieser Sicherung.') }
  } else {
    fs.mkdirSync(path.join(ordner, 'daten'), { recursive: true })
    fs.mkdirSync(path.join(ordner, 'staende'), { recursive: true })
    kopf = { format: 'vendo-usb-sicherung', version: 1, erstellt: jetzt.toISOString(), kennung, salz: salz.toString('base64'), kdf: parameter, probe: verschluesseln(kDaten, Buffer.from(PROBE), 'probe').toString('base64'), hinweis: 'Verschlüsselte Belegsicherung von Vendo. Öffnen nur mit dem Wiederherstellungsblatt (Kennung siehe oben).' }
    einmalSchreiben(kopfDatei, Buffer.from(JSON.stringify(kopf, null, 2)))
  }
  const blockName = (hash) => crypto.createHmac('sha256', kName).update(hash).digest('hex')
  return { ordner, kopf, kennung, kDaten, blockName }
}

// ---------- Indexkette prüfen (gleiche Regeln wie archiv.js) ----------
function ketteLesen(text) {
  const fehler = []
  let vorher = '0'.repeat(64)
  const zeilen = String(text).split('\n').filter(Boolean).map((z, i) => {
    let e
    try { e = JSON.parse(z) } catch { fehler.push(`Indexzeile ${i + 1} unlesbar`); return null }
    const { hash, ...rest } = e
    if (e.vorher !== vorher || sha(JSON.stringify(rest)) !== hash) fehler.push(`Index-Kette unterbrochen bei Eintrag ${e.nr}`)
    vorher = hash
    return e
  }).filter(Boolean)
  return { zeilen, fehler, letzterHash: vorher }
}

// ---------- Plan (Probelauf ohne Schreiben) ----------
async function planen({ archiv, wurzel, wiederherstellungsschluessel = null, freiBytes = null, pruefung = archiv.integritaet() }) {
  const ordner = path.join(wurzel, ORDNER)
  const vorhanden = fs.existsSync(path.join(ordner, 'sicherung.json'))
  let neu = null
  let bytes = null
  if (vorhanden && wiederherstellungsschluessel) {
    const s = await oeffnen(wurzel, wiederherstellungsschluessel)
    const da = new Set(fs.existsSync(path.join(ordner, 'daten')) ? fs.readdirSync(path.join(ordner, 'daten')) : [])
    const fehlt = archiv.eintraege().filter((e) => !da.has(`${s.blockName(e.sha256)}.vsb`))
    neu = fehlt.length
    bytes = fehlt.reduce((n, e) => n + e.bytes + 32, 0)
  } else {
    neu = archiv.eintraege().length
    bytes = archiv.eintraege().reduce((n, e) => n + e.bytes + 32, 0)
  }
  const frei = freiBytes ?? freierPlatz(wurzel)
  const index = fs.existsSync(archiv.INDEX) ? fs.statSync(archiv.INDEX).size : 0
  return { archivOk: pruefung.ok, archivFehler: pruefung.fehler.length, eintraege: pruefung.geprueft, schonGesichert: vorhanden, neu, bytes: bytes + index + 4096, frei, passt: frei == null || frei > bytes + index + 4096 }
}
function freierPlatz(wurzel) {
  try { const s = fs.statfsSync(wurzel); return s.bavail * s.bsize } catch { return null }
}

// ---------- Sichern ----------
async function sichern({ archiv, wurzel, wiederherstellungsschluessel, kdf = null, jetzt = () => new Date(), freiBytes = null, fortschritt = () => {}, persoenlich = null }) {
  const pruefung = archiv.integritaetAsync ? await archiv.integritaetAsync() : archiv.integritaet()
  if (!pruefung.ok) throw new Error(`Nicht gesichert: Die Integritätsprüfung des Archivs meldet ${pruefung.fehler.length} Fehler. Bitte zuerst klären.`)
  const plan = await planen({ archiv, wurzel, freiBytes, pruefung }) // Integritätsprüfung nur einmal je Lauf
  if (!plan.passt) throw new Error(`Auf dem Stick ist nicht genug Platz (${Math.round(plan.frei / 1e6)} MB frei, bis zu ${Math.round(plan.bytes / 1e6)} MB nötig).`)
  const beginn = jetzt()
  const s = await oeffnen(wurzel, wiederherstellungsschluessel, { anlegen: true, kdf, jetzt: beginn })
  const datenOrdner = path.join(s.ordner, 'daten')
  const da = new Set(fs.readdirSync(datenOrdner).filter((d) => d.endsWith('.vsb')))
  const eintraege = archiv.eintraege()
  const ergebnis = { neu: 0, bytes: 0, schonDa: 0, fehler: [] }
  for (const [i, e] of eintraege.entries()) {
    const name = `${s.blockName(e.sha256)}.vsb`
    if (i % 10 === 0) await atmen()
    if (da.has(name)) { ergebnis.schonDa++; continue }
    try {
      const klar = fs.readFileSync(archiv.pfad(e))
      if (sha(klar) !== e.sha256) throw new Error('Archivdatei passt nicht zum Index')
      if (klar.length + 32 > FAT32_MAX) throw new Error('Datei größer als 4 GB (FAT32-Grenze)')
      einmalSchreiben(path.join(datenOrdner, name), verschluesseln(s.kDaten, klar, name))
      ergebnis.neu++
      ergebnis.bytes += klar.length
    } catch (f) {
      ergebnis.fehler.push(`${e.datei}: ${f.message}`)
      break // Schreib-/Lesefehler auf dem Stick: sofort aufhören, nichts verschlimmern
    }
    if (i % 25 === 0) fortschritt({ erledigt: i + 1, gesamt: eintraege.length })
  }
  let stand = null
  if (!ergebnis.fehler.length) {
    const stempel = beginn.toISOString().replace(/[:.]/g, '-')
    stand = `${stempel}.vsb`
    const inhalt = { version: STAND_VERSION, erstellt: beginn.toISOString(), archivEintraege: pruefung.geprueft, letzterHash: pruefung.letzterHash, index: fs.readFileSync(archiv.INDEX, 'utf8'), persoenlich: persoenlichPruefen(persoenlich) }
    einmalSchreiben(path.join(s.ordner, 'staende', stand), verschluesseln(s.kDaten, Buffer.from(JSON.stringify(inhalt)), `stand:${stand}`))
  }
  const kontrolle = stand ? await pruefen({ wurzel, wiederherstellungsschluessel, stand }) : null
  const ok = !ergebnis.fehler.length && !!kontrolle?.ok
  const zeile = `${beginn.toISOString()}\t${ok ? 'OK' : 'FEHLER'}\tStand ${stand || '–'}\tneu ${ergebnis.neu}\tschon da ${ergebnis.schonDa}\tgeprüft ${kontrolle?.geprueft ?? 0}\t${[...ergebnis.fehler, ...(kontrolle?.fehler || [])].slice(0, 3).join(' | ')}\n`
  try { fs.appendFileSync(path.join(s.ordner, 'protokoll.txt'), zeile, 'utf8') } catch (f) { ergebnis.fehler.push(`Protokoll: ${f.message}`) }
  return { ok, kennung: s.kennung, stand, archivEintraege: pruefung.geprueft, persoenlich: !!persoenlich, ...ergebnis, kontrolle }
}
// Persönliche Angaben: nur ein flaches Objekt aus Texten (wie persoenlich.normalisieren es liefert)
function persoenlichPruefen(p) {
  if (p == null) return null
  if (typeof p !== 'object' || Array.isArray(p) || Object.values(p).some((w) => typeof w !== 'string')) throw new Error('Persönliche Angaben haben ein unerwartetes Format.')
  return p
}
// Was ein Stand über die persönlichen Angaben verrät: nur ob und wie viele Felder ausgefüllt sind, nie Werte
const persoenlichKurz = (inhalt) => inhalt.persoenlich ? { enthalten: true, felder: Object.values(inhalt.persoenlich).filter(Boolean).length } : { enthalten: false }

// Neuester (oder angegebener) Stand mit persönlichen Angaben, entschlüsselt (für die Rückholung nach einer Neuinstallation)
async function persoenlichLesen({ wurzel, wiederherstellungsschluessel, stand = null }) {
  const s = await oeffnen(wurzel, wiederherstellungsschluessel)
  const staende = fs.readdirSync(path.join(s.ordner, 'staende')).filter((d) => d.endsWith('.vsb')).sort().reverse()
  for (const name of stand ? [stand] : staende) {
    const inhalt = JSON.parse(entschluesseln(s.kDaten, fs.readFileSync(path.join(s.ordner, 'staende', name)), `stand:${name}`).toString('utf8'))
    if (inhalt.persoenlich) return { stand: name, erstellt: inhalt.erstellt, werte: persoenlichPruefen(inhalt.persoenlich) }
  }
  return null
}

// ---------- Prüfen auf dem Stick: neuester (oder angegebener) Stand vollständig ----------
async function pruefen({ wurzel, wiederherstellungsschluessel, stand = null }) {
  const s = await oeffnen(wurzel, wiederherstellungsschluessel)
  const staende = fs.readdirSync(path.join(s.ordner, 'staende')).filter((d) => d.endsWith('.vsb')).sort()
  if (!staende.length) return { ok: false, geprueft: 0, fehler: ['Noch kein Sicherungsstand auf dem Stick.'], staende: 0 }
  const name = stand || staende.at(-1)
  const fehler = []
  let inhalt
  try { inhalt = JSON.parse(entschluesseln(s.kDaten, fs.readFileSync(path.join(s.ordner, 'staende', name)), `stand:${name}`).toString('utf8')) } catch (f) {
    return { ok: false, geprueft: 0, fehler: [`Sicherungsstand ${name} ist nicht lesbar (${f.message})`], staende: staende.length }
  }
  const kette = ketteLesen(inhalt.index)
  fehler.push(...kette.fehler)
  if (kette.letzterHash !== inhalt.letzterHash) fehler.push('Sicherungsstand passt nicht zu seinem Index')
  let geprueft = 0
  for (const [i, e] of kette.zeilen.entries()) {
    if (i % 10 === 0) await atmen()
    const blockName = `${s.blockName(e.sha256)}.vsb`
    const datei = path.join(s.ordner, 'daten', blockName)
    try {
      const klar = entschluesseln(s.kDaten, fs.readFileSync(datei), blockName)
      if (sha(klar) !== e.sha256) throw new Error('Inhalt stimmt nicht')
      geprueft++
    } catch (f) {
      fehler.push(`${e.datei}: ${f.code === 'ENOENT' ? 'fehlt auf dem Stick' : f.message}`)
    }
  }
  return { ok: !fehler.length, stand: name, staende: staende.length, erstellt: inhalt.erstellt, archivEintraege: inhalt.archivEintraege, geprueft, persoenlich: persoenlichKurz(inhalt), fehler }
}

// ---------- Wiederherstellen (Schritt 1.10) ----------
// Entschlüsselt einen Sicherungsstand vollständig in einen leeren Ordner: index.jsonl + alle Dateien an ihrem Archivpfad.
// Danach muss die Integritätsprüfung des wiederhergestellten Archivs „ok“ melden.
async function wiederherstellen({ wurzel, wiederherstellungsschluessel, ziel, stand = null }) {
  if (fs.existsSync(ziel) && fs.readdirSync(ziel).length) throw new Error('Der Zielordner für die Wiederherstellung muss leer sein.')
  const s = await oeffnen(wurzel, wiederherstellungsschluessel)
  const staende = fs.readdirSync(path.join(s.ordner, 'staende')).filter((d) => d.endsWith('.vsb')).sort()
  if (!staende.length) throw new Error('Auf dem Stick gibt es noch keinen Sicherungsstand.')
  const name = stand || staende.at(-1)
  const inhalt = JSON.parse(entschluesseln(s.kDaten, fs.readFileSync(path.join(s.ordner, 'staende', name)), `stand:${name}`).toString('utf8'))
  const kette = ketteLesen(inhalt.index)
  const fehler = [...kette.fehler]
  fs.mkdirSync(ziel, { recursive: true })
  let bytes = 0
  for (const [i, e] of kette.zeilen.entries()) {
    if (i % 10 === 0) await atmen()
    const blockName = `${s.blockName(e.sha256)}.vsb`
    const datei = path.join(ziel, ...String(e.datei).split('/'))
    if (path.relative(ziel, datei).startsWith('..')) { fehler.push(`${e.datei}: Pfad außerhalb des Zielordners`); continue }
    try {
      const klar = entschluesseln(s.kDaten, fs.readFileSync(path.join(s.ordner, 'daten', blockName)), blockName)
      if (sha(klar) !== e.sha256) throw new Error('Inhalt stimmt nicht')
      fs.mkdirSync(path.dirname(datei), { recursive: true })
      fs.writeFileSync(datei, klar, { flag: 'wx' })
      bytes += klar.length
    } catch (f) {
      fehler.push(`${e.datei}: ${f.code === 'ENOENT' ? 'fehlt auf dem Stick' : f.message}`)
    }
  }
  fs.writeFileSync(path.join(ziel, 'index.jsonl'), inhalt.index, { flag: 'wx' })
  const { archiv } = require('./archiv')
  const pruefung = await archiv(ziel).integritaetAsync()
  if (pruefung.letzterHash !== inhalt.letzterHash) fehler.push('Wiederhergestellte Kette endet nicht beim Hash des Sicherungsstands')
  return { ok: !fehler.length && pruefung.ok, stand: name, erstellt: inhalt.erstellt, archivEintraege: inhalt.archivEintraege, dateien: kette.zeilen.length, bytes, persoenlich: persoenlichKurz(inhalt), letzterHash: pruefung.letzterHash, integritaet: { ok: pruefung.ok, geprueft: pruefung.geprueft, fehler: pruefung.fehler.slice(0, 20) }, fehler: fehler.slice(0, 20) }
}

// Wiederherstellungstest (Plan 7.5 Punkt 9): in einen frischen Temp-Ordner, prüfen, Protokoll auf den Stick, Ordner löschen.
async function wiederherstellungTesten({ wurzel, wiederherstellungsschluessel, tempBasis = require('node:os').tmpdir(), jetzt = () => new Date() }) {
  const beginn = jetzt()
  const ziel = fs.mkdtempSync(path.join(tempBasis, 'vendo-wiederherstellungstest-'))
  let erg
  try {
    erg = await wiederherstellen({ wurzel, wiederherstellungsschluessel, ziel: path.join(ziel, 'archiv') })
  } catch (f) {
    erg = { ok: false, fehler: [f.message], dateien: 0, bytes: 0 }
  } finally {
    fs.rmSync(ziel, { recursive: true, force: true }) // entschlüsselte Kopie sofort wieder entfernen
  }
  const zeile = `${beginn.toISOString()}\tWIEDERHERSTELLUNGSTEST ${erg.ok ? 'OK' : 'FEHLER'}\tStand ${erg.stand || '–'}\tDateien ${erg.dateien}\t${(erg.fehler || []).slice(0, 3).join(' | ')}\n`
  try { fs.appendFileSync(path.join(wurzel, ORDNER, 'protokoll.txt'), zeile, 'utf8') } catch { /* Stick schreibgeschützt o. ä.: Ergebnis steht trotzdem im Archiv */ }
  return { ...erg, zeit: beginn.toISOString(), dauerMs: Date.now() - beginn.getTime(), tempGeloescht: !fs.existsSync(ziel) }
}

// ---------- Wechseldatenträger finden (Windows) ----------
function laufwerke() {
  if (process.platform !== 'win32') return []
  const lauf = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2' | Select-Object DeviceID,FileSystem,VolumeName,Size,FreeSpace | ConvertTo-Json -Compress"],
  { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
  if (lauf.status !== 0 || !lauf.stdout.trim()) return []
  const liste = [].concat(JSON.parse(lauf.stdout))
  return liste.filter((d) => /^[A-Z]:$/.test(d.DeviceID || '') && d.Size).map((d) => ({
    laufwerk: d.DeviceID, wurzel: `${d.DeviceID}\\`, name: d.VolumeName || '', dateisystem: d.FileSystem || '?', groesse: Number(d.Size), frei: Number(d.FreeSpace),
    vendo: fs.existsSync(path.join(`${d.DeviceID}\\`, ORDNER, 'sicherung.json'))
  }))
}

module.exports = { sichern, pruefen, planen, oeffnen, laufwerke, entschluesseln, wiederherstellen, wiederherstellungTesten, persoenlichLesen, ORDNER, STAND_VERSION }
