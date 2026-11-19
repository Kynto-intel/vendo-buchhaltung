import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Tests für den Windows-Dateischutz (plugins/buchhaltung/schutz.js) und das Zusammenspiel mit archiv.js, Plan-Schritt 1.2.
// Echte NTFS-Rechte, aber nur in frischen Temp-Ordnern mit synthetischen Dateien. Nach jedem Test werden die
// Verweigerungen wieder entfernt und die Ordner gelöscht.

const require = createRequire(import.meta.url)
const schutz = require('../schutz.js')
const { archiv } = require('../archiv.js')
const nurWindows = { skip: process.platform !== 'win32' && 'NTFS-Rechte gibt es nur unter Windows' }

function alleUnter(o) {
  return fs.readdirSync(o, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(o, d.name)
    return d.isDirectory() ? [p, ...alleUnter(p)] : [p]
  })
}
function tempOrdner(t) {
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'vendo-schutz-test-'))
  t.after(() => {
    if (!fs.existsSync(ordner)) return
    const alle = [ordner, ...alleUnter(ordner)]
    schutz.entsperren({ dateien: alle.filter((p) => fs.statSync(p).isFile()), ordner: alle.filter((p) => fs.statSync(p).isDirectory()) })
    for (const p of alle) if (fs.statSync(p).isFile()) fs.chmodSync(p, 0o666)
    fs.rmSync(ordner, { recursive: true, force: true })
  })
  return ordner
}
const code = (fn) => { try { fn(); return 'ok' } catch (e) { return e.code } }

// Unabhängige Gegenkontrolle: liest die Deny-Rechte des eigenen Kontos direkt über Get-Acl aus (nicht über schutz.js)
function denyRechte(p) {
  const skript = "$sid=([System.Security.Principal.WindowsIdentity]::GetCurrent()).User; (Get-Acl -LiteralPath $env:ZIEL).Access | Where-Object { $_.AccessControlType -eq 'Deny' -and $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]) -eq $sid } | ForEach-Object { [int]$_.FileSystemRights }"
  const lauf = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', skript], { env: { ...process.env, ZIEL: p }, encoding: 'utf8', windowsHide: true })
  return String(lauf.stdout).trim().split(/\s+/).filter(Boolean).reduce((s, x) => s | Number(x), 0)
}
// Windows-Rechtebits (FileSystemRights)
const RECHT = { WriteData: 0x2, AppendData: 0x4, WriteExtendedAttributes: 0x10, DeleteSubdirectoriesAndFiles: 0x40, WriteAttributes: 0x100, Delete: 0x10000, Synchronize: 0x100000 }

test('Geschützte Datei: lesen ja; löschen, ändern, umbenennen, entsperren nein', nurWindows, (t) => {
  const ordner = tempOrdner(t)
  const datei = path.join(ordner, 'Beleg ä (1).pdf')
  fs.writeFileSync(datei, 'synthetischer Beleg')
  const erg = schutz.schuetzen({ dateien: [datei], ordner: [ordner] })
  assert.equal(erg.erfolgreich, true, erg.fehler.join('; '))

  assert.equal(fs.readFileSync(datei, 'utf8'), 'synthetischer Beleg')
  assert.equal(code(() => fs.rmSync(datei)), 'EPERM')
  assert.equal(code(() => fs.appendFileSync(datei, 'x')), 'EPERM')
  assert.equal(code(() => fs.writeFileSync(datei, 'weg')), 'EPERM')
  assert.equal(code(() => fs.renameSync(datei, `${datei}.weg`)), 'EPERM')
  assert.equal(code(() => fs.chmodSync(datei, 0o666)), 'EPERM')
  assert.equal(code(() => fs.rmSync(ordner, { recursive: true })), 'EPERM')
  assert.equal(code(() => fs.writeFileSync(path.join(ordner, 'neu.pdf'), 'neu', { flag: 'wx' })), 'ok', 'neue Dateien bleiben möglich')
  assert.equal(fs.readFileSync(datei, 'utf8'), 'synthetischer Beleg')

  assert.deepEqual(schutz.pruefen({ dateien: [datei], ordner: [ordner] }).ungeschuetzt, [])

  const d = denyRechte(datei)
  for (const recht of ['Delete', 'WriteData', 'AppendData', 'WriteAttributes', 'WriteExtendedAttributes']) assert.ok(d & RECHT[recht], `Datei: ${recht} muss verweigert sein`)
  assert.equal(d & RECHT.Synchronize, 0, 'Synchronize darf nicht verweigert sein (sonst ist Lesen blockiert)')
  const o = denyRechte(ordner)
  for (const recht of ['Delete', 'DeleteSubdirectoriesAndFiles']) assert.ok(o & RECHT[recht], `Ordner: ${recht} muss verweigert sein`)
  assert.equal(o & (RECHT.WriteData | RECHT.AppendData), 0, 'Ordner: Dateien/Unterordner anlegen bleibt erlaubt')
})

