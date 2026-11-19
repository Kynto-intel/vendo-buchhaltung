import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

// Tests für das Versiegeln des Belegarchivs mit RFC-3161-Zeitstempeln (plugins/buchhaltung/zeitstempel.js), Plan-Schritt 1.7.
// Kein Netz: Ein lokaler Test-Zeitstempeldienst wird je Test mit OpenSSL erzeugt (eigene Test-CA). Zusätzlich werden zwei
// echte Antworten von Sectigo und FreeTSA geprüft, die am 29.10.2026 für einen zufälligen Dummy-Hash geholt wurden
// (tests/fixtures/zeitstempel, keine Archiv- oder Kundendaten).

const require = createRequire(import.meta.url)
const zs = require('../zeitstempel.js')
const { archiv } = require('../archiv.js')
const OPENSSL = zs.opensslFinden()
const FIXTURES = path.resolve('tests/fixtures/zeitstempel')
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex')

function ssl(args) {
  const lauf = spawnSync(OPENSSL, args, { encoding: 'utf8', windowsHide: true })
  if (lauf.status !== 0) throw new Error(`openssl ${args[0]}: ${lauf.stderr}`)
  return lauf.stdout
}
function tempOrdner(t, name) {
  const o = fs.mkdtempSync(path.join(os.tmpdir(), `vendo-zs-${name}-`))
  t.after(() => {
    const alle = (x) => fs.existsSync(x) ? fs.readdirSync(x, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? alle(path.join(x, d.name)) : [path.join(x, d.name)]) : []
    for (const d of alle(o)) fs.chmodSync(d, 0o666)
    fs.rmSync(o, { recursive: true, force: true })
  })
  return o
}

