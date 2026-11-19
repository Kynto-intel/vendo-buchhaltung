'use strict'
// Shirtigo-Zugang über den MCP-Endpunkt https://cockpit.shirtigo.com/api/mcp (Bearer-Token, "API-Token erzeugen" im Cockpit).
// Der Token wird verschlüsselt abgelegt (host.js-Tresor), nur im Main-Prozess gelesen und nie zurückgegeben/geloggt.
// Erster Schritt ist die Erkennung: welche Tools bietet Shirtigo an? (Liste wird in eine Datei geschrieben, ohne Token.)

const fs = require('node:fs')
const path = require('node:path')

const MCP_URL = 'https://cockpit.shirtigo.com/api/mcp'
const PROTOKOLL = '2025-03-26'
let sitzung = null
let zaehler = 0

// Ablage des Tokens legt haupt.js über den Host fest (Vendo: Windows-Speicher, eigenständig: Passwort-Tresor)
let ablage = null
function einrichten({ datei, tresor } = {}) { ablage = typeof datei === 'function' && tresor ? { datei, tresor } : null } // datei: () => Pfad (erst bei Bedarf)

function tokenLesen() {
  if (!ablage) return null
  try { return ablage.tresor.entschluesseln(fs.readFileSync(ablage.datei())) } catch { return null }
}
function tokenSpeichern(token) {
  if (!ablage) throw new Error('Keine Ablage für den Shirtigo-Token eingerichtet.')
  if (!ablage.tresor.verfuegbar()) throw new Error('Verschlüsselte Ablage ist auf diesem System nicht verfügbar – Token wird nicht im Klartext gespeichert.')
  fs.mkdirSync(path.dirname(ablage.datei()), { recursive: true })
  fs.writeFileSync(ablage.datei(), ablage.tresor.verschluesseln(token))
}

