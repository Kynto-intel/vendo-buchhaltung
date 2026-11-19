'use strict'
// Erzeugt ../plz.json (Postleitzahl -> [Breite, Länge]) aus den GeoNames-Postleitzahlen (CC BY 4.0, https://www.geonames.org).
//
// Aufruf (im Plugin-Ordner):
//   node tools/plz-bauen.js                 -> DE, AT, CH laden
//   node tools/plz-bauen.js DE AT CH NL FR  -> beliebige Länder (ISO-Codes)
//   node tools/plz-bauen.js --lokal C:\Downloads DE AT   -> statt Download die Dateien DE.zip, AT.zip aus diesem Ordner lesen
//
// Läuft ohne zusätzliche Pakete (nur Node). Die Datei plz.json bleibt lokal; Kundenadressen werden hier nie verwendet.

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { plzSchluessel } = require('../geo')

const URL_BASIS = 'https://download.geonames.org/export/zip'

// Liest eine Datei aus einer ZIP (zentrales Verzeichnis, Methode "stored" oder "deflate")
function ausZip(buf, dateiname) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('Keine gültige ZIP-Datei.')
  const anzahl = buf.readUInt16LE(eocd + 10)
  let pos = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < anzahl; n++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('ZIP-Verzeichnis beschädigt.')
    const methode = buf.readUInt16LE(pos + 10)
    const groesse = buf.readUInt32LE(pos + 20)
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const kommentarLen = buf.readUInt16LE(pos + 32)
    const lokal = buf.readUInt32LE(pos + 42)
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen)
    pos += 46 + nameLen + extraLen + kommentarLen
    if (name !== dateiname) continue
    const start = lokal + 30 + buf.readUInt16LE(lokal + 26) + buf.readUInt16LE(lokal + 28)
    const roh = buf.subarray(start, start + groesse)
    return methode === 0 ? roh : zlib.inflateRawSync(roh)
  }
  throw new Error(`${dateiname} nicht in der ZIP gefunden.`)
}

async function holen(land, lokalOrdner) {
  if (lokalOrdner) return fs.readFileSync(path.join(lokalOrdner, `${land}.zip`))
  const antwort = await fetch(`${URL_BASIS}/${land}.zip`, { signal: AbortSignal.timeout(120000) })
  if (!antwort.ok) throw new Error(`Download ${land}.zip: Fehler ${antwort.status}`)
  return Buffer.from(await antwort.arrayBuffer())
}

async function main() {
  const args = process.argv.slice(2)
  let lokal = null
  const i = args.indexOf('--lokal')
  if (i >= 0) { lokal = args[i + 1]; args.splice(i, 2) }
  const laender = (args.length ? args : ['DE', 'AT', 'CH']).map((l) => l.toUpperCase())

  const aus = { _quelle: 'GeoNames postal codes, CC BY 4.0, https://www.geonames.org' }
  for (const land of laender) {
    process.stdout.write(`${land} … `)
    const text = ausZip(await holen(land, lokal), `${land}.txt`).toString('utf8')
    const tabelle = {}
    let n = 0
    for (const zeile of text.split('\n')) {
      const c = zeile.split('\t')
      if (c.length < 11) continue
      const lat = parseFloat(c[9])
      const lon = parseFloat(c[10])
      const plz = plzSchluessel(land, c[1])
      if (!plz || !Number.isFinite(lat) || !Number.isFinite(lon) || tabelle[plz]) continue // erste Angabe je PLZ genügt
      tabelle[plz] = [Math.round(lat * 100) / 100, Math.round(lon * 100) / 100]
      n++
    }
    aus[land] = tabelle
    console.log(`${n} Postleitzahlen`)
  }
  const ziel = path.join(__dirname, '..', 'plz.json')
  fs.writeFileSync(ziel, JSON.stringify(aus), 'utf8')
  console.log(`Geschrieben: ${ziel} (${Math.round(fs.statSync(ziel).size / 1024)} KB)`)
}

main().catch((e) => { console.error('Fehler:', e.message); process.exit(1) })