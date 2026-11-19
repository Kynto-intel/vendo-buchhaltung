import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// Tests für die verschlüsselte USB-Sicherung (plugins/buchhaltung/usb.js), Plan-Schritt 1.9.
// Ein Temp-Ordner spielt den Stick; echtes archiv.js mit synthetischen Belegen; echte AES-256-GCM-Verschlüsselung.
// Nur scrypt läuft mit leichteren Testparametern (auf dem Stick steht, welche benutzt wurden). Kein echter Stick.

const require = createRequire(import.meta.url)
const usb = require('../usb.js')
const { archiv } = require('../archiv.js')
const schluessel = require('../schluessel.js')
const KDF = { N: 2 ** 10, r: 8, p: 1 }
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex')

function temp(t, name) {
  const o = fs.mkdtempSync(path.join(os.tmpdir(), `vendo-usb-${name}-`))
  t.after(() => {
    const alle = (x) => fs.existsSync(x) ? fs.readdirSync(x, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? alle(path.join(x, d.name)) : [path.join(x, d.name)]) : []
    for (const d of alle(o)) fs.chmodSync(d, 0o666)
    fs.rmSync(o, { recursive: true, force: true })
  })
  return o
}
const alleDateien = (o) => fs.existsSync(o) ? fs.readdirSync(o, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? alleDateien(path.join(o, d.name)) : [path.join(o, d.name)]) : []
function aufbau(t, n = 3) {
  const a = archiv(temp(t, 'archiv'))
  const inhalte = []
  for (let i = 1; i <= n; i++) {
    const b = Buffer.from(`%PDF synthetischer Beleg Nr. ${i} Kunde Testperson ${i} Betrag ${i * 10},00 EUR`)
    inhalte.push(b)
    a.ablegen(b, { art: 'umsatzbeleg', jahr: 2026, name: `Umsatzbeleg Bestellung 90${i}.pdf`, meta: { bestellung: `90${i}` } })
  }
  return { a, inhalte, stick: temp(t, 'stick'), k: schluessel.erzeugen() }
}
const opt = (x) => ({ kdf: KDF, freiBytes: 10 ** 9, ...x })

test('Erste Sicherung: Kopf, je Beleg ein verschlüsselter Block, Stand, Protokoll – nichts im Klartext auf dem Stick (Schritt 1.9)', async (t) => {
  const { a, inhalte, stick, k } = aufbau(t)
  const erg = await usb.sichern(opt({ archiv: a, wurzel: stick, wiederherstellungsschluessel: k }))
  assert.equal(erg.ok, true, JSON.stringify(erg))
  assert.deepEqual([erg.neu, erg.schonDa, erg.archivEintraege, erg.kontrolle.geprueft, erg.kennung], [3, 0, 3, 3, schluessel.kennung(k)])
  const ordner = path.join(stick, 'Vendo-Sicherung')
  const kopf = JSON.parse(fs.readFileSync(path.join(ordner, 'sicherung.json'), 'utf8'))
  assert.deepEqual([kopf.format, kopf.kennung, kopf.kdf], ['vendo-usb-sicherung', schluessel.kennung(k), KDF])
  assert.equal(fs.readdirSync(path.join(ordner, 'daten')).length, 3)
  assert.equal(fs.readdirSync(path.join(ordner, 'staende')).length, 1)
  assert.match(fs.readFileSync(path.join(ordner, 'protokoll.txt'), 'utf8'), /\tOK\tStand .*\tneu 3\tschon da 0\tgeprüft 3/)

  // Kein Klartext: weder Belegtext, Dateinamen, Bestellnummern, Datei-Hashes noch der Schlüssel stehen irgendwo auf dem Stick
  const verraeterisch = [...inhalte.map((b) => b.toString().slice(0, 30)), 'Umsatzbeleg', 'Testperson', 'Bestellung 901', '"bestellung"', ...a.eintraege().map((e) => e.sha256), ...a.eintraege().map((e) => e.sha256.slice(0, 12)), k, k.replace(/-/g, ''), ...k.split('-')]
  for (const datei of alleDateien(stick)) {
    const roh = fs.readFileSync(datei)
    for (const v of verraeterisch) assert.equal(roh.includes(Buffer.from(v)), false, `${path.basename(datei)} enthält „${v.slice(0, 20)}“`)
  }
  const hashes = new Set(a.eintraege().map((e) => e.sha256))
  for (const name of fs.readdirSync(path.join(ordner, 'daten'))) {
    assert.match(name, /^[0-9a-f]{64}\.vsb$/)
    assert.equal(hashes.has(name.slice(0, 64)), false, 'Blockname verrät den Datei-Hash nicht')
  }
})