async function rpc(methode, params, { benachrichtigung = false, token = tokenLesen(), nochmal = true } = {}) {
  if (!token) throw new Error('Kein Shirtigo-Token gespeichert. Bitte zuerst „Shirtigo verbinden“.')
  const body = { jsonrpc: '2.0', method: methode, params }
  const id = benachrichtigung ? undefined : ++zaehler
  if (!benachrichtigung) body.id = id
  let antwort
  try {
    antwort = await fetch(MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`, ...(sitzung ? { 'Mcp-Session-Id': sitzung } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000)
    })
  } catch {
    throw new Error('Shirtigo ist gerade nicht erreichbar.')
  }
  if (antwort.status === 401 || antwort.status === 403) throw new Error('Shirtigo lehnt den Token ab (abgelaufen oder keine Rechte). Bitte einen neuen API-Token erzeugen.')
  if (antwort.status === 404 && sitzung && nochmal && methode !== 'initialize') { sitzung = null; await starten(token); return rpc(methode, params, { benachrichtigung, token, nochmal: false }) }
  if (!antwort.ok && antwort.status !== 202) throw new Error(`Shirtigo antwortet mit Fehler ${antwort.status}.`)
  sitzung = antwort.headers.get('mcp-session-id') || sitzung
  if (benachrichtigung) return null

  const text = await antwort.text()
  let nachricht = null
  if ((antwort.headers.get('content-type') || '').includes('text/event-stream')) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const daten = block.split(/\r?\n/).filter((z) => z.startsWith('data:')).map((z) => z.slice(5).trim()).join('\n')
      if (!daten) continue
      try { const j = JSON.parse(daten); if (j.id === id) nachricht = j } catch { /* nächster Block */ }
    }
  } else {
    try { nachricht = JSON.parse(text) } catch { /* unten */ }
  }
  if (!nachricht) throw new Error('Unerwartete Antwort von Shirtigo.')
  if (nachricht.error) throw new Error(nachricht.error.message || 'Shirtigo-Fehler')
  return nachricht.result
}

async function starten(token) {
  sitzung = null
  await rpc('initialize', { protocolVersion: PROTOKOLL, capabilities: {}, clientInfo: { name: 'vendo', version: '1.0.0' } }, { token, nochmal: false })
  await rpc('notifications/initialized', {}, { benachrichtigung: true, token, nochmal: false })
}

async function werkzeuge(token) {
  if (token || !sitzung) await starten(token || tokenLesen())
  const alle = []
  let cursor
  do {
    const r = await rpc('tools/list', cursor ? { cursor } : {}, { token: token || undefined })
    alle.push(...(r.tools || []))
    cursor = r.nextCursor
  } while (cursor)
  return alle.map((t) => ({ name: t.name, beschreibung: t.description, eingabe: t.inputSchema }))
}

// Token prüfen (Tools abfragen) und erst dann speichern. Schreibt die Tool-Liste (ohne Token) in <ziel>.
async function verbinden(token, ziel) {
  token = String(token || '').trim()
  if (token.length < 20) throw new Error('Das sieht nicht wie ein Shirtigo-API-Token aus.')
  const liste = await werkzeuge(token) // wirft bei ungültigem Token
  tokenSpeichern(token)
  if (tokenLesen() !== token) throw new Error('Der Token konnte nicht dauerhaft gespeichert werden (verschlüsselte Ablage nicht lesbar).')
  pdfTool = undefined // Werkzeugsuche beim nächsten Mal neu
  if (ziel) { fs.mkdirSync(path.dirname(ziel), { recursive: true }); fs.writeFileSync(ziel, JSON.stringify(liste, null, 2), 'utf8') }
  return { anzahl: liste.length, namen: liste.map((t) => t.name) }
}

async function aufrufen(name, argumente = {}) {
  if (!sitzung) await starten(tokenLesen())
  const r = await rpc('tools/call', { name, arguments: argumente })
  if (r?.isError) throw new Error(r.content?.map((c) => c.text).filter(Boolean).join(' ') || 'Tool-Fehler')
  return r
}

const verbunden = () => !!tokenLesen()

// ---------- Original-Rechnungs-PDF von Shirtigo ----------
// Welches MCP-Tool die PDF liefert, steht nicht fest: wir suchen es in der Tool-Liste (Name/Beschreibung mit invoice|rechnung + pdf|download)
// und merken uns Tool und Parametername. Gibt es keins, ist pdfWerkzeug() null und es bleibt beim Daten-Eintrag.
let toolNamen = []
let pdfTool // undefined = noch nicht gesucht, null = kein passendes Tool
const PARAMETER = ['invoice_reference', 'invoice_number', 'invoice_id', 'reference', 'order_reference', 'order_id', 'number', 'id']

async function pdfWerkzeug() {
  if (pdfTool !== undefined) return pdfTool
  const liste = await werkzeuge()
  toolNamen = liste.map((t) => t.name)
  const punkte = (t) => {
    const n = t.name.toLowerCase()
    const b = String(t.beschreibung || '').toLowerCase()
    let p = 0
    if (/invoice|rechnung/.test(n)) p += 2
    if (/pdf|download|document|dokument/.test(n)) p += 2
    if (/pdf/.test(b)) p += 1
    if (/invoice|rechnung/.test(b)) p += 1
    if (/^(list|search|find)_/.test(n)) p -= 3
    return p
  }
  const t = liste.map((x) => ({ x, p: punkte(x) })).filter((e) => e.p >= 3).sort((a, b) => b.p - a.p)[0]?.x
  if (!t) { pdfTool = null; return null }
  const props = t.eingabe?.properties || {}
  const param = PARAMETER.find((k) => k in props) || t.eingabe?.required?.[0]
  if (!param) { pdfTool = null; return null }
  pdfTool = { name: t.name, param, art: /invoice|rechnung/.test(`${param} ${t.name}`.toLowerCase()) ? 'rechnung' : 'bestellung', typ: props[param]?.type }
  return pdfTool
}

const istPdf = (b) => b.length > 4 && b.subarray(0, 4).toString('latin1') === '%PDF'
function ausBase64(s) {
  if (typeof s !== 'string') return null
  const t = s.replace(/^data:application\/pdf;base64,/, '').replace(/\s+/g, '')
  if (t.length < 100 || !/^[A-Za-z0-9+/=_-]+$/.test(t)) return null
  const b = Buffer.from(t, 'base64')
  return istPdf(b) ? b : null
}
// sucht in beliebig verschachtelten Antworten nach PDF-Daten (Base64) oder einem Download-Link
function pdfSuchen(x, ergebnis = {}, tiefe = 0) {
  if (ergebnis.buf || tiefe > 6 || x == null) return ergebnis
  if (typeof x === 'string') {
    const b = ausBase64(x)
    if (b) ergebnis.buf = b
    else if (/^https:\/\/\S+$/.test(x) && /pdf|invoice|rechnung|download/i.test(x)) ergebnis.url ||= x
    else if (/^\s*[{[]/.test(x)) { try { pdfSuchen(JSON.parse(x), ergebnis, tiefe + 1) } catch { /* kein JSON */ } }
  } else if (typeof x === 'object') {
    for (const v of Object.values(x)) pdfSuchen(v, ergebnis, tiefe + 1)
  }
  return ergebnis
}

// Liefert die Original-Rechnungs-PDF (Buffer) über die Shirtigo-REST-API: GET /orders/{Referenz}/invoice (derselbe API-Token).
// Der MCP-Server liefert keine PDF (get_order: „the invoice PDF itself is not available through this server“).
// null = es gibt (noch) keine Rechnung zu dieser Bestellung. Wirft bei Fehlern.
const REST_URL = 'https://cockpit.shirtigo.com/api'
async function rechnungPdf(o) {
  if (!o.invoice_reference || !o.reference) return null
  const token = tokenLesen()
  if (!token) throw new Error('Kein Shirtigo-Token gespeichert.')
  let antwort
  for (let versuch = 0; ; versuch++) {
    try {
      antwort = await fetch(`${REST_URL}/orders/${encodeURIComponent(o.reference)}/invoice`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/pdf, application/json' },
        signal: AbortSignal.timeout(60000)
      })
    } catch {
      throw new Error('Shirtigo ist gerade nicht erreichbar.')
    }
    if (antwort.status === 429 && versuch < 4) { await new Promise((r) => setTimeout(r, 2000 * (versuch + 1))); continue } // zu viele Anfragen: warten und nochmal
    break
  }
  if (antwort.status === 404) return null
  if (antwort.status === 401 || antwort.status === 403) throw new Error('Die Shirtigo-REST-Schnittstelle lehnt den Token für Rechnungs-PDFs ab. Bitte im Cockpit einen API-Token mit Zugriff auf Bestellungen erzeugen und neu verbinden.')
  if (!antwort.ok) throw new Error(`Shirtigo antwortet beim PDF-Abruf mit Fehler ${antwort.status}.`)
  const roh = Buffer.from(await antwort.arrayBuffer())
  if (istPdf(roh)) return roh
  // Falls die Antwort die PDF als Base64 oder als Link verpackt
  const fund = pdfSuchen([roh.toString('utf8')])
  if (fund.buf) return fund.buf
  if (fund.url) {
    const host = new URL(fund.url).hostname
    const zweite = await fetch(fund.url, { headers: host.endsWith('shirtigo.com') ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(60000) })
    if (zweite.ok) { const b2 = Buffer.from(await zweite.arrayBuffer()); if (istPdf(b2)) return b2 }
  }
  throw new Error('Shirtigo hat statt einer PDF eine unerwartete Antwort geliefert.')
}

// Antwort eines Tools als Daten (JSON, falls möglich)
function nutzdaten(r) {
  if (r?.structuredContent) return r.structuredContent
  const text = (r?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  try { return JSON.parse(text) } catch { return text }
}
function findeReferenz(x) {
  if (!x || typeof x !== 'object') return null
  if (typeof x.reference === 'string') return x.reference
  for (const v of Object.values(x)) { const r = findeReferenz(v); if (r) return r }
  return null
}

// Erkundung: ein paar echte Antworten in eine Datei schreiben, damit man sieht, welche Felder Shirtigo liefert
// (Preise, invoice_reference, Shopify-Bestellnummer ...). Ohne Token. Adressen/E-Mail sind nur mit der Adress-Berechtigung dabei.
async function probe(ziel) {
  const liste = nutzdaten(await aufrufen('list_orders', { limit: 3 }))
  const listeMit = nutzdaten(await aufrufen('list_orders', { limit: 2, include: 'products,payments' }))
  const referenz = findeReferenz(liste)
  const bestellung = referenz ? nutzdaten(await aufrufen('get_order', { reference: referenz })) : null
  const tools = await werkzeuge()
  fs.mkdirSync(path.dirname(ziel), { recursive: true })
  fs.writeFileSync(ziel, JSON.stringify({ werkzeuge: tools.map((t) => t.name), liste, listeMit, bestellung }, null, 2), 'utf8')
  return { referenz, datei: ziel, werkzeuge: tools.map((t) => t.name) }
}

module.exports = { einrichten, verbinden, werkzeuge, aufrufen, verbunden, probe, nutzdaten, pdfWerkzeug, rechnungPdf, werkzeugNamen: () => toolNamen }