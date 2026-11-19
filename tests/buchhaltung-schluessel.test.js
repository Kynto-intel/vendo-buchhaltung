import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// Tests für den Wiederherstellungsschlüssel der USB-Sicherung (plugins/buchhaltung/schluessel.js), Plan-Schritt 1.8.
// Der Windows-Tresor (Electron safeStorage) wird durch einen Test-Tresor mit AES-256-GCM ersetzt. Nur Temp-Ordner.

const require = createRequire(import.meta.url)
const s = require('../schluessel.js')

function testTresor({ verfuegbar = true } = {}) {
  const k = crypto.randomBytes(32)
  return {
    verfuegbar: () => verfuegbar,
    verschluesseln(text) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', k, iv); const d = Buffer.concat([c.update(text, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), d]) },
    entschluesseln(b) { const d = crypto.createDecipheriv('aes-256-gcm', k, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8') }
  }
}
function ablage(t, tresor = testTresor()) {
  const o = fs.mkdtempSync(path.join(os.tmpdir(), 'vendo-schluessel-test-'))
  t.after(() => fs.rmSync(o, { recursive: true, force: true }))
  const datei = path.join(o, 'userData', 'rechnungen-usb-schluessel.bin')
  return { sp: s.speicher({ tresor, datei }), datei, tresor }
}

test('Schlüssel: 6 Gruppen à 5 aus verwechslungsfreien Zeichen, zufällig, mit Prüfzeichen (Schritt 1.8)', () => {
  const k = s.erzeugen()
  assert.match(k, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){5}$/)
  assert.equal(/[ILOU]/.test(k), false)
  assert.equal(s.normalisieren(k), k)
  const viele = new Set(Array.from({ length: 2000 }, () => s.erzeugen()))
  assert.equal(viele.size, 2000, 'keine Wiederholung')
  // grobe Gleichverteilung der Zeichen (ohne Prüfzeichen): jedes der 32 Zeichen kommt vor, keines dominiert
  const zaehler = new Map()
  for (const x of viele) for (const z of x.replace(/-/g, '').slice(0, -1)) zaehler.set(z, (zaehler.get(z) || 0) + 1)
  assert.equal(zaehler.size, 32)
  const erwartet = (2000 * 29) / 32
  for (const [z, n] of zaehler) assert.ok(n > erwartet * 0.85 && n < erwartet * 1.15, `${z}: ${n}`)
})

test('Eingabe vom Blatt: tolerant bei Schreibweise und O/0, I/L/1 – Tippfehler und falsche Länge werden erkannt (Schritt 1.8)', () => {
  const k = s.erzeugen()
  assert.equal(s.normalisieren(k.toLowerCase().replace(/-/g, ' ')), k)
  assert.equal(s.normalisieren(`  ${k.replace(/-/g, '')}  `), k)
  const mitVerwechslung = k.replace(/0/g, 'O').replace(/1/g, 'l')
  assert.equal(s.normalisieren(mitVerwechslung), k)
  assert.throws(() => s.normalisieren(k.slice(0, -1)), /30 Zeichen .* 29/)
  assert.throws(() => s.normalisieren(k.slice(0, -1) + 'U'), /ungültiges Zeichen/)
  // jede einzelne Vertauschung eines Zeichens: fast immer erkannt (Prüfzeichen 5 Bit)
  const roh = k.replace(/-/g, '')
  let erkannt = 0
  let gesamt = 0
  for (let i = 0; i < roh.length; i++) {
    for (const z of s.ZEICHEN) {
      if (z === roh[i]) continue
      gesamt++
      try { s.normalisieren(roh.slice(0, i) + z + roh.slice(i + 1)) } catch { erkannt++ }
    }
  }
  assert.ok(erkannt / gesamt > 0.93, `${erkannt}/${gesamt} Tippfehler erkannt`)
})

test('Kennung ist stabil, verrät den Schlüssel nicht; Ableitung für AES-256 ist deterministisch und salzabhängig (Schritt 1.8)', () => {
  const k = s.erzeugen()
  const id = s.kennung(k)
  assert.match(id, /^[0-9A-F]{4}-[0-9A-F]{4}$/)
  assert.equal(s.kennung(k.toLowerCase()), id)
  assert.notEqual(s.kennung(s.erzeugen()), id)
  for (const gruppe of k.split('-')) assert.equal(id.includes(gruppe.slice(0, 4)), false)
  const salz = crypto.randomBytes(16)
  const leicht = { N: 2 ** 10, r: 8, p: 1 }
  const a = s.ableiten(k, salz, leicht)
  assert.equal(a.length, 32)
  assert.deepEqual(s.ableiten(k.toLowerCase(), salz, leicht), a)
  assert.notDeepEqual(s.ableiten(k, crypto.randomBytes(16), leicht), a)
  assert.throws(() => s.ableiten(k, Buffer.alloc(8)), /Salz/)
  const t0 = Date.now()
  assert.equal(s.ableiten(k, salz).length, 32, 'Standardparameter (scrypt N=2^17) laufen durch')
  assert.ok(Date.now() - t0 > 30, 'bewusst langsam gegen Durchprobieren')
})

test('Ablage: nur verschlüsselt, Status ohne Schlüssel, Bestätigung durch Eintippen, kein Überschreiben (Schritt 1.8)', (t) => {
  const { sp, datei } = ablage(t)
  assert.deepEqual(sp.status(), { vorhanden: false, bestaetigt: false, kennung: null, erstellt: null, bestaetigtAm: null, verschluesselung: true })
  assert.throws(() => sp.laden(), /Kein bestätigter/)

  const neu = sp.neu(new Date('2026-10-29T10:00:00Z'))
  assert.equal(s.normalisieren(neu.schluessel), neu.schluessel)
  const roh = fs.readFileSync(datei)
  for (const g of neu.schluessel.split('-')) assert.equal(roh.includes(Buffer.from(g)), false, 'Schlüssel steht nicht im Klartext in der Datei')
  const st = sp.status()
  assert.deepEqual([st.vorhanden, st.bestaetigt, st.kennung, st.erstellt], [true, false, neu.kennung, '2026-10-29T10:00:00.000Z'])
  assert.equal(JSON.stringify(st).includes(neu.schluessel), false, 'Status enthält den Schlüssel nicht')
  assert.throws(() => sp.laden(), /Kein bestätigter/, 'unbestätigt nicht benutzbar')

  // unbestätigt darf neu erzeugt werden – das alte Blatt gilt dann nicht mehr
  const zweit = sp.neu()
  assert.notEqual(zweit.schluessel, neu.schluessel)
  assert.throws(() => sp.bestaetigen(neu.schluessel), /stimmt nicht/)
  assert.throws(() => sp.bestaetigen('ABCDE'), /30 Zeichen/)
  assert.equal(sp.status().bestaetigt, false)

  assert.deepEqual(sp.bestaetigen(zweit.schluessel.toLowerCase().replace(/-/g, '')), { bestaetigt: true, kennung: zweit.kennung })
  assert.equal(sp.status().bestaetigt, true)
  assert.equal(sp.laden(), zweit.schluessel)
  assert.throws(() => sp.neu(), /schon einen bestätigten .* nicht ersetzt/)
  assert.throws(() => sp.eingeben(s.erzeugen()), /schon einen bestätigten/)
  assert.equal(sp.laden(), zweit.schluessel, 'bleibt unverändert')
})

test('Ohne Verschlüsselung wird nichts gespeichert; neuer PC: Schlüssel vom Blatt eingeben; fremde/unlesbare Datei (Schritt 1.8)', (t) => {
  const ohne = ablage(t, testTresor({ verfuegbar: false }))
  assert.throws(() => ohne.sp.neu(), /nicht im Klartext/)
  assert.equal(fs.existsSync(ohne.datei), false)
  assert.equal(ohne.sp.status().verschluesselung, false)

  const blatt = s.erzeugen()
  const pc2 = ablage(t)
  assert.throws(() => pc2.sp.eingeben(blatt.slice(0, -1) + (blatt.at(-1) === '0' ? '1' : '0')), /nicht stimmig|ungültig/)
  assert.deepEqual(pc2.sp.eingeben(blatt), { bestaetigt: true, kennung: s.kennung(blatt) })
  assert.equal(pc2.sp.laden(), blatt)

  // Datei von einem anderen Windows-Konto (anderer Tresor) ist unlesbar → Status meldet es, Blatt-Eingabe ersetzt sie
  const fremd = s.speicher({ tresor: testTresor(), datei: pc2.datei })
  assert.match(fremd.status().fehler, /nicht lesbar/)
  assert.throws(() => fremd.laden(), /nicht lesbar/)
  fremd.eingeben(blatt)
  assert.equal(fremd.laden(), blatt)
})