test('Inkrementell: ohne Änderung keine neuen Blöcke, neuer Beleg = genau ein Block; alle Stände bleiben; Inhalt vollständig wiederherstellbar (Schritt 1.9)', async (t) => {
  const { a, stick, k } = aufbau(t)
  let zeit = Date.parse('2026-10-29T10:00:00Z')
  const jetzt = () => new Date(zeit += 60_000)
  await usb.sichern(opt({ archiv: a, wurzel: stick, wiederherstellungsschluessel: k, jetzt }))
  const zweit = await usb.sichern(opt({ archiv: a, wurzel: stick, wiederherstellungsschluessel: k, jetzt }))
  assert.deepEqual([zweit.ok, zweit.neu, zweit.schonDa], [true, 0, 3])
  const neu = Buffer.from('%PDF neuer synthetischer Eingangsbeleg')
  a.ablegen(neu, { art: 'eingang', jahr: 2026, name: 'neu.pdf' })
  const dritt = await usb.sichern(opt({ archiv: a, wurzel: stick, wiederherstellungsschluessel: k, jetzt }))
  assert.deepEqual([dritt.ok, dritt.neu, dritt.schonDa, dritt.kontrolle.geprueft], [true, 1, 3, 4])
  const ordner = path.join(stick, 'Vendo-Sicherung')
  assert.equal(fs.readdirSync(path.join(ordner, 'daten')).length, 4)
  assert.equal(fs.readdirSync(path.join(ordner, 'staende')).length, 3, 'jeder Lauf ein eigener Stand, nichts gelöscht')
  assert.equal(fs.readFileSync(path.join(ordner, 'protokoll.txt'), 'utf8').trim().split('\n').length, 3)

  // Ältere Stände bleiben prüfbar
  const erster = fs.readdirSync(path.join(ordner, 'staende')).sort()[0]
  const alt = await usb.pruefen({ wurzel: stick, wiederherstellungsschluessel: k, stand: erster })
  assert.deepEqual([alt.ok, alt.geprueft, alt.archivEintraege], [true, 3, 3])

  // Wiederherstellbarkeit: mit Schlüssel + Stick jede Archivdatei byte-genau zurückgewinnen
  const s = await usb.oeffnen(stick, k)
  for (const e of a.eintraege()) {
    const name = `${s.blockName(e.sha256)}.vsb`
    const klar = usb.entschluesseln(s.kDaten, fs.readFileSync(path.join(ordner, 'daten', name)), name)
    assert.deepEqual(klar, fs.readFileSync(a.pfad(e)))
  }
})