test('Index: darf wachsen, aber nicht gelöscht werden', nurWindows, (t) => {
  const ordner = tempOrdner(t)
  const index = path.join(ordner, 'index.jsonl')
  fs.writeFileSync(index, '{"nr":1}\n')
  assert.equal(schutz.schuetzen({ nurLoeschen: [index], ordner: [ordner] }).erfolgreich, true)
  assert.equal(code(() => fs.appendFileSync(index, '{"nr":2}\n')), 'ok')
  assert.equal(code(() => fs.rmSync(index)), 'EPERM')
  assert.equal(fs.readFileSync(index, 'utf8'), '{"nr":1}\n{"nr":2}\n')
  assert.equal(denyRechte(index), RECHT.Delete, 'Index: genau Löschen verweigert')
})

test('Schützen ist wiederholbar; Prüfen und Entsperren arbeiten korrekt', nurWindows, (t) => {
  const ordner = tempOrdner(t)
  const datei = path.join(ordner, 'a.pdf')
  fs.writeFileSync(datei, 'a')
  assert.deepEqual(schutz.pruefen({ dateien: [datei] }).ungeschuetzt, [datei])
  assert.equal(schutz.schuetzen({ dateien: [datei] }).erfolgreich, true)
  assert.equal(schutz.schuetzen({ dateien: [datei] }).erfolgreich, true, 'zweimal schützen schadet nicht')
  assert.deepEqual(schutz.pruefen({ dateien: [datei] }).geschuetzt, [datei])
  assert.equal(schutz.entsperren({ dateien: [datei] }).erfolgreich, true)
  assert.deepEqual(schutz.pruefen({ dateien: [datei] }).ungeschuetzt, [datei])
  assert.equal(code(() => fs.rmSync(datei)), 'ok')
})

test('Fehler werden gemeldet statt geworfen; relative Pfade werden abgelehnt', nurWindows, (t) => {
  const ordner = tempOrdner(t)
  const erg = schutz.schuetzen({ dateien: [path.join(ordner, 'gibt-es-nicht.pdf')] })
  assert.equal(erg.erfolgreich, false)
  assert.equal(erg.fehler.length, 1)
  assert.throws(() => schutz.schuetzen({ dateien: ['relativ.pdf'] }), /absolute Pfade/)
  assert.equal(schutz.schuetzen({}).erfolgreich, true, 'nichts zu tun ist kein Fehler')
})

test('Archiv mit echtem Schutz: abgelegte Belege, Ordner und Index sind gegen Löschen gesperrt', nurWindows, (t) => {
  const wurzel = tempOrdner(t)
  const a = archiv(wurzel, { schutz })
  const e = a.ablegen(Buffer.from('%PDF synthetisch'), { art: 'umsatzbeleg', jahr: 2026, name: 'Beleg.pdf' })
  assert.equal(e.geschuetzt, true, (e.schutzFehler || []).join('; '))
  const datei = a.pfad(e)
  assert.equal(code(() => fs.rmSync(datei)), 'EPERM')
  assert.equal(code(() => fs.rmSync(a.INDEX)), 'EPERM')
  assert.equal(code(() => fs.rmSync(path.join(wurzel, '2026'), { recursive: true })), 'EPERM')
  const e2 = a.ablegen(Buffer.from('%PDF zweiter'), { art: 'umsatzbeleg', jahr: 2026, name: 'Beleg2.pdf' })
  assert.equal(e2.geschuetzt, true, 'weiteres Ablegen in geschützte Ordner funktioniert')
  assert.equal(a.integritaet().ok, true)
  const pruef = schutz.pruefen({ dateien: [datei, a.pfad(e2)], nurLoeschen: [a.INDEX], ordner: [wurzel, path.join(wurzel, '2026'), path.join(wurzel, '2026', 'umsatzbeleg')] })
  assert.equal(pruef.erfolgreich, true, pruef.ungeschuetzt.join('; '))
})

