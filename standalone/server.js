#!/usr/bin/env node
'use strict'
// Buchhaltung eigenständig: kleiner lokaler Server für die Browser-Oberfläche. Derselbe Plugin-Code wie in Vendo
// (haupt.js, ansicht.js), nur ein anderes Umfeld (host.js → eigenstaendig) und ein eigener ctx.
//
// Sicherheit:
//   - lauscht nur auf 127.0.0.1; fremde Host-Kopfzeilen (DNS-Rebinding) werden abgewiesen
//   - jede API-Anfrage braucht das zufällige Sitzungs-Token im Kopf „X-Sitzung“ (steht nur in der Startadresse im
//     Terminal). Eigene Kopfzeile + JSON + fremde Origin abgewiesen: fremde Seiten können keine Aufrufe auslösen (CSRF).
//   - Geheimnisse (persönliche Angaben, Tokens) nur mit dem Passwort-Tresor (scrypt + AES-GCM); ohne Entsperren keine API
//   - Downloads nur über einmalige, kurzlebige Zufallsadressen
//
// Start: npm start (im Plugin-Ordner) oder node standalone/server.js [--port 8130] [--daten <ordner>] [--browser]
// Umgebung: BUCHHALTUNG_DATEN (Datenordner), BUCHHALTUNG_PORT, BUCHHALTUNG_PASSWORT (entsperrt beim Start),
//           BUCHHALTUNG_DB_URL (optional PostgreSQL für den Index)

const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { AsyncLocalStorage } = require('node:async_hooks')

const PLUGIN = path.resolve(__dirname, '..')
const MAX_KOERPER = 80 * 1024 * 1024 // PDFs kommen als Base64 (50 MB PDF ≈ 67 MB Text)
const DOWNLOAD_DAUER = 10 * 60_000
const NAME = /^[A-Za-z][A-Za-z0-9]{0,60}$/

// Ausgelieferte Dateien: feste Liste, nichts anderes aus dem Dateisystem
const DATEIEN = {
  '/': [path.join(__dirname, 'index.html'), 'text/html; charset=utf-8'],
  '/index.html': [path.join(__dirname, 'index.html'), 'text/html; charset=utf-8'],
  '/app/client.js': [path.join(__dirname, 'client.js'), 'text/javascript; charset=utf-8'],
  '/app/basis.css': [path.join(__dirname, 'basis.css'), 'text/css; charset=utf-8'],
  '/plugin/ansicht.js': [path.join(PLUGIN, 'ansicht.js'), 'text/javascript; charset=utf-8'],
  '/plugin/angaben-bereiche.js': [path.join(PLUGIN, 'angaben-bereiche.js'), 'text/javascript; charset=utf-8'],
  '/plugin/stil.css': [path.join(PLUGIN, 'stil.css'), 'text/css; charset=utf-8']
}
const SICHERHEIT = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
}

const gleich = (a, b) => {
  const x = Buffer.from(String(a || ''))
  const y = Buffer.from(String(b || ''))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

function argumenteLesen(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') o.port = Number(argv[++i])
    else if (argv[i] === '--daten') o.datenordner = path.resolve(argv[++i])
    else if (argv[i] === '--browser') o.browser = true
  }
  return o
}