test('Prüfung auf dem Stick erkennt veränderte und fehlende Blöcke sowie einen veränderten Stand (Schritt 1.9)', async (t) => {
  const { a, stick, k } = aufbau(t)
  await usb.sichern(opt({ archiv: a, wurzel: stick, wiederherstellungsschluessel: k }))
  const daten = path.join(stick, 'Vendo-Sicherung', 'daten')
  const [b1, b2] = fs.readdirSync(daten)
  const roh = fs.readFileSync(path.join(daten, b1))
  roh[roh.length - 3] ^= 0x01 // ein Bit gekippt (z. B. alternder Stick)
  fs.writeFileSync(path.join(daten, b1), roh)
  fs.rmSync(path.join(daten, b2))
  const p = await usb.pruefen({ wurzel: stick, wiederherstellungsschluessel: k })
  assert.equal(p.ok, false)
  assert.equal(p.geprueft, 1)
  assert.equal(p.fehler.length, 2)
  assert.ok(p.fehler.some((f) => /fehlt auf dem Stick/.test(f)))
  assert.ok(p.fehler.some((f) => /Unsupported state or unable to authenticate data/.test(f)))

  // Vertauschen zweier Blöcke (gleicher Schlüssel, anderer Name) wird durch die Namensbindung erkannt
  const { a: a2, stick: s2, k: k2 } = aufbau(t)
  await usb.sichern(opt({ archiv: a2, wurzel: s2, wiederherstellungsschluessel: k2 }))
  const d2 = path.join(s2, 'Vendo-Sicherung', 'daten')
  const [x, y] = fs.readdirSync(d2)
  const bx = fs.readFileSync(path.join(d2, x))
  fs.writeFileSync(path.join(d2, x), fs.readFileSync(path.join(d2, y)))
  fs.writeFileSync(path.join(d2, y), bx)
  assert.equal((await usb.pruefen({ wurzel: s2, wiederherstellungsschluessel: k2 })).fehler.length, 2)

  const st = path.join(s2, 'Vendo-Sicherung', 'staende')
  const name = fs.readdirSync(st)[0]
  const sr = fs.readFileSync(path.join(st, name))
  sr[40] ^= 0xff
  fs.writeFileSync(path.join(st, name), sr)
  const p3 = await usb.pruefen({ wurzel: s2, wiederherstellungsschluessel: k2 })
  assert.match(p3.fehler[0], /nicht lesbar/)
})

test('Falscher Schlüssel, fremde Sicherung, beschädigtes Archiv, zu wenig Platz: abgelehnt, ohne etwas zu schreiben (Schritt 1.9)', async (t) => {
  const { a, stick, k } = aufbau(t)
  await usb.sichern(opt({ archiv: a, wurzel: stick, wiederherstellungsschluessel: k }))
  const vorher = alleDateien(stick).map((d) => `${d}|${sha(fs.readFileSync(d))}`).sort()
  await assert.rejects(usb.sichern(opt({ archiv: a, wurzel: stick, wiederherstellungsschluessel: schluessel.erzeugen() })), /anderen Wiederherstellungsschlüssel/)
  // Kopf manipuliert: Kennung passt, Probe nicht (z. B. falscher Schlüssel mit gefälschter Kennung)
  const kopfDatei = path.join(stick, 'Vendo-Sicherung', 'sicherung.json')
  const kopf = JSON.parse(fs.readFileSync(kopfDatei, 'utf8'))
  const anderer = schluessel.erzeugen()
  fs.writeFileSync(kopfDatei, JSON.stringify({ ...kopf, kennung: schluessel.kennung(anderer) }))
  await assert.rejects(usb.sichern(opt({ archiv: a, wurzel: stick, wiederherstellungsschluessel: anderer })), /passt nicht zu dieser Sicherung/)
  fs.writeFileSync(kopfDatei, JSON.stringify(kopf, null, 2))
  assert.deepEqual(alleDateien(stick).map((d) => `${d}|${sha(fs.readFileSync(d))}`).sort(), vorher)

  const leer = temp(t, 'leer')
  await assert.rejects(usb.sichern(opt({ archiv: a, wurzel: leer, wiederherstellungsschluessel: k, freiBytes: 100 })), /nicht genug Platz/)
  assert.deepEqual(fs.readdirSync(leer), [], 'bei zu wenig Platz wird nicht einmal der Ordner angelegt')

  const datei = a.pfad(a.eintraege()[0])
  fs.chmodSync(datei, 0o666)
  fs.appendFileSync(datei, 'x')
  await assert.rejects(usb.sichern(opt({ archiv: a, wurzel: leer, wiederherstellungsschluessel: k })), /Integritätsprüfung .* 1 Fehler/)
  assert.deepEqual(fs.readdirSync(leer), [])
  await assert.rejects(usb.pruefen({ wurzel: leer, wiederherstellungsschluessel: k }), /keine Vendo-Sicherung/)
})

