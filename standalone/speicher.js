'use strict'
// Plugin-Daten im eigenständigen Betrieb: eine JSON-Datei im Datenordner, atomar geschrieben
// (temporäre Datei + fsync + Umbenennen). datenLaden liefert wie in Vendo jedes Mal eine frische Kopie.

const fs = require('node:fs')
const path = require('node:path')

const GRENZE = 50 * 1024 * 1024 // wie groß die Plugin-Daten höchstens werden dürfen

function jsonSpeicher(datei) {
  let text = null
  try { text = fs.readFileSync(datei, 'utf8') } catch (f) { if (f.code !== 'ENOENT') throw f }
  if (text != null) JSON.parse(text) // kaputte Datei: lieber nicht starten als mit {} weiterarbeiten und überschreiben

  return {
    datei,
    laden: () => (text ? JSON.parse(text) : {}),
    speichern(daten) {
      const neu = JSON.stringify(daten ?? {}, null, 2)
      if (neu.length > GRENZE) throw new Error('Plugin-Daten zu groß.')
      fs.mkdirSync(path.dirname(datei), { recursive: true })
      const temp = `${datei}.${process.pid}.neu`
      const fd = fs.openSync(temp, 'w', 0o600)
      try {
        fs.writeSync(fd, neu, null, 'utf8')
        fs.fsyncSync(fd)
      } finally { fs.closeSync(fd) }
      fs.renameSync(temp, datei)
      text = neu
      return true
    }
  }
}

module.exports = { jsonSpeicher, GRENZE }