test('Große Mengen werden mit echten NTFS-Rechten vollständig geschützt, geprüft und entsperrt (Schritt 1.4)', nurWindows, (t) => {
  const ordner = tempOrdner(t)
  const unter = path.join(ordner, 'synthetisch-langer-ordnername-fuer-den-paket-test-'.repeat(2))
  fs.mkdirSync(unter)
  const dateien = Array.from({ length: 400 }, (_, i) => {
    const p = path.join(unter, `Synthetischer Beleg mit langem Namen fuer den Paket-Test Nummer ${String(i).padStart(4, '0')}.pdf`)
    fs.writeFileSync(p, `synthetisch ${i}`)
    return p
  })
  const ziele = { dateien, ordner: [unter] }
  const erg = schutz.schuetzen(ziele)
  assert.equal(erg.erfolgreich, true, erg.fehler.join('; '))
  assert.equal(erg.ok.length, 401)
  const pr = schutz.pruefen(ziele)
  assert.deepEqual([pr.erfolgreich, pr.geschuetzt.length, pr.ungeschuetzt.length], [true, 401, 0])
  for (const p of [dateien[0], dateien[199], dateien[399]]) assert.equal(denyRechte(p) & RECHT.Delete, RECHT.Delete, 'unabhängig per Get-Acl bestätigt')
  assert.equal(code(() => fs.rmSync(dateien[399])), 'EPERM')
  const frei = schutz.entsperren(ziele)
  assert.equal(frei.erfolgreich, true)
  assert.equal(schutz.pruefen(ziele).ungeschuetzt.length, 401)
})

test('Pakete: große Aufträge werden auf mehrere kurze PowerShell-Läufe verteilt, Ergebnisse zusammengeführt (Schritt 1.4)', () => {
  // schutz.js mit gestubbtem spawnSync laden (Muster wie bei bestellungen.js), damit kein echtes PowerShell läuft
  const quelle = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schutz.js'), 'utf8')
  const laeufe = []
  const stub = {
    spawnSync(_exe, _args, { env }) {
      const auftrag = JSON.parse(env.VENDO_SCHUTZ)
      laeufe.push(auftrag)
      const alle = [...auftrag.dateien, ...auftrag.nurLoeschen, ...auftrag.ordner]
      const fehler = laeufe.length === 2 ? [`${alle[0]}: synthetischer Fehler`] : []
      return { status: 0, stdout: JSON.stringify({ ok: alle.slice(fehler.length), fehler, geschuetzt: [], ungeschuetzt: [] }) }
    }
  }
  const modul = { exports: {} }
  const plattform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    new Function('require', 'module', 'exports', quelle)((n) => n === 'node:child_process' ? stub : require(n), modul, modul.exports)
    const wurzel = path.join(os.tmpdir(), 'vendo-paket-test')
    const dateien = Array.from({ length: 1500 }, (_, i) => path.join(wurzel, '2024', 'umsatzbeleg', `Umsatzbeleg Bestellung ${10000 + i}__0123456789ab.pdf`))
    const erg = modul.exports.schuetzen({ dateien, nurLoeschen: [path.join(wurzel, 'index.jsonl')], ordner: [wurzel] })
    assert.ok(laeufe.length >= 10, `mehrere Läufe (${laeufe.length})`)
    for (const l of laeufe) assert.ok([...l.dateien, ...l.nurLoeschen, ...l.ordner].length <= 200, 'jeder Lauf bleibt kurz')
    assert.deepEqual(laeufe.flatMap((l) => l.dateien), dateien, 'jede Datei genau einmal, in Reihenfolge')
    assert.deepEqual(laeufe.flatMap((l) => l.nurLoeschen), [path.join(wurzel, 'index.jsonl')])
    assert.deepEqual(laeufe.every((l) => l.modus === 'schuetzen'), true)
    assert.equal(erg.ok.length, 1501, 'Ergebnisse aller Läufe zusammengeführt')
    assert.equal(erg.fehler.length, 1, 'Fehler aus Lauf 2 gemeldet, die übrigen Läufe liefen weiter')
    assert.equal(erg.erfolgreich, false)
  } finally {
    Object.defineProperty(process, 'platform', plattform)
  }
})