test('Probelauf (Plan) schreibt nichts und nennt Umfang, Platz und Bereitschaft; Schreibfehler bricht sauber ab (Schritt 1.9)', async (t) => {
  const { a, stick, k } = aufbau(t, 4)
  const plan = await usb.planen({ archiv: a, wurzel: stick, freiBytes: 10 ** 9 })
  assert.deepEqual([plan.archivOk, plan.eintraege, plan.schonGesichert, plan.neu, plan.passt], [true, 4, false, 4, true])
  assert.ok(plan.bytes > a.eintraege().reduce((n, e) => n + e.bytes, 0))
  assert.deepEqual(fs.readdirSync(stick), [], 'Plan schreibt nichts')
  assert.equal((await usb.planen({ archiv: a, wurzel: stick, freiBytes: 10 })).passt, false)

  await usb.sichern(opt({ archiv: a, wurzel: stick, wiederherstellungsschluessel: k }))
  a.ablegen(Buffer.from('%PDF noch einer'), { art: 'eingang', jahr: 2026, name: 'x.pdf' })
  const p2 = await usb.planen({ archiv: a, wurzel: stick, wiederherstellungsschluessel: k, freiBytes: 10 ** 9 })
  assert.deepEqual([p2.schonGesichert, p2.neu], [true, 1])

  // Schreibfehler simulieren (Stick voll/defekt): Lauf bricht ab, kein neuer Stand, Protokoll nennt den Fehler
  const schreiben = fs.writeFileSync
  fs.writeFileSync = (d, ...r) => { if (String(d).endsWith('.vsb.tmp') && String(d).includes(`${path.sep}daten${path.sep}`)) { const f = new Error('EIO: i/o error, write'); f.code = 'EIO'; throw f } return schreiben(d, ...r) }
  let erg
  try { erg = await usb.sichern(opt({ archiv: a, wurzel: stick, wiederherstellungsschluessel: k })) } finally { fs.writeFileSync = schreiben }
  assert.equal(erg.ok, false)
  assert.equal(erg.stand, null)
  assert.match(erg.fehler[0], /EIO/)
  const ordner = path.join(stick, 'Vendo-Sicherung')
  assert.equal(fs.readdirSync(path.join(ordner, 'staende')).length, 1, 'kein halber Stand')
  assert.match(fs.readFileSync(path.join(ordner, 'protokoll.txt'), 'utf8').trim().split('\n').at(-1), /\tFEHLER\t.*EIO/)
  const danach = await usb.sichern(opt({ archiv: a, wurzel: stick, wiederherstellungsschluessel: k }))
  assert.deepEqual([danach.ok, danach.neu], [true, 1], 'nächster Lauf holt es nach')
})

test('Echte scrypt-Parameter und Laufwerkssuche (nur lesend) funktionieren (Schritt 1.9)', async (t) => {
  const { a, stick, k } = aufbau(t, 1)
  const erg = await usb.sichern({ archiv: a, wurzel: stick, wiederherstellungsschluessel: k, freiBytes: 10 ** 9 })
  assert.equal(erg.ok, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stick, 'Vendo-Sicherung', 'sicherung.json'), 'utf8')).kdf, { N: 2 ** 17, r: 8, p: 1 })
  const liste = usb.laufwerke()
  assert.ok(Array.isArray(liste))
  for (const l of liste) assert.match(l.laufwerk, /^[A-Z]:$/)
})

