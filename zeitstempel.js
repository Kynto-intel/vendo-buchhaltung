'use strict'
// Externer Anker für das Belegarchiv: Zeitstempel nach RFC 3161 (Plan 7.5 Punkt 4, Schritt 1.7).
//
// Ablauf „versiegeln“:
//   1. Integritätsprüfung des Archivs – ein beschädigtes Archiv wird nicht versiegelt.
//   2. Siegel-Dokument (JSON): Anzahl der Indexeinträge + letzter Kettenhash. Nur dessen SHA-256 geht an die Dienste –
//      keine Rechnungs- oder Kundendaten.
//   3. Je Dienst: Antwort (.tsr) sofort gegen den fest hinterlegten Vertrauensanker prüfen (openssl ts -verify).
//   4. Ablage im Archiv: Siegel (Art „siegel“), je Dienst die Antwort (Art „zeitstempel“), Vertrauensanker (Art „zertifikat“),
//      damit die Prüfung auch in Jahren offline möglich ist.
// „pruefen“: jede Zeitstempel-Antwort gegen Siegel und Anker prüfen (Gültigkeit zum Stempelzeitpunkt) und nachweisen, dass
// die Kette bis zum versiegelten Eintrag seitdem unverändert ist.
//
// Dienste (Entscheidung Nutzer 29.10.2026): Sectigo qualifiziert (eIDAS, Sectigo (Europe) S.L., Spanien) + FreeTSA
// (Würzburg). Anker-Fingerabdrücke am 29.10.2026 aus je zwei unabhängigen Quellen geprüft (siehe STAND.md).

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const VERTRAUEN = path.join(__dirname, 'vertrauen')
const DIENSTE = [
  {
    id: 'sectigo', name: 'Sectigo Qualified (eIDAS)', url: 'http://timestamp.sectigo.com/qualified', qualifiziert: true,
    anker: 'sectigo-qualified-time-stamping-root-r45.pem',
    ankerSha256: 'F8:71:F8:97:6B:40:68:D7:00:D5:F2:81:08:4B:4A:29:EA:F4:B8:F3:57:43:33:0B:A0:62:FA:B4:6F:58:C2:ED'
  },
  {
    id: 'freetsa', name: 'FreeTSA', url: 'https://freetsa.org/tsr', qualifiziert: false,
    anker: 'freetsa-root-ca.pem',
    ankerSha256: 'A6:37:9E:7C:EC:C0:5F:AA:3C:BF:07:60:13:D7:45:E3:27:BB:BA:A3:8C:0B:9A:F2:24:69:D4:70:1D:18:AA:BC'
  }
]
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex')

// ---------- OpenSSL (wird mit Git für Windows ausgeliefert; Pfad per VENDO_OPENSSL überschreibbar) ----------
let opensslPfad = null
function opensslFinden() {
  if (opensslPfad) return opensslPfad
  const kandidaten = [process.env.VENDO_OPENSSL, 'openssl',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'mingw64', 'bin', 'openssl.exe')].filter(Boolean)
  for (const k of kandidaten) {
    const lauf = spawnSync(k, ['version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
    if (lauf.status === 0 && /OpenSSL [3-9]/.test(lauf.stdout)) return (opensslPfad = k)
  }
  throw new Error('OpenSSL 3 wurde nicht gefunden (wird mit „Git für Windows“ installiert). Ohne OpenSSL können Zeitstempel nicht geprüft werden.')
}
function openssl(args) {
  const lauf = spawnSync(opensslFinden(), args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  const text = `${lauf.stdout || ''}\n${lauf.stderr || ''}`
  if (lauf.error || lauf.status !== 0) {
    const zeile = text.split('\n').map((z) => z.trim()).filter((z) => z && !z.startsWith('Using configuration')).pop()
    throw new Error(lauf.error?.message || zeile || `OpenSSL-Fehler ${lauf.status}`)
  }
  return text
}

// Vertrauensanker laden und gegen den fest hinterlegten Fingerabdruck prüfen
function anker(dienst) {
  const datei = path.isAbsolute(dienst.anker) ? dienst.anker : path.join(VERTRAUEN, dienst.anker)
  const pem = fs.readFileSync(datei)
  const ist = new crypto.X509Certificate(pem).fingerprint256
  if (ist !== dienst.ankerSha256) throw new Error(`Vertrauensanker von ${dienst.name} stimmt nicht (Fingerabdruck ${ist}).`)
  return { datei, pem }
}

// Angaben aus einer Antwort (openssl ts -reply -text)
function antwortLesen(tsrDatei) {
  const text = openssl(['ts', '-reply', '-in', tsrDatei, '-text'])
  const feld = (name) => text.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim()
  const zeit = new Date(feld('Time stamp'))
  return {
    status: feld('Status'), zeit: Number.isNaN(zeit.getTime()) ? null : zeit.toISOString(),
    seriennummer: feld('Serial number'), richtlinie: feld('Policy OID'), tsa: feld('TSA')
  }
}

// HTTP-Versand nach RFC 3161 (POST application/timestamp-query). Antwort wird danach kryptografisch geprüft.
async function httpSenden(url, anfrage) {
  const antwort = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/timestamp-query' }, body: anfrage, signal: AbortSignal.timeout(30_000) })
  if (!antwort.ok) throw new Error(`HTTP ${antwort.status}`)
  const daten = Buffer.from(await antwort.arrayBuffer())
  if (!daten.length || daten.length > 100_000) throw new Error('unerwartete Antwortgröße')
  return daten
}

function mitTempOrdner(fn) {
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'vendo-zeitstempel-'))
  const ende = () => fs.rmSync(ordner, { recursive: true, force: true })
  try {
    const erg = fn(ordner)
    if (erg && typeof erg.then === 'function') return erg.finally(ende)
    ende()
    return erg
  } catch (f) { ende(); throw f }
}

