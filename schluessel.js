'use strict'
// Wiederherstellungsschlüssel für die verschlüsselte USB-Sicherung (Plan 7.5 Punkt 6, Schritt 1.8).
//
// - 30 Zeichen in 6 Gruppen à 5 (z. B. K7QF2-…), Zeichenvorrat ohne Verwechslungsgefahr (Crockford-Base32: ohne I, L, O, U),
//   29 Zufallszeichen (145 Bit) + 1 Prüfzeichen gegen Tippfehler.
// - Kennung (z. B. 7F3A-91C2): aus dem Schlüssel abgeleitet, verrät ihn nicht; steht auf dem Blatt und später auf dem Stick.
// - Ablage nur verschlüsselt über den „Tresor“ (in der App: Electron safeStorage = Windows-DPAPI, nur unter dem eigenen
//   Windows-Konto lesbar). Ohne verfügbare Verschlüsselung wird nichts gespeichert – nie im Klartext.
// - Erst nach einmaligem Eintippen gilt der Schlüssel als bestätigt; ein bestätigter Schlüssel wird nie überschrieben
//   (sonst wären vorhandene Sicherungen nicht mehr lesbar).

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const ZEICHEN = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // 32 Zeichen = 5 Bit
const GRUPPEN = 6
const GROESSE = 5
const LAENGE = GRUPPEN * GROESSE

const pruefzeichen = (roh29) => ZEICHEN[crypto.createHash('sha256').update(`vendo-usb-pruef:${roh29}`).digest()[0] & 31]
const gruppieren = (roh) => roh.match(new RegExp(`.{${GROESSE}}`, 'g')).join('-')

// Eingabe vom Blatt: Groß/klein egal, Leerzeichen/Bindestriche egal, O→0 und I/L→1 (typische Verwechslungen)
function normalisieren(eingabe) {
  const roh = String(eingabe || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (roh.length !== LAENGE) throw new Error(`Der Wiederherstellungsschlüssel hat ${LAENGE} Zeichen (6 Gruppen à 5) – eingegeben wurden ${roh.length}.`)
  if ([...roh].some((z) => !ZEICHEN.includes(z))) throw new Error('Der Schlüssel enthält ein ungültiges Zeichen (erlaubt: Ziffern und Buchstaben außer I, L, O, U).')
  if (pruefzeichen(roh.slice(0, -1)) !== roh.at(-1)) throw new Error('Der Schlüssel ist nicht stimmig – bitte auf Tippfehler prüfen.')
  return gruppieren(roh)
}

function erzeugen() {
  let roh = ''
  for (let i = 0; i < LAENGE - 1; i++) roh += ZEICHEN[crypto.randomInt(ZEICHEN.length)]
  return gruppieren(roh + pruefzeichen(roh))
}

function kennung(schluessel) {
  const h = crypto.createHash('sha256').update(`vendo-usb-kennung:${normalisieren(schluessel)}`).digest('hex').toUpperCase()
  return `${h.slice(0, 4)}-${h.slice(4, 8)}`
}

// Für Schritt 1.9: 256-Bit-Schlüssel für AES-256-GCM aus Wiederherstellungsschlüssel + Salz (liegt später auf dem Stick)
const KDF = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }
function ableiten(schluessel, salz, kdf = KDF) {
  if (!Buffer.isBuffer(salz) || salz.length < 16) throw new Error('Salz fehlt oder ist zu kurz.')
  return crypto.scryptSync(normalisieren(schluessel), salz, 32, kdf)
}