test('Blöcke sind an ihren Namen gebunden; ein korrekt verschlüsselter Block mit falschem Inhalt fällt bei der Prüfung auf (Schritt 1.9)', async (t) => {
  const { a, stick, k } = aufbau(t)
  await usb.sichern(opt({ archiv: a, wurzel: stick, wiederherstellungsschluessel: k }))
  const s = await usb.oeffnen(stick, k)
  const daten = path.join(stick, 'Vendo-Sicherung', 'daten')
  const [e1, e2] = a.eintraege()
  const n1 = `${s.blockName(e1.sha256)}.vsb`
  const n2 = `${s.blockName(e2.sha256)}.vsb`
  const b1 = fs.readFileSync(path.join(daten, n1))
  assert.deepEqual(usb.entschluesseln(s.kDaten, b1, n1), fs.readFileSync(a.pfad(e1)))
  assert.throws(() => usb.entschluesseln(s.kDaten, b1, n2), /unable to authenticate/, 'unter anderem Namen nicht entschlüsselbar')

  // Fehler beim eigenen Schreiben simuliert: unter Name 1 liegt ein gültig verschlüsselter Block mit dem Inhalt von Datei 2
  const falsch = fs.readFileSync(a.pfad(e2))
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', s.kDaten, iv)
  c.setAAD(Buffer.from(n1))
  const verschl = Buffer.concat([c.update(falsch), c.final()])
  fs.writeFileSync(path.join(daten, n1), Buffer.concat([Buffer.from('VSB1'), iv, c.getAuthTag(), verschl]))
  const p = await usb.pruefen({ wurzel: stick, wiederherstellungsschluessel: k })
  assert.equal(p.ok, false)
  assert.deepEqual(p.fehler, [`${e1.datei}: Inhalt stimmt nicht`])
})

test('Wiederherstellen: Stick in leeren Ordner entschlüsseln, Archiv dort vollständig und integer (Schritt 1.10)', async (t) => {
  const { a, stick, k } = aufbau(t, 4)
  await usb.sichern(opt({ archiv: a, wurzel: stick, wiederherstellungsschluessel: k }))
  const ziel = path.join(temp(t, 'ziel'), 'archiv')
  const w = await usb.wiederherstellen({ wurzel: stick, wiederherstellungsschluessel: k, ziel })
  assert.equal(w.ok, true, JSON.stringify(w))
  assert.deepEqual([w.dateien, w.integritaet.ok, w.integritaet.geprueft, w.letzterHash], [4, true, 4, a.integritaet().letzterHash])
  assert.deepEqual(fs.readFileSync(path.join(ziel, 'index.jsonl')), fs.readFileSync(a.INDEX), 'Index byte-gleich')
  for (const e of a.eintraege()) assert.deepEqual(fs.readFileSync(archiv(ziel).pfad(e)), fs.readFileSync(a.pfad(e)))
  await assert.rejects(usb.wiederherstellen({ wurzel: stick, wiederherstellungsschluessel: k, ziel }), /muss leer sein/)

  // älterer Stand bleibt einzeln wiederherstellbar
  a.ablegen(Buffer.from('%PDF später'), { art: 'eingang', jahr: 2026, name: 'spaet.pdf' })
  await usb.sichern(opt({ archiv: a, wurzel: stick, wiederherstellungsschluessel: k, jetzt: () => new Date(Date.now() + 5000) }))
  const staende = fs.readdirSync(path.join(stick, 'Vendo-Sicherung', 'staende')).sort()
  const alt = await usb.wiederherstellen({ wurzel: stick, wiederherstellungsschluessel: k, ziel: path.join(temp(t, 'ziel2'), 'a'), stand: staende[0] })
  const neu = await usb.wiederherstellen({ wurzel: stick, wiederherstellungsschluessel: k, ziel: path.join(temp(t, 'ziel3'), 'a') })
  assert.deepEqual([alt.ok, alt.dateien, neu.ok, neu.dateien], [true, 4, true, 5])

  // beschädigter Block: Wiederherstellung meldet es, Integrität des Ergebnisses fällt durch
  const daten = path.join(stick, 'Vendo-Sicherung', 'daten')
  const b = fs.readdirSync(daten)[0]
  const roh = fs.readFileSync(path.join(daten, b))
  roh[roh.length - 1] ^= 1
  fs.writeFileSync(path.join(daten, b), roh)
  const kaputt = await usb.wiederherstellen({ wurzel: stick, wiederherstellungsschluessel: k, ziel: path.join(temp(t, 'ziel4'), 'a') })
  assert.deepEqual([kaputt.ok, kaputt.fehler.length, kaputt.integritaet.ok], [false, 1, false])
})