// ---------- Versiegeln ----------
// optionen: { archiv, dienste?, senden?(url, anfrage) → Buffer, jetzt?() → Date }
async function versiegeln({ archiv, dienste = DIENSTE, senden = httpSenden, jetzt = () => new Date() } = {}) {
  const pruefung = archiv.integritaet()
  if (!pruefung.ok) throw new Error(`Archiv nicht versiegelt: Die Integritätsprüfung meldet ${pruefung.fehler.length} Fehler.`)
  if (!pruefung.geprueft) throw new Error('Das Archiv ist leer – nichts zu versiegeln.')
  const erstellt = jetzt().toISOString()
  const siegel = {
    vorgang: 'Archivsiegel nach RFC 3161 (Plan 7.5, Schritt 1.7)', erstellt,
    archivEintraege: pruefung.geprueft, letzterHash: pruefung.letzterHash,
    hinweis: 'Belegt, dass die Index-Kette bis Eintrag archivEintraege mit letzterHash zum Stempelzeitpunkt existierte.',
    dienste: dienste.map((d) => ({ id: d.id, name: d.name, url: d.url, qualifiziert: d.qualifiziert }))
  }
  const siegelText = Buffer.from(JSON.stringify(siegel, null, 2), 'utf8')
  const siegelSha = sha(siegelText)

  return mitTempOrdner(async (tmp) => {
    const tsq = path.join(tmp, 'anfrage.tsq')
    openssl(['ts', '-query', '-digest', siegelSha, '-sha256', '-cert', '-out', tsq])
    const anfrage = fs.readFileSync(tsq)
    const ergebnisse = []
    for (const dienst of dienste) {
      try {
        const { datei: ankerDatei, pem } = anker(dienst)
        const antwort = await senden(dienst.url, anfrage)
        const tsr = path.join(tmp, `${dienst.id}.tsr`)
        fs.writeFileSync(tsr, antwort)
        // Status (granted/grantedWithMods) + Hash + Nonce + Signatur + Zertifikatskette bis zum Anker – sonst Fehler
        openssl(['ts', '-verify', '-queryfile', tsq, '-in', tsr, '-CAfile', ankerDatei])
        const info = antwortLesen(tsr)
        ergebnisse.push({ dienst, ok: true, antwort, pem, ...info })
      } catch (f) {
        ergebnisse.push({ dienst, ok: false, fehler: f.message })
      }
    }
    const gut = ergebnisse.filter((e) => e.ok)
    const bericht = { ok: gut.length > 0, archivEintraege: pruefung.geprueft, letzterHash: pruefung.letzterHash, dienste: ergebnisse.map((e) => ({ id: e.dienst.id, name: e.dienst.name, ok: e.ok, zeit: e.zeit, fehler: e.fehler })) }
    if (!gut.length) return { ...bericht, siegel: null } // nichts ablegen, wenn kein Dienst einen gültigen Stempel geliefert hat

    const jahr = Number(erstellt.slice(0, 4))
    const stempel = erstellt.slice(0, 19).replace(/:/g, '-')
    const neu = []
    const ablegen = (inhalt, angaben) => { const e = archiv.ablegen(inhalt, { ...angaben, jahr, sofortSchuetzen: false }); if (!e.doppelt) neu.push(e); return e }
    const s = ablegen(siegelText, { art: 'siegel', name: `Archivsiegel ${stempel}.json`, meta: { quelle: 'zeitstempel', archivEintraege: pruefung.geprueft, letzterHash: pruefung.letzterHash, dienste: gut.map((e) => e.dienst.id) } })
    for (const e of gut) {
      ablegen(e.pem, { art: 'zertifikat', name: e.dienst.anker.split(/[\\/]/).pop(), meta: { quelle: 'zeitstempel', dienst: e.dienst.id, fingerabdruck: e.dienst.ankerSha256 } })
      ablegen(e.antwort, { art: 'zeitstempel', name: `Zeitstempel ${e.dienst.id} ${stempel}.tsr`, meta: { quelle: 'zeitstempel', dienst: e.dienst.id, siegel: s.sha256, zeit: e.zeit, seriennummer: e.seriennummer, qualifiziert: e.dienst.qualifiziert } })
    }
    const schutz = archiv.nachSchuetzen(neu)
    return { ...bericht, siegel: s.datei, ...(schutz.schutzFehler ? { schutzFehler: schutz.schutzFehler } : {}) }
  })
}