// Startet den Server. Rückgabe: { url, port, token, host, schliessen() }. Nur ein Server je Prozess (die Plugin-Module
// halten ihren Zustand im Modul, wie in Vendo).
async function starten({ port = 0, datenordner, passwort = null, dbUrl = null, protokoll = console.log } = {}) {
  datenordner = path.resolve(datenordner || process.env.BUCHHALTUNG_DATEN || path.join(os.homedir(), 'Buchhaltung'))
  fs.mkdirSync(datenordner, { recursive: true })
  // Arbeitsordner mit Monatsordnern (Ansichtskopien) im Datenordner; bestellungen.js liest ihn beim Laden
  process.env.VENDO_BELEGE ||= path.join(datenordner, 'belege')

  const { eigenstaendig } = require('../host')
  const { jsonSpeicher } = require('./speicher')
  const downloads = new Map() // id → { pfad, name, bis }
  const aufruf = new AsyncLocalStorage() // sammelt je API-Aufruf die angebotenen Downloads
  const host = eigenstaendig({
    datenordner,
    anbieten(pfad, name) {
      const liste = aufruf.getStore()
      if (!liste) return
      const id = crypto.randomBytes(24).toString('base64url')
      downloads.set(id, { pfad, name, bis: Date.now() + DOWNLOAD_DAUER })
      liste.push({ url: `/download/${id}`, name })
    }
  })
  if (passwort) host.tresor.entsperren(passwort)

  const speicher = jsonSpeicher(path.join(datenordner, 'buchhaltung.json'))
  const db = dbUrl ? require('./datenbank').datenbank(dbUrl) : null
  const funktionen = new Map()
  require('../haupt.js')({
    id: 'buchhaltung',
    host,
    datenLaden: () => speicher.laden(),
    datenSpeichern: (d) => speicher.speichern(d),
    festschreiben: async () => true, // die Datei ist nach datenSpeichern schon geschrieben
    datenbank: db || undefined,
    bereitstellen: (name, fn) => funktionen.set(String(name), fn)
  })

  const token = crypto.randomBytes(32).toString('base64url')
  let fehlversuche = 0
  let eigenerHost = null // „127.0.0.1:<port>“, sobald der Port feststeht

  const senden = (antwort, status, koerper, kopf = {}) => {
    antwort.writeHead(status, { ...SICHERHEIT, ...kopf })
    antwort.end(koerper)
  }
  const json = (antwort, status, wert) => senden(antwort, status, JSON.stringify(wert), { 'Content-Type': 'application/json; charset=utf-8' })

  function koerperLesen(anfrage) {
    return new Promise((fertig, fehler) => {
      const teile = []
      let laenge = 0
      anfrage.on('data', (t) => {
        laenge += t.length
        if (laenge > MAX_KOERPER) { fehler(Object.assign(new Error('Anfrage zu groß.'), { status: 413 })); anfrage.destroy() } else teile.push(t)
      })
      anfrage.on('end', () => fertig(Buffer.concat(teile).toString('utf8')))
      anfrage.on('error', fehler)
    })
  }

  async function api(anfrage, antwort, name) {
    if (anfrage.method !== 'POST') return json(antwort, 405, { ok: false, fehler: 'Nur POST.' })
    if (!gleich(anfrage.headers['x-sitzung'], token)) return json(antwort, 403, { ok: false, fehler: 'Sitzung ungültig. Bitte die Adresse aus dem Terminal öffnen.' })
    const herkunft = anfrage.headers.origin
    if (herkunft && herkunft !== `http://${eigenerHost}` && herkunft !== `http://localhost:${eigenerHost.split(':')[1]}`) return json(antwort, 403, { ok: false, fehler: 'Fremde Herkunft.' })
    if (!String(anfrage.headers['content-type'] || '').startsWith('application/json')) return json(antwort, 415, { ok: false, fehler: 'Nur JSON.' })
    let eingabe
    try { eingabe = JSON.parse((await koerperLesen(anfrage)) || '{}') } catch (f) { return json(antwort, f.status || 400, { ok: false, fehler: f.status ? f.message : 'Ungültiges JSON.' }) }

    if (name === '_zustand') return json(antwort, 200, { ok: true, wert: { gesperrt: !host.tresor.entsperrt(), neu: host.tresor.neu() } })
    if (name === '_entsperren') {
      if (fehlversuche >= 5) await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** (fehlversuche - 5))))
      try {
        const r = host.tresor.entsperren(eingabe.passwort)
        fehlversuche = 0
        return json(antwort, 200, { ok: true, wert: r })
      } catch (f) { fehlversuche++; return json(antwort, 200, { ok: false, fehler: f.message }) }
    }
    if (!host.tresor.entsperrt()) return json(antwort, 423, { ok: false, fehler: 'Gesperrt. Bitte zuerst das Passwort eingeben.', gesperrt: true })
    if (!NAME.test(name) || !funktionen.has(name)) return json(antwort, 404, { ok: false, fehler: `Plugin-Funktion ${name} gibt es nicht.` })
    const argumente = Array.isArray(eingabe.argumente) ? eingabe.argumente : []
    const angeboten = []
    try {
      const wert = await aufruf.run(angeboten, () => funktionen.get(name)(...argumente))
      return json(antwort, 200, { ok: true, wert: wert === undefined ? null : wert, downloads: angeboten })
    } catch (f) {
      return json(antwort, 200, { ok: false, fehler: f?.message || String(f) })
    }
  }

  function herunterladen(antwort, id) {
    const d = downloads.get(id)
    downloads.delete(id) // einmalig
    if (!d || d.bis < Date.now()) return senden(antwort, 404, 'Nicht gefunden.', { 'Content-Type': 'text/plain; charset=utf-8' })
    let inhalt
    try { inhalt = fs.readFileSync(d.pfad) } catch { return senden(antwort, 404, 'Datei nicht gefunden.', { 'Content-Type': 'text/plain; charset=utf-8' }) }
    const art = /\.pdf$/i.test(d.name) ? 'application/pdf' : /\.zip$/i.test(d.name) ? 'application/zip' : /\.json$/i.test(d.name) ? 'application/json' : 'application/octet-stream'
    senden(antwort, 200, inhalt, { 'Content-Type': art, 'Content-Disposition': `attachment; filename="${d.name.replace(/[^\w.\- ]+/g, '_')}"; filename*=UTF-8''${encodeURIComponent(d.name)}` })
  }

  const server = http.createServer((anfrage, antwort) => {
    const hostKopf = String(anfrage.headers.host || '')
    const p = eigenerHost.split(':')[1]
    if (hostKopf !== eigenerHost && hostKopf !== `localhost:${p}`) return senden(antwort, 421, 'Falscher Host.', { 'Content-Type': 'text/plain; charset=utf-8' })
    const url = new URL(anfrage.url, `http://${eigenerHost}`)
    if (url.pathname.startsWith('/api/')) return api(anfrage, antwort, decodeURIComponent(url.pathname.slice(5))).catch((f) => json(antwort, 500, { ok: false, fehler: f.message }))
    if (url.pathname.startsWith('/download/') && anfrage.method === 'GET') return herunterladen(antwort, url.pathname.slice(10))
    const datei = DATEIEN[url.pathname]
    if (!datei || (anfrage.method !== 'GET' && anfrage.method !== 'HEAD')) return senden(antwort, 404, 'Nicht gefunden.', { 'Content-Type': 'text/plain; charset=utf-8' })
    fs.readFile(datei[0], (f, inhalt) => (f ? senden(antwort, 500, 'Datei fehlt.', { 'Content-Type': 'text/plain; charset=utf-8' }) : senden(antwort, 200, anfrage.method === 'HEAD' ? '' : inhalt, { 'Content-Type': datei[1] })))
  })
  // abgelaufene Downloads aufräumen
  const putzer = setInterval(() => { const jetzt = Date.now(); for (const [id, d] of downloads) if (d.bis < jetzt) downloads.delete(id) }, 60_000)
  putzer.unref()

  await new Promise((fertig, fehler) => { server.once('error', fehler); server.listen(port, '127.0.0.1', fertig) })
  const echterPort = server.address().port
  eigenerHost = `127.0.0.1:${echterPort}`
  const adresse = `http://${eigenerHost}/#t=${token}`
  protokoll(`Buchhaltung läuft: ${adresse}`)
  protokoll(`Datenordner: ${datenordner}`)

  return {
    url: `http://${eigenerHost}`, adresse, port: echterPort, token, host, datenordner,
    async schliessen() {
      clearInterval(putzer)
      await new Promise((fertig) => server.close(() => fertig()))
      server.closeAllConnections?.()
      await db?.beenden()
    }
  }
}

function browserOeffnen(adresse) {
  const { spawn } = require('node:child_process')
  const [befehl, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', adresse.replace(/&/g, '^&')]] : process.platform === 'darwin' ? ['open', [adresse]] : ['xdg-open', [adresse]]
  try { spawn(befehl, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref() } catch { /* Adresse steht im Terminal */ }
}

if (require.main === module) {
  const o = argumenteLesen(process.argv.slice(2))
  starten({
    port: o.port ?? Number(process.env.BUCHHALTUNG_PORT || 8130),
    datenordner: o.datenordner,
    passwort: process.env.BUCHHALTUNG_PASSWORT || null,
    dbUrl: process.env.BUCHHALTUNG_DB_URL || null
  }).then((s) => {
    if (o.browser) browserOeffnen(s.adresse)
    const ende = () => s.schliessen().finally(() => process.exit(0))
    process.on('SIGINT', ende)
    process.on('SIGTERM', ende)
  }).catch((f) => { console.error(`Start fehlgeschlagen: ${f.message}`); process.exit(1) })
}

module.exports = { starten }