test('Wiederherstellungstest: Temp-Ordner wird gelöscht, Ergebnis steht im Stick-Protokoll – auch bei Fehlschlag (Schritt 1.10)', async (t) => {
  const { a, stick, k } = aufbau(t)
  await usb.sichern(opt({ archiv: a, wurzel: stick, wiederherstellungsschluessel: k }))
  const basis = temp(t, 'testbasis')
  const r = await usb.wiederherstellungTesten({ wurzel: stick, wiederherstellungsschluessel: k, tempBasis: basis })
  assert.deepEqual([r.ok, r.dateien, r.tempGeloescht], [true, 3, true], JSON.stringify(r))
  assert.deepEqual(fs.readdirSync(basis), [], 'keine entschlüsselte Kopie bleibt zurück')
  const protokoll = () => fs.readFileSync(path.join(stick, 'Vendo-Sicherung', 'protokoll.txt'), 'utf8').trim().split('\n').at(-1)
  assert.match(protokoll(), /\tWIEDERHERSTELLUNGSTEST OK\tStand .*\tDateien 3/)
  const falsch = await usb.wiederherstellungTesten({ wurzel: stick, wiederherstellungsschluessel: schluessel.erzeugen(), tempBasis: basis })
  assert.deepEqual([falsch.ok, falsch.tempGeloescht], [false, true])
  assert.match(falsch.fehler[0], /anderen Wiederherstellungsschlüssel/)
  assert.match(protokoll(), /WIEDERHERSTELLUNGSTEST FEHLER/)
  assert.deepEqual(fs.readdirSync(basis), [])
})

test('Wiederherstellen erkennt einen gültig verschlüsselten Block mit falschem Inhalt und legt ihn nicht ab (Schritt 1.10)', async (t) => {
  const { a, stick, k } = aufbau(t)
  await usb.sichern(opt({ archiv: a, wurzel: stick, wiederherstellungsschluessel: k }))
  const s = await usb.oeffnen(stick, k)
  const [e1, e2] = a.eintraege()
  const n1 = `${s.blockName(e1.sha256)}.vsb`
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', s.kDaten, iv)
  c.setAAD(Buffer.from(n1))
  const verschl = Buffer.concat([c.update(fs.readFileSync(a.pfad(e2))), c.final()])
  fs.writeFileSync(path.join(stick, 'Vendo-Sicherung', 'daten', n1), Buffer.concat([Buffer.from('VSB1'), iv, c.getAuthTag(), verschl]))
  const ziel = path.join(temp(t, 'ziel'), 'a')
  const w = await usb.wiederherstellen({ wurzel: stick, wiederherstellungsschluessel: k, ziel })
  assert.equal(w.ok, false)
  assert.deepEqual(w.fehler, [`${e1.datei}: Inhalt stimmt nicht`])
  assert.equal(fs.existsSync(archiv(ziel).pfad(e1)), false, 'falscher Inhalt wird nicht als Beleg abgelegt')
})

// ---------- P-2 (Plan 11.5): persönliche Angaben verschlüsselt im Sicherungsstand ----------
const PERSON = { anrede: 'Divers', steuerId: '86095742719', vorname: 'Testvorname', nachname: 'Erfundenperson', geburtsdatum: '1990-01-31', religion: 'altkatholisch', beruf: '', veranlagung: 'einzeln', verheiratetSeit: '', ehegatteVorname: '', ehegatteNachname: '', ehegatteSteuerId: '', ehegatteGeburtsdatum: '', ehegatteReligion: '' }