// ---------- Prüfen aller Siegel im Archiv ----------
function pruefen({ archiv, dienste = DIENSTE } = {}) {
  const eintraege = archiv.eintraege()
  const siegel = eintraege.filter((e) => e.art === 'siegel')
  const ergebnisse = siegel.map((s) => {
    const fehler = []
    let inhalt = null
    try {
      const roh = fs.readFileSync(archiv.pfad(s))
      if (sha(roh) !== s.sha256) throw new Error('Siegel-Datei verändert')
      inhalt = JSON.parse(roh.toString('utf8'))
    } catch (f) { fehler.push(f.message) }
    // Kette bis zum versiegelten Eintrag unverändert? (Eintrag Nr. archivEintraege muss den versiegelten Hash tragen)
    if (inhalt) {
      const bezug = eintraege[inhalt.archivEintraege - 1]
      if (!bezug || bezug.nr !== inhalt.archivEintraege || bezug.hash !== inhalt.letzterHash) fehler.push(`Index-Kette bis Eintrag ${inhalt.archivEintraege} wurde seit dem Siegel verändert`)
    }
    const stempel = eintraege.filter((e) => e.art === 'zeitstempel' && e.meta?.siegel === s.sha256).map((z) => {
      const dienst = dienste.find((d) => d.id === z.meta.dienst)
      try {
        if (!dienst) throw new Error('unbekannter Dienst')
        const { datei } = anker(dienst)
        const zeit = Math.floor(Date.parse(z.meta.zeit) / 1000)
        openssl(['ts', '-verify', '-data', archiv.pfad(s), '-in', archiv.pfad(z), '-CAfile', datei, '-attime', String(zeit)]) // gültig zum Stempelzeitpunkt
        return { dienst: z.meta.dienst, zeit: z.meta.zeit, qualifiziert: !!z.meta.qualifiziert, ok: true }
      } catch (f) {
        return { dienst: z.meta.dienst, zeit: z.meta.zeit, ok: false, fehler: f.message }
      }
    })
    if (!stempel.length) fehler.push('kein Zeitstempel zu diesem Siegel')
    const gueltig = stempel.filter((x) => x.ok)
    return { siegel: s.datei, archivEintraege: inhalt?.archivEintraege, ok: !fehler.length && gueltig.length > 0, gueltig: gueltig.length, stempel, fehler }
  })
  const letztes = ergebnisse.filter((e) => e.ok).at(-1)
  const siegelArten = new Set(['siegel', 'zeitstempel', 'zertifikat'])
  return {
    ok: ergebnisse.every((e) => e.ok), anzahl: ergebnisse.length, ergebnisse,
    zuletzt: letztes ? { zeit: letztes.stempel.find((x) => x.ok)?.zeit, archivEintraege: letztes.archivEintraege } : null,
    // Belege, die nach dem letzten gültigen Siegel dazugekommen sind (Siegel-Einträge selbst zählen nicht)
    nochNichtVersiegelt: eintraege.filter((e) => e.nr > (letztes?.archivEintraege || 0) && !siegelArten.has(e.art)).length
  }
}

module.exports = { versiegeln, pruefen, DIENSTE, opensslFinden }