// ---------- Ablage ----------
// tresor: { verfuegbar() → bool, verschluesseln(text) → Buffer, entschluesseln(Buffer) → text }; datei: Ablagepfad
function speicher({ tresor, datei }) {
  if (!tresor || !datei) throw new Error('Tresor und Ablagedatei fehlen.')
  const lesen = () => {
    if (!fs.existsSync(datei)) return null
    try { return JSON.parse(tresor.entschluesseln(fs.readFileSync(datei))) } catch { throw new Error('Der gespeicherte Schlüssel ist nicht lesbar (anderes Windows-Konto oder beschädigt). Mit dem Wiederherstellungsblatt neu eingeben.') }
  }
  const schreiben = (daten) => {
    if (!tresor.verfuegbar()) throw new Error('Verschlüsselte Ablage ist auf diesem System nicht verfügbar – der Schlüssel wird nicht im Klartext gespeichert.')
    fs.mkdirSync(path.dirname(datei), { recursive: true })
    const temp = `${datei}.neu`
    fs.writeFileSync(temp, tresor.verschluesseln(JSON.stringify(daten)))
    fs.renameSync(temp, datei)
  }
  const sperreBestaetigt = (alt) => { if (alt?.bestaetigt) throw new Error(`Es gibt schon einen bestätigten Wiederherstellungsschlüssel (Kennung ${alt.kennung}). Er wird nicht ersetzt, sonst wären vorhandene Sicherungen nicht mehr lesbar.`) }

  return {
    // Status ohne den Schlüssel selbst – darf an die Oberfläche
    status() {
      let d = null
      let fehler = null
      try { d = lesen() } catch (f) { fehler = f.message }
      return { vorhanden: !!d, bestaetigt: !!d?.bestaetigt, kennung: d?.kennung || null, erstellt: d?.erstellt || null, bestaetigtAm: d?.bestaetigt || null, verschluesselung: !!tresor.verfuegbar(), ...(fehler ? { fehler } : {}) }
    },
    // Neuen Schlüssel erzeugen (ersetzt nur einen noch unbestätigten). Rückgabe enthält den Schlüssel – einmalig fürs Blatt.
    neu(jetzt = new Date()) {
      sperreBestaetigt(lesen())
      const schluessel = erzeugen()
      const daten = { schluessel, kennung: kennung(schluessel), erstellt: jetzt.toISOString(), bestaetigt: null }
      schreiben(daten)
      return { schluessel, kennung: daten.kennung, erstellt: daten.erstellt }
    },
    // Kontrolle: der vom Blatt eingetippte Schlüssel muss genau dem gespeicherten entsprechen
    bestaetigen(eingabe, jetzt = new Date()) {
      const d = lesen()
      if (!d) throw new Error('Es wurde noch kein Wiederherstellungsschlüssel erzeugt.')
      if (d.bestaetigt) return { bestaetigt: true, kennung: d.kennung }
      const n = normalisieren(eingabe)
      if (!crypto.timingSafeEqual(Buffer.from(n), Buffer.from(d.schluessel))) throw new Error('Der eingetippte Schlüssel stimmt nicht mit dem Blatt überein. Bitte noch einmal vergleichen.')
      schreiben({ ...d, bestaetigt: jetzt.toISOString() })
      return { bestaetigt: true, kennung: d.kennung }
    },
    // Neuer PC: Schlüssel vom vorhandenen Blatt eingeben (nur wenn hier noch keiner bestätigt ist)
    eingeben(eingabe, jetzt = new Date()) {
      let alt = null
      try { alt = lesen() } catch { /* unlesbare Altdatei (z. B. anderes Konto) darf durch das Blatt ersetzt werden */ }
      sperreBestaetigt(alt)
      const schluessel = normalisieren(eingabe)
      schreiben({ schluessel, kennung: kennung(schluessel), erstellt: jetzt.toISOString(), bestaetigt: jetzt.toISOString(), vomBlatt: true })
      return { bestaetigt: true, kennung: kennung(schluessel) }
    },
    // Nur im Hauptprozess (USB-Sicherung, Schritt 1.9) – nie an die Oberfläche geben
    laden() {
      const d = lesen()
      if (!d?.bestaetigt) throw new Error('Kein bestätigter Wiederherstellungsschlüssel vorhanden. Bitte zuerst „USB-Sicherung einrichten“.')
      return d.schluessel
    }
  }
}

module.exports = { erzeugen, normalisieren, kennung, ableiten, speicher, ZEICHEN, LAENGE }