test('P-2: persönliche Angaben kommen verschlüsselt in den Stand (Version 2), nichts davon im Klartext auf dem Stick', async (t) => {
  const { a, stick, k } = aufbau(t)
  const erg = await usb.sichern(opt({ archiv: a, wurzel: stick, wiederherstellungsschluessel: k, persoenlich: PERSON }))
  assert.deepEqual([erg.ok, erg.persoenlich], [true, true], JSON.stringify(erg))
  assert.deepEqual(erg.kontrolle.persoenlich, { enthalten: true, felder: 7 })
  for (const datei of alleDateien(stick)) {
    const roh = fs.readFileSync(datei)
    for (const v of ['86095742719', 'Testvorname', 'Erfundenperson', '1990-01-31', 'altkatholisch', 'steuerId', 'persoenlich']) assert.equal(roh.includes(Buffer.from(v)), false, `${path.basename(datei)} enthält „${v}“`)
  }
  const ordner = path.join(stick, 'Vendo-Sicherung')
  const name = fs.readdirSync(path.join(ordner, 'staende'))[0]
  const s = await usb.oeffnen(stick, k)
  const inhalt = JSON.parse(usb.entschluesseln(s.kDaten, fs.readFileSync(path.join(ordner, 'staende', name)), `stand:${name}`).toString('utf8'))
  assert.deepEqual([inhalt.version, inhalt.persoenlich], [usb.STAND_VERSION, PERSON])
  await assert.rejects(usb.sichern(opt({ archiv: a, wurzel: stick, wiederherstellungsschluessel: k, persoenlich: { steuerId: 123 } })), /unerwartetes Format/)
})

test('P-2: Wiederherstellung meldet die Angaben (nur Anzahl), Rückholung liefert sie vom neuesten Stand; alte Stände ohne Angaben bleiben lesbar', async (t) => {
  const { a, stick, k } = aufbau(t)
  let uhr = Date.parse('2026-11-01T10:00:00Z')
  const jetzt = () => new Date(uhr += 60_000)
  await usb.sichern(opt({ archiv: a, wurzel: stick, wiederherstellungsschluessel: k, jetzt })) // Stand ohne Angaben (wie vor P-2)
  assert.equal(await usb.persoenlichLesen({ wurzel: stick, wiederherstellungsschluessel: k }), null)
  await usb.sichern(opt({ archiv: a, wurzel: stick, wiederherstellungsschluessel: k, jetzt, persoenlich: PERSON }))
  await usb.sichern(opt({ archiv: a, wurzel: stick, wiederherstellungsschluessel: k, jetzt, persoenlich: { ...PERSON, beruf: 'Testberuf' } }))
  const staende = fs.readdirSync(path.join(stick, 'Vendo-Sicherung', 'staende')).sort()
  const w = await usb.wiederherstellen({ wurzel: stick, wiederherstellungsschluessel: k, ziel: path.join(temp(t, 'ziel'), 'a') })
  assert.deepEqual([w.ok, w.persoenlich], [true, { enthalten: true, felder: 8 }])
  assert.equal(JSON.stringify(w).includes('Testvorname'), false, 'Ergebnis enthält keine Werte')
  const alt = await usb.wiederherstellen({ wurzel: stick, wiederherstellungsschluessel: k, ziel: path.join(temp(t, 'ziel2'), 'a'), stand: staende[0] })
  assert.deepEqual([alt.ok, alt.persoenlich], [true, { enthalten: false }])
  const neu = await usb.persoenlichLesen({ wurzel: stick, wiederherstellungsschluessel: k })
  assert.deepEqual([neu.stand, neu.werte.beruf, neu.werte.steuerId], [staende[2], 'Testberuf', PERSON.steuerId])
  const r = await usb.wiederherstellungTesten({ wurzel: stick, wiederherstellungsschluessel: k, tempBasis: temp(t, 'basis') })
  assert.deepEqual([r.ok, r.persoenlich], [true, { enthalten: true, felder: 8 }])
  await assert.rejects(usb.persoenlichLesen({ wurzel: stick, wiederherstellungsschluessel: schluessel.erzeugen() }), /anderen Wiederherstellungsschlüssel/)
})