// Lokaler Test-Zeitstempeldienst: Root-CA + TSA-Zertifikat (EKU timeStamping, kritisch) + openssl-ts-Konfiguration
// gueltigBis: Ende der TSA-Zertifikatsgültigkeit (Date) – für den Test „nach Ablauf noch prüfbar“
function testTsa(t, name = 'tsa', { gueltigBis = null } = {}) {
  const d = tempOrdner(t, name)
  const p = (x) => path.join(d, x).split(path.sep).join('/')
  ssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', p('ca.key'), '-out', p('ca.pem'), '-days', '3650',
    '-subj', `/CN=Vendo Test-TSA Root ${name}`, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'])
  ssl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', p('tsa.key'), '-out', p('tsa.csr'), '-subj', `/CN=Vendo Test-TSA ${name}`])
  fs.writeFileSync(p('ext.cnf'), 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\n')
  const bis = gueltigBis ? ['-not_after', gueltigBis.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'] : ['-days', '3650']
  ssl(['x509', '-req', '-in', p('tsa.csr'), '-CA', p('ca.pem'), '-CAkey', p('ca.key'), '-CAcreateserial', '-out', p('tsa.pem'), ...bis, '-extfile', p('ext.cnf')])
  fs.writeFileSync(p('tsaserial'), '01\n')
  fs.writeFileSync(p('ts.cnf'), [
    '[ tsa ]', 'default_tsa = tsa_config1', '[ tsa_config1 ]', `serial = ${p('tsaserial')}`, `signer_cert = ${p('tsa.pem')}`, `certs = ${p('tsa.pem')}`,
    `signer_key = ${p('tsa.key')}`, 'signer_digest = sha256', 'default_policy = 1.2.3.4.1', 'digests = sha256, sha384, sha512',
    'accuracy = secs:1', 'ordering = no', 'tsa_name = yes', 'ess_cert_id_chain = no', 'ess_cert_id_alg = sha256', ''
  ].join('\n'))
  const dienst = { id: name, name: `Test-TSA ${name}`, url: `test://${name}`, qualifiziert: false, anker: path.join(d, 'ca.pem'), ankerSha256: new crypto.X509Certificate(fs.readFileSync(p('ca.pem'))).fingerprint256 }
  const antworten = []
  const senden = async (url, anfrage) => {
    const tsq = path.join(d, `q${antworten.length}.tsq`)
    const tsr = path.join(d, `r${antworten.length}.tsr`)
    fs.writeFileSync(tsq, anfrage)
    ssl(['ts', '-reply', '-config', p('ts.cnf'), '-queryfile', tsq, '-out', tsr])
    const b = fs.readFileSync(tsr)
    antworten.push({ url, anfrage, antwort: b })
    return b
  }
  return { dienst, senden, antworten, ordner: d }
}
function archivMitBelegen(t, n = 2) {
  const a = archiv(tempOrdner(t, 'archiv'))
  for (let i = 1; i <= n; i++) a.ablegen(Buffer.from(`%PDF synthetischer Beleg ${i}`), { art: 'umsatzbeleg', jahr: 2026, name: `Beleg ${i}.pdf` })
  return a
}
const arten = (a) => a.eintraege().map((e) => e.art)

test('Versiegeln: Siegel mit Kettenhash, geprüfte Zeitstempel-Antwort und Anker im Archiv; Prüfung bestätigt alles (Schritt 1.7)', async (t) => {
  const a = archivMitBelegen(t)
  const kopf = a.integritaet()
  const tsa = testTsa(t)
  const erg = await zs.versiegeln({ archiv: a, dienste: [tsa.dienst], senden: tsa.senden })
  assert.equal(erg.ok, true, JSON.stringify(erg.dienste))
  assert.deepEqual([erg.archivEintraege, erg.letzterHash], [2, kopf.letzterHash])
  assert.deepEqual(arten(a), ['umsatzbeleg', 'umsatzbeleg', 'siegel', 'zertifikat', 'zeitstempel'])
  const [, , s, z, ts] = a.eintraege()
  assert.equal(erg.siegel, s.datei)
  const siegel = JSON.parse(fs.readFileSync(a.pfad(s), 'utf8'))
  assert.deepEqual([siegel.archivEintraege, siegel.letzterHash], [2, kopf.letzterHash])
  assert.equal(JSON.stringify(siegel).includes('synthetischer Beleg'), false, 'keine Belegdaten im Siegel')
  // Gesendet wurde nur eine RFC-3161-Anfrage mit dem SHA-256 des Siegels
  const anfrage = path.join(tsa.ordner, 'pruef.tsq')
  fs.writeFileSync(anfrage, tsa.antworten[0].anfrage)
  assert.match(ssl(['ts', '-query', '-in', anfrage, '-text']).replace(/\s+/g, ' '), new RegExp(`Hash Algorithm: sha256`))
  assert.ok(tsa.antworten[0].anfrage.includes(Buffer.from(s.sha256, 'hex')), 'Anfrage enthält den Siegel-Hash')
  assert.equal(tsa.antworten[0].anfrage.length < 120, true, 'Anfrage ist winzig – nur Hash, Nonce, Kennungen')
  assert.deepEqual(z.meta, { quelle: 'zeitstempel', dienst: tsa.dienst.id, fingerabdruck: tsa.dienst.ankerSha256 })
  assert.deepEqual([ts.meta.dienst, ts.meta.siegel, ts.meta.qualifiziert], [tsa.dienst.id, s.sha256, false])
  assert.ok(Math.abs(Date.parse(ts.meta.zeit) - Date.now()) < 120_000, 'Stempelzeit plausibel')
  assert.equal(a.integritaet().ok, true)

  const p = zs.pruefen({ archiv: a, dienste: [tsa.dienst] })
  assert.deepEqual([p.ok, p.anzahl, p.ergebnisse[0].gueltig, p.nochNichtVersiegelt, p.zuletzt.archivEintraege], [true, 1, 1, 0, 2], JSON.stringify(p))

  a.ablegen(Buffer.from('%PDF neuer Beleg'), { art: 'eingang', jahr: 2026, name: 'neu.pdf' })
  assert.equal(zs.pruefen({ archiv: a, dienste: [tsa.dienst] }).nochNichtVersiegelt, 1)
  const zweit = await zs.versiegeln({ archiv: a, dienste: [tsa.dienst], senden: tsa.senden })
  assert.equal(zweit.archivEintraege, 6)
  assert.deepEqual(arten(a).slice(6), ['siegel', 'zeitstempel'], 'Anker wird nicht doppelt abgelegt')
  const p2 = zs.pruefen({ archiv: a, dienste: [tsa.dienst] })
  assert.deepEqual([p2.ok, p2.anzahl, p2.nochNichtVersiegelt], [true, 2, 0])
})

test('Zwei Dienste: fällt einer aus, zählt der andere; fallen alle aus, wird nichts abgelegt (Schritt 1.7)', async (t) => {
  const a = archivMitBelegen(t)
  const eins = testTsa(t, 'eins')
  const zwei = testTsa(t, 'zwei')
  const senden = (url, anfrage) => url === eins.dienst.url ? eins.senden(url, anfrage) : Promise.reject(new Error('synthetischer Netzfehler'))
  const erg = await zs.versiegeln({ archiv: a, dienste: [eins.dienst, zwei.dienst], senden })
  assert.equal(erg.ok, true)
  assert.deepEqual(erg.dienste.map((d) => [d.id, d.ok, d.fehler]), [['eins', true, undefined], ['zwei', false, 'synthetischer Netzfehler']])
  assert.deepEqual(a.eintraege().at(-3).meta.dienste, ['eins'])

  const vorher = a.eintraege().length
  const nichts = await zs.versiegeln({ archiv: a, dienste: [eins.dienst, zwei.dienst], senden: () => Promise.reject(new Error('offline')) })
  assert.deepEqual([nichts.ok, nichts.siegel, a.eintraege().length], [false, null, vorher])

  const beide = await zs.versiegeln({ archiv: a, dienste: [eins.dienst, zwei.dienst], senden: (u, q) => (u === eins.dienst.url ? eins : zwei).senden(u, q) })
  assert.deepEqual(beide.dienste.map((d) => d.ok), [true, true])
  const p = zs.pruefen({ archiv: a, dienste: [eins.dienst, zwei.dienst] })
  assert.deepEqual([p.ok, p.ergebnisse.map((e) => e.gueltig)], [true, [1, 2]])
})

test('Falsche Antworten werden nicht angenommen: fremde CA, falscher Anker-Fingerabdruck, wiederverwendete alte Antwort (Schritt 1.7)', async (t) => {
  const a = archivMitBelegen(t)
  const echt = testTsa(t, 'echt')
  const fremd = testTsa(t, 'fremd')
  const vorher = a.eintraege().length

  const andereCa = await zs.versiegeln({ archiv: a, dienste: [echt.dienst], senden: fremd.senden }) // Antwort von fremder CA signiert
  assert.equal(andereCa.ok, false)
  assert.match(andereCa.dienste[0].fehler, /certificate verify error|unable to get local issuer/)

  const falscherPin = await zs.versiegeln({ archiv: a, dienste: [{ ...echt.dienst, ankerSha256: 'AA:' + echt.dienst.ankerSha256.slice(3) }], senden: echt.senden })
  assert.match(falscherPin.dienste[0].fehler, /Vertrauensanker .* stimmt nicht/)
  assert.equal(echt.antworten.length, 0, 'bei falschem Anker wird gar nicht erst gesendet')

  await zs.versiegeln({ archiv: a, dienste: [echt.dienst], senden: echt.senden })
  const alteAntwort = echt.antworten[0].antwort
  a.ablegen(Buffer.from('%PDF weiterer Beleg'), { art: 'eingang', jahr: 2026, name: 'x.pdf' })
  const wiederholt = await zs.versiegeln({ archiv: a, dienste: [echt.dienst], senden: async () => alteAntwort })
  assert.equal(wiederholt.ok, false)
  assert.match(wiederholt.dienste[0].fehler, /imprint mismatch|nonce mismatch/)
  assert.equal(a.eintraege().filter((e) => e.art === 'siegel').length, 1)
  assert.ok(a.eintraege().length > vorher)

  for (const muell of [Buffer.from('<html>Wartung</html>'), crypto.randomBytes(200)]) {
    const r = await zs.versiegeln({ archiv: a, dienste: [echt.dienst], senden: async () => muell })
    assert.equal(r.ok, false, 'unbrauchbare Antwort (z. B. Fehlerseite) wird abgelehnt')
  }
  assert.equal(a.eintraege().filter((e) => e.art === 'siegel').length, 1)
})

test('Beschädigtes oder leeres Archiv wird nicht versiegelt (Schritt 1.7)', async (t) => {
  const tsa = testTsa(t)
  const leer = archiv(tempOrdner(t, 'leer'))
  await assert.rejects(zs.versiegeln({ archiv: leer, dienste: [tsa.dienst], senden: tsa.senden }), /leer/)
  const a = archivMitBelegen(t)
  const datei = a.pfad(a.eintraege()[0])
  fs.chmodSync(datei, 0o666)
  fs.appendFileSync(datei, 'manipuliert')
  await assert.rejects(zs.versiegeln({ archiv: a, dienste: [tsa.dienst], senden: tsa.senden }), /nicht versiegelt: .*1 Fehler/)
  assert.equal(tsa.antworten.length, 0)
})

test('Prüfung erkennt eine komplett neu berechnete Kette, veränderte Siegel und veränderte Zeitstempel (Schritt 1.7)', async (t) => {
  const a = archivMitBelegen(t, 3)
  const tsa = testTsa(t)
  await zs.versiegeln({ archiv: a, dienste: [tsa.dienst], senden: tsa.senden })
  const index = a.INDEX
  const zeilen = fs.readFileSync(index, 'utf8').trim().split('\n').map((z) => JSON.parse(z))

  // Angreifer ändert Eintrag 2 (Betrag/Metadaten) und rechnet die GANZE Kette neu – die Integritätsprüfung sieht nichts mehr
  const neu = []
  let vorher = '0'.repeat(64)
  for (const z of zeilen) {
    const { hash, vorher: _alt, ...rest } = z
    if (rest.nr === 2) rest.meta = { umgeschrieben: true }
    const e = { ...rest, vorher }
    e.hash = sha(JSON.stringify(e))
    vorher = e.hash
    neu.push(e)
  }
  fs.writeFileSync(index, neu.map((z) => JSON.stringify(z)).join('\n') + '\n')
  const a2 = archiv(path.dirname(index))
  assert.equal(a2.integritaet().ok, true, 'ohne externen Anker unentdeckt')
  const p = zs.pruefen({ archiv: a2, dienste: [tsa.dienst] })
  assert.equal(p.ok, false)
  assert.match(p.ergebnisse[0].fehler.join('; '), /Index-Kette bis Eintrag 3 wurde seit dem Siegel verändert/)

  // Siegel-Datei verändert
  fs.writeFileSync(index, zeilen.map((z) => JSON.stringify(z)).join('\n') + '\n')
  const a3 = archiv(path.dirname(index))
  const s = a3.eintraege().find((e) => e.art === 'siegel')
  const ts = a3.eintraege().find((e) => e.art === 'zeitstempel')
  const tsrRoh = fs.readFileSync(a3.pfad(ts))
  fs.chmodSync(a3.pfad(ts), 0o666)
  const kaputt = Buffer.from(tsrRoh)
  kaputt[kaputt.length - 10] ^= 0xff
  fs.writeFileSync(a3.pfad(ts), kaputt)
  const p3 = zs.pruefen({ archiv: a3, dienste: [tsa.dienst] })
  assert.deepEqual([p3.ok, p3.ergebnisse[0].stempel[0].ok], [false, false])

  fs.writeFileSync(a3.pfad(ts), tsrRoh)
  fs.chmodSync(a3.pfad(s), 0o666)
  fs.appendFileSync(a3.pfad(s), ' ')
  const p4 = zs.pruefen({ archiv: a3, dienste: [tsa.dienst] })
  assert.equal(p4.ok, false)
  assert.match(p4.ergebnisse[0].fehler.join('; '), /Siegel-Datei verändert/)
})

test('Echte Antworten von Sectigo (qualifiziert) und FreeTSA sind mit den hinterlegten Ankern gültig; Anker und Dienste wie entschieden (Schritt 1.7)', () => {
  const dummy = fs.readFileSync(path.join(FIXTURES, 'dummy.hex'), 'utf8').trim()
  assert.deepEqual(zs.DIENSTE.map((d) => [d.id, d.url, d.qualifiziert]), [
    ['sectigo', 'http://timestamp.sectigo.com/qualified', true], ['freetsa', 'https://freetsa.org/tsr', false]])
  for (const d of zs.DIENSTE) {
    const anker = path.resolve('vertrauen', d.anker)
    assert.equal(new crypto.X509Certificate(fs.readFileSync(anker)).fingerprint256, d.ankerSha256, `${d.id}: Anker-Fingerabdruck`)
    const tsr = path.join(FIXTURES, `${d.id}.tsr`)
    const zeit = Math.floor(Date.parse(ssl(['ts', '-reply', '-in', tsr, '-text']).match(/^Time stamp: (.+)$/m)[1]) / 1000)
    ssl(['ts', '-verify', '-digest', dummy, '-in', tsr, '-CAfile', anker, '-attime', String(zeit)])
    const text = ssl(['ts', '-reply', '-in', tsr, '-text'])
    assert.match(text, /Status: Granted\./)
    if (d.id === 'sectigo') assert.match(text, /Policy OID: 0\.4\.0\.2023\.1\.1/, 'ETSI-Richtlinie für qualifizierte Zeitstempel')
    // gegen den jeweils anderen Anker ungültig
    const anderer = zs.DIENSTE.find((x) => x.id !== d.id)
    assert.throws(() => ssl(['ts', '-verify', '-digest', dummy, '-in', tsr, '-CAfile', path.resolve('vertrauen', anderer.anker)]))
    assert.throws(() => ssl(['ts', '-verify', '-digest', sha('anderer Inhalt'), '-in', tsr, '-CAfile', anker]))
  }
  // auch nach Ablauf der Zertifikate (2050) zum Stempelzeitpunkt prüfbar – ohne -attime nicht
  const tsr = path.join(FIXTURES, 'sectigo.tsr')
  const anker = path.resolve('vertrauen', zs.DIENSTE[0].anker)
  assert.throws(() => ssl(['ts', '-verify', '-digest', dummy, '-in', tsr, '-CAfile', anker, '-attime', '2524608000']), 'Gegenprobe: Prüfung „heute = 2050“ scheitert')
})

test('Prüfung gilt für den Stempelzeitpunkt: nach Ablauf des TSA-Zertifikats bleibt das Siegel gültig (Schritt 1.7)', async (t) => {
  const a = archivMitBelegen(t)
  const tsa = testTsa(t, 'kurz', { gueltigBis: new Date(Date.now() + 4000) })
  const erg = await zs.versiegeln({ archiv: a, dienste: [tsa.dienst], senden: tsa.senden })
  assert.equal(erg.ok, true, JSON.stringify(erg.dienste))
  await new Promise((r) => setTimeout(r, 6000)) // Zertifikat ist jetzt abgelaufen
  const ts = a.eintraege().find((e) => e.art === 'zeitstempel')
  assert.throws(() => ssl(['ts', '-verify', '-data', a.pfad(a.eintraege().find((e) => e.art === 'siegel')), '-in', a.pfad(ts), '-CAfile', tsa.dienst.anker]), 'Gegenprobe: Prüfung mit heutigem Datum scheitert')
  const p = zs.pruefen({ archiv: a, dienste: [tsa.dienst] })
  assert.equal(p.ok, true, JSON.stringify(p.ergebnisse))
})
