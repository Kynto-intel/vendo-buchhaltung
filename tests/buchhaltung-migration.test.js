import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// Tests für den Migrations-Trockenlauf (plugins/buchhaltung/migration.js), Plan-Schritt 1.3.
// Nur synthetische Bestellungen/Belege in frischen Temp-Ordnern, Aufbau wie bestellungen.js / shirtigo-bestellungen.js.

const require = createRequire(import.meta.url)
const { trockenlauf, berichtText } = require('../migration.js')
const { archiv } = require('../archiv.js')
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex')
const NULLHASH = '0'.repeat(64)

function alle(o) {
  return fs.existsSync(o) ? fs.readdirSync(o, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? alle(path.join(o, d.name)) : [path.join(o, d.name)]) : []
}
function ordner(t) {
  const basis = fs.mkdtempSync(path.join(os.tmpdir(), 'vendo-migration-test-'))
  t.after(() => {
    for (const d of alle(basis)) fs.chmodSync(d, 0o666)
    fs.rmSync(basis, { recursive: true, force: true })
  })
  return { wurzel: path.join(basis, 'Rechnungen'), ziel: path.join(basis, 'Vendo-Archiv') }
}
function schreiben(datei, inhalt) {
  fs.mkdirSync(path.dirname(datei), { recursive: true })
  fs.writeFileSync(datei, inhalt)
  return inhalt
}
// Index als Hash-Kette, genau wie indexAnhaengen() in bestellungen.js
function index(datei, eintraege) {
  let vorher = NULLHASH
  const zeilen = eintraege.map((x) => { const e = { ...x, vorher }; e.hash = sha(JSON.stringify(e)); vorher = e.hash; return JSON.stringify(e) })
  schreiben(datei, zeilen.join('\n') + '\n')
}

// Synthetisches Altarchiv: Shopify 9001 (v1, PDF neu erzeugt), 9002 (v1 + v2, Bestellung in der Silvesternacht),
// Shirtigo T-1 (Datensatz + ersetzte PDF), sync.json, eine fremde Datei im Archiv, eine fremde Datei im Monatsordner.
function altarchiv(wurzel) {
  const alt = path.join(wurzel, '_Vendo-Archiv')
  const json = (nr, v, createdAt) => schreiben(path.join(alt, nr, `v${v}.json`), JSON.stringify({ meta: { quelle: 'Test' }, bestellung: { name: `#${nr}`, createdAt, updatedAt: `Fassung ${v}`, test: 'synthetisch' } }))
  const pdf = (rel, text) => schreiben(path.join(wurzel, rel), `%PDF-1.4 synthetisch ${text}`)
  const p9001 = path.join('2024', '05 - Mai', 'Shopify Rechnungen', 'Umsatzbeleg Bestellung 9001.pdf')
  const p9002 = path.join('2025', '01 - Januar', 'Shopify Rechnungen', 'Umsatzbeleg Bestellung 9002.pdf')
  const p9002v2 = path.join('2025', '01 - Januar', 'Shopify Rechnungen', 'Umsatzbeleg Bestellung 9002 (Version 2).pdf')
  const j1 = json('9001', 1, '2024-05-10T08:00:00Z')
  const j2 = json('9002', 1, '2024-12-31T23:30:00Z') // in Berlin schon 2025
  const j3 = json('9002', 2, '2024-12-31T23:30:00Z')
  const altesPdf = 'erste Fassung 9001' // wurde neu erzeugt, Datei liegt nicht mehr vor
  const b1 = pdf(p9001, 'neu erzeugt 9001')
  const b2 = pdf(p9002, '9002 v1')
  const b3 = pdf(p9002v2, '9002 v2')
  index(path.join(alt, 'index.jsonl'), [
    { nr: '9001', version: 1, createdAt: '2024-05-10T08:00:00Z', json: { datei: '9001/v1.json', sha256: sha(j1) }, pdf: { datei: p9001, sha256: sha(`%PDF-1.4 synthetisch ${altesPdf}`), bytes: 10 } },
    { nr: '9002', version: 1, createdAt: '2024-12-31T23:30:00Z', json: { datei: '9002/v1.json', sha256: sha(j2) }, pdf: { datei: p9002, sha256: sha(b2), bytes: b2.length } },
    { nr: '9002', version: 2, createdAt: '2024-12-31T23:30:00Z', json: { datei: '9002/v2.json', sha256: sha(j3) }, pdf: { datei: p9002v2, sha256: sha(b3), bytes: b3.length } },
    { nr: '9001', version: 1, createdAt: '2024-05-10T08:00:00Z', erneuertAm: '2026-01-01T00:00:00Z', json: { datei: '9001/v1.json', sha256: sha(j1) }, pdf: { datei: p9001, sha256: sha(b1), bytes: b1.length } }
  ])
  schreiben(path.join(alt, 'sync.json'), '{"seit":"2026-01-01T00:00:00Z"}')
  schreiben(path.join(alt, 'notiz-fremd.txt'), 'nicht im Index')

  const sj = schreiben(path.join(alt, 'shirtigo', 'T-1', 'v1.json'), JSON.stringify({ meta: {}, bestellung: { reference: 'T-1', created_at: '2024-06-02 09:00:00' } }))
  const sp = path.join('2024', '06 - Juni', 'Shirtigo Rechnungen', 'Shirtigo Rechnung R-77.pdf')
  const sb = pdf(sp, 'Shirtigo R-77 zweite Fassung')
  index(path.join(alt, 'shirtigo', 'index.jsonl'), [
    { ref: 'T-1', version: 1, updatedAt: '2024-06-02T09:00:00Z', abgerufen: '2026-01-01T00:00:00Z', json: { datei: 'T-1/v1.json', sha256: sha(sj) } },
    { ref: 'T-1', art: 'pdf', rechnungsnummer: 'R-77', abgerufen: '2026-01-01T00:00:00Z', pdf: { datei: sp, sha256: sha('weg'), bytes: 3 } },
    { ref: 'T-1', art: 'pdf', rechnungsnummer: 'R-77', abgerufen: '2026-01-02T00:00:00Z', pdf: { datei: sp, sha256: sha(sb), bytes: sb.length } }
  ])
  schreiben(path.join(wurzel, '2024', '06 - Juni', 'Sonstiges', 'eigene Quittung.pdf'), '%PDF fremd')
  return { alt, p9001, p9002v2, sp }
}

// Alles, was sich durch einen Lauf ändern könnte: Pfade, Inhalt, Größe, Änderungszeit, Rechte
const abbild = (o) => alle(o).map((d) => { const s = fs.statSync(d); return `${d}|${sha(fs.readFileSync(d))}|${s.size}|${s.mtimeMs}|${s.mode}` }).sort()

test('Trockenlauf plant Ziele je Jahr/Art mit Hash, nur aktuelle Fassungen, alte Indizes eingeschlossen', (t) => {
  const { wurzel, ziel } = ordner(t)
  altarchiv(wurzel)
  const p = trockenlauf({ wurzel, ziel, jahr: 2026 })

  assert.deepEqual([p.trockenlauf, p.geschrieben, p.bereit], [true, false, true], p.probleme.join('; '))
  assert.deepEqual([p.ketten.shopify.ok, p.ketten.shopify.geprueft, p.ketten.shirtigo.ok, p.ketten.shirtigo.geprueft], [true, 4, true, 3])
  const z = p.zusammenfassung
  assert.deepEqual([z.kopieren, z.doppelt, z.schonImArchiv, z.fehlerhaft], [10, 0, 0, 0]) // 3 JSON + 3 PDF Shopify, 1 + 1 Shirtigo, 2 Indizes
  assert.deepEqual(Object.fromEntries(Object.entries(z.jeJahrArt).map(([k, v]) => [k, v.anzahl])), {
    '2024/shopify-original': 1, '2024/umsatzbeleg': 1, '2025/shopify-original': 2, '2025/umsatzbeleg': 2,
    '2024/shirtigo-original': 1, '2024/eingang': 1, '2026/alt-index': 2
  })
  const nach = (herkunft) => p.dateien.filter((d) => d.herkunft === herkunft)
  assert.match(nach('shopify-pdf').find((d) => d.meta.bestellung === '9001').ziel, /^2024\/umsatzbeleg\/Umsatzbeleg Bestellung 9001__[0-9a-f]{12}\.pdf$/)
  assert.deepEqual(nach('shopify-json').map((d) => d.ziel.replace(/__[0-9a-f]{12}/, '')).sort(), [
    '2024/shopify-original/Shopify Bestellung 9001 v1.json', '2025/shopify-original/Shopify Bestellung 9002 v1.json', '2025/shopify-original/Shopify Bestellung 9002 v2.json'])
  assert.equal(nach('shirtigo-pdf')[0].ziel.replace(/__[0-9a-f]{12}/, ''), '2024/eingang/Shirtigo Rechnung R-77.pdf')
  assert.equal(nach('shirtigo-pdf')[0].meta.rechnungsnummer, 'R-77')
  assert.deepEqual(nach('alt-index').map((d) => d.ziel.replace(/__[0-9a-f]{12}/, '')).sort(), ['2026/alt-index/shirtigo-index.jsonl', '2026/alt-index/shopify-index.jsonl'])
  assert.equal(nach('alt-index').find((d) => d.ziel.includes('shopify')).meta.letzterHash, p.ketten.shopify.letzterHash)
  for (const d of p.dateien) assert.equal(d.ziel.endsWith(d.sha256.slice(0, 12) + path.extname(d.ziel)), true)

  assert.deepEqual(p.ersetzt.sort(), ['Shirtigo T-1 PDF', 'Shopify #9001 v1'])
  assert.deepEqual(p.fremd, ['notiz-fremd.txt'])
  assert.equal(p.hinweise.some((h) => h.includes('sync.json')), true)
  assert.equal(p.hinweise.some((h) => h.includes('1 Datei(en) im alten Archiv')), true)
  assert.deepEqual([p.nichtVerwaltet.anzahl, p.nichtVerwaltet.jeJahr, p.nichtVerwaltet.endungen], [1, { 2024: 1 }, { '.pdf': 1 }])
  assert.deepEqual([p.ziel.vorhanden, p.ziel.eintraege], [false, 0])
})

test('Trockenlauf verändert nichts: Quelle bit-genau gleich, Zielordner wird nicht angelegt, keine Schreibfunktion aufgerufen', (t) => {
  const { wurzel, ziel } = ordner(t)
  altarchiv(wurzel)
  const vorher = abbild(wurzel)
  const schreibend = ['writeFileSync', 'appendFileSync', 'copyFileSync', 'renameSync', 'rmSync', 'unlinkSync', 'mkdirSync', 'chmodSync', 'cpSync', 'rmdirSync', 'utimesSync', 'truncateSync', 'symlinkSync', 'linkSync']
  const original = Object.fromEntries(schreibend.map((n) => [n, fs[n]]))
  const aufrufe = []
  for (const n of schreibend) fs[n] = (...a) => { aufrufe.push(n); throw new Error(`Trockenlauf darf ${n} nicht benutzen`) }
  original.openSync = fs.openSync // readFileSync öffnet intern – nur Öffnen zum Lesen ist erlaubt
  fs.openSync = (datei, flags = 'r', ...rest) => { if (flags !== 'r') { aufrufe.push(`openSync(${flags})`); throw new Error('Trockenlauf darf nicht schreibend öffnen') } return original.openSync(datei, flags, ...rest) }
  let p
  try { p = trockenlauf({ wurzel, ziel }) } finally { Object.assign(fs, original) }
  assert.deepEqual(aufrufe, [])
  assert.equal(p.zusammenfassung.kopieren, 10)
  assert.deepEqual(abbild(wurzel), vorher)
  assert.equal(fs.existsSync(ziel), false)
})

test('Probleme blockieren den Umzug: fehlende/veränderte Dateien, manipulierter Index, Pfad außerhalb', (t) => {
  const { wurzel, ziel } = ordner(t)
  const { alt, p9002v2 } = altarchiv(wurzel)
  fs.rmSync(path.join(wurzel, p9002v2)) // Beleg-PDF verschoben/gelöscht
  fs.writeFileSync(path.join(alt, '9002', 'v1.json'), '{"manipuliert":true}') // Originaldatensatz verändert
  const zeilen = fs.readFileSync(path.join(alt, 'shirtigo', 'index.jsonl'), 'utf8').split('\n')
  const e = JSON.parse(zeilen[0])
  e.json.datei = '../../../ausserhalb.json' // Index zeigt aus dem Archiv heraus (Hash nicht neu berechnet → auch Kette verletzt)
  zeilen[0] = JSON.stringify(e)
  fs.writeFileSync(path.join(alt, 'shirtigo', 'index.jsonl'), zeilen.join('\n'))

  const p = trockenlauf({ wurzel, ziel })
  assert.equal(p.bereit, false)
  assert.equal(p.ketten.shirtigo.ok, false)
  const text = p.probleme.join('\n')
  assert.match(text, /Datei fehlt: 2025\/01 - Januar\/Shopify Rechnungen\/Umsatzbeleg Bestellung 9002 \(Version 2\)\.pdf/)
  assert.match(text, /Datei verändert \(Hash passt nicht zum alten Index\): _Vendo-Archiv\/9002\/v1\.json/)
  assert.match(text, /Shirtigo-Index: Indexeintrag verändert in Zeile 1/)
  assert.match(text, /Pfad liegt außerhalb des erwarteten Ordners/)
  assert.deepEqual(p.dateien.filter((d) => d.status !== 'kopieren').map((d) => d.status).sort(), ['fehlt', 'pfad-ungueltig', 'veraendert'])
  assert.equal(p.zusammenfassung.fehlerhaft, 3)
  assert.match(berichtText(p), /NEIN – erst die Probleme klären/)
})

test('Schon im neuen Archiv, doppelt im Altbestand und belegter Zielpfad werden erkannt', (t) => {
  const { wurzel, ziel } = ordner(t)
  const { alt, p9001 } = altarchiv(wurzel)
  // gleicher Inhalt wie 9001 liegt schon im neuen Archiv (z. B. aus einem früheren Teil-Lauf)
  archiv(ziel).ablegen(fs.readFileSync(path.join(wurzel, p9001)), { art: 'umsatzbeleg', jahr: 2024, name: 'Umsatzbeleg Bestellung 9001.pdf' })
  // 9002 v2 hat byte-gleichen Originaldatensatz wie v1 → nur einmal ablegen
  fs.chmodSync(path.join(alt, '9002', 'v2.json'), 0o666)
  fs.copyFileSync(path.join(alt, '9002', 'v1.json'), path.join(alt, '9002', 'v2.json'))
  const zeilen = fs.readFileSync(path.join(alt, 'index.jsonl'), 'utf8').split('\n').filter(Boolean).map((z) => JSON.parse(z))
  index(path.join(alt, 'index.jsonl'), zeilen.map(({ hash, vorher, ...r }) => r.nr === '9002' && r.version === 2 ? { ...r, json: { ...r.json, sha256: sha(fs.readFileSync(path.join(alt, '9002', 'v1.json'))) } } : r))
  // fremde Datei genau am geplanten Zielpfad der Shirtigo-PDF
  const vorab = trockenlauf({ wurzel, ziel })
  const shirtigoZiel = vorab.dateien.find((d) => d.herkunft === 'shirtigo-pdf').ziel
  schreiben(path.join(ziel, ...shirtigoZiel.split('/')), 'fremd')

  const p = trockenlauf({ wurzel, ziel })
  const s = (fn) => p.dateien.filter(fn).map((d) => d.status)
  assert.deepEqual(s((d) => d.herkunft === 'shopify-pdf' && d.meta.bestellung === '9001'), ['schon-im-archiv'])
  assert.deepEqual(s((d) => d.herkunft === 'shopify-json' && d.meta.bestellung === '9002'), ['kopieren', 'doppelt'])
  assert.deepEqual(s((d) => d.herkunft === 'shirtigo-pdf'), ['ziel-belegt'])
  assert.deepEqual([p.zusammenfassung.schonImArchiv, p.zusammenfassung.doppelt, p.zusammenfassung.fehlerhaft], [1, 1, 1])
  assert.deepEqual([p.ziel.vorhanden, p.ziel.eintraege], [true, 1])
  assert.equal(p.bereit, false)
  assert.match(p.probleme.join('\n'), /Zielpfad im neuen Archiv ist schon belegt/)
})

test('Geplante Ziele stimmen genau mit dem überein, was archiv.ablegen später erzeugt', (t) => {
  const { wurzel, ziel } = ordner(t)
  altarchiv(wurzel)
  const p = trockenlauf({ wurzel, ziel, jahr: 2026 })
  const a = archiv(ziel)
  for (const d of p.dateien.filter((x) => x.status === 'kopieren')) {
    const quelle = path.join(wurzel, ...d.quelle.split('/'))
    const name = path.basename(d.ziel).replace(/__[0-9a-f]{12}(\.[a-z0-9]+)?$/, '$1')
    const e = a.ablegen(quelle, { art: d.art, jahr: d.jahr, name, meta: d.meta })
    assert.equal(e.datei, d.ziel)
    assert.equal(e.sha256, d.sha256)
  }
  assert.equal(a.integritaet().ok, true)
})

test('Ungültige Aufrufe, leeres Altarchiv und lesbarer Bericht', (t) => {
  const { wurzel, ziel } = ordner(t)
  assert.throws(() => trockenlauf({ wurzel: 'relativ', ziel }), /absolute Pfade/)
  assert.throws(() => trockenlauf({ wurzel, ziel: path.join(wurzel, 'Archiv') }), /getrennt vom Arbeitsordner/)
  assert.throws(() => trockenlauf({ wurzel: path.join(ziel, 'x'), ziel }), /getrennt vom Arbeitsordner/)
  assert.throws(() => trockenlauf({ wurzel, ziel, jahr: 1999 }), /Jahr/)

  const leer = trockenlauf({ wurzel, ziel })
  assert.deepEqual([leer.bereit, leer.zusammenfassung.kopieren, leer.dateien.length], [true, 0, 0])
  assert.match(leer.hinweise.join('\n'), /Kein altes Archiv gefunden/)
  assert.equal(fs.existsSync(wurzel), false, 'auch ein fehlender Arbeitsordner wird nicht angelegt')

  altarchiv(wurzel)
  const text = berichtText(trockenlauf({ wurzel, ziel }))
  assert.match(text, /^TROCKENLAUF – es wurde nichts geschrieben/)
  assert.match(text, /Würde kopieren: 10 Dateien/)
  assert.match(text, /2025\/umsatzbeleg: 2/)
  assert.match(text, /Bereit für den echten Umzug: ja/)
  assert.match(text, /- notiz-fremd\.txt/)
})

// ---------- Schritt 1.4: echter Umzug ----------
const { umziehen } = require('../migration.js')

test('Umzug kopiert genau den Plan, prüft jede Kopie, schreibt Protokoll als Kettenschritt, Quelle bleibt unverändert', (t) => {
  const { wurzel, ziel } = ordner(t)
  altarchiv(wurzel)
  const plan = trockenlauf({ wurzel, ziel, jahr: 2026 })
  const vorher = abbild(wurzel)
  const erg = umziehen({ wurzel, ziel, jahr: 2026 })

  assert.deepEqual([erg.ok, erg.kopiert, erg.fehler], [true, 10, []])
  assert.equal(erg.bytes, plan.zusammenfassung.bytes)
  assert.deepEqual(abbild(wurzel), vorher, 'altes Archiv und Monatsordner bit-genau unverändert')
  const a = archiv(ziel)
  const e = a.eintraege()
  assert.equal(e.length, 11, '10 Dateien + Protokoll')
  assert.deepEqual(e.slice(0, 10).map((x) => x.datei), plan.dateien.map((d) => d.ziel))
  for (const [i, d] of plan.dateien.entries()) {
    assert.equal(e[i].sha256, d.sha256)
    assert.deepEqual(fs.readFileSync(a.pfad(e[i])), fs.readFileSync(path.join(wurzel, ...d.quelle.split('/'))))
  }
  const p = e[10]
  assert.equal(p.art, 'protokoll')
  assert.equal(p.datei, erg.protokoll)
  assert.match(p.datei, /^2026\/protokoll\/Migration \d{4}-\d\d-\d\dT\d\d-\d\d-\d\d__[0-9a-f]{12}\.json$/)
  assert.equal(p.vorher, e[9].hash, 'Protokoll ist eigener Schritt der Kette')
  const inhalt = JSON.parse(fs.readFileSync(a.pfad(p), 'utf8'))
  assert.deepEqual([inhalt.vollstaendig, inhalt.geplant, inhalt.kopiert, inhalt.dateien.length], [true, 10, 10, 10])
  assert.equal(inhalt.alteKetten.shopify.letzterHash, plan.ketten.shopify.letzterHash)
  assert.equal(inhalt.integritaetVorProtokoll.letzterHash, e[9].hash)
  assert.equal(JSON.stringify(inhalt).includes(os.tmpdir()), false, 'keine absoluten Pfade im Protokoll')
  assert.deepEqual([erg.integritaet.ok, erg.integritaet.geprueft], [true, 11])

  // zweiter Lauf: nichts mehr zu tun, Archiv unverändert, kein weiteres Protokoll
  const zweit = umziehen({ wurzel, ziel, jahr: 2026 })
  assert.deepEqual([zweit.ok, zweit.kopiert, zweit.protokoll, zweit.uebernommen], [true, 0, null, 10])
  assert.equal(archiv(ziel).eintraege().length, 11)
})

test('Umzug startet nicht, wenn der Trockenlauf Probleme meldet – nichts wird angelegt', (t) => {
  const { wurzel, ziel } = ordner(t)
  const { p9001 } = altarchiv(wurzel)
  fs.rmSync(path.join(wurzel, p9001))
  assert.throws(() => umziehen({ wurzel, ziel }), /nicht gestartet.*1 Problem/)
  assert.equal(fs.existsSync(ziel), false)
})

test('Abbruch mitten im Umzug: Lauf endet, Protokoll hält es fest, neuer Lauf setzt fort und schließt sauber ab', (t) => {
  const { wurzel, ziel } = ordner(t)
  altarchiv(wurzel)
  // Ein Hindernis: Unter dem Zielpfad für 2025 liegt eine Datei statt eines Ordners → Ablegen der 2025er-Belege scheitert
  schreiben(path.join(ziel, '2025'), 'Hindernis')
  const erg = umziehen({ wurzel, ziel, jahr: 2026 })
  assert.equal(erg.ok, false)
  assert.equal(erg.fehler.length, 1)
  assert.match(erg.fehler[0], /^_Vendo-Archiv\/9002\/v1\.json: /)
  assert.equal(erg.kopiert, 2, 'nur 9001 (JSON + PDF, 2024) vor dem Fehler')
  assert.ok(erg.protokoll, 'auch ein unvollständiger Lauf wird protokolliert')
  const prot = JSON.parse(fs.readFileSync(archiv(ziel).pfad({ datei: erg.protokoll }), 'utf8'))
  assert.deepEqual([prot.vollstaendig, prot.kopiert, prot.geplant], [false, 2, 10])

  fs.rmSync(path.join(ziel, '2025'))
  const weiter = umziehen({ wurzel, ziel, jahr: 2026 })
  assert.deepEqual([weiter.ok, weiter.kopiert, weiter.uebernommen], [true, 8, 2], weiter.fehler.join('; '))
  const a = archiv(ziel)
  assert.equal(a.integritaet().ok, true)
  assert.equal(a.eintraege().filter((x) => x.art === 'protokoll').length, 2)
  assert.equal(a.eintraege().filter((x) => x.art !== 'protokoll').length, 10)
})

test('Wiederaufnahme: Datei liegt schon am Zielpfad (Abbruch vor dem Indexeintrag) und wird übernommen', (t) => {
  const { wurzel, ziel } = ordner(t)
  altarchiv(wurzel)
  const plan = trockenlauf({ wurzel, ziel })
  const d = plan.dateien[0]
  schreiben(path.join(ziel, ...d.ziel.split('/')), fs.readFileSync(path.join(wurzel, ...d.quelle.split('/'))))
  const neu = trockenlauf({ wurzel, ziel })
  assert.equal(neu.bereit, true, neu.probleme.join('; '))
  assert.deepEqual([neu.dateien[0].status, neu.dateien[0].wiederaufnahme], ['kopieren', true])
  const erg = umziehen({ wurzel, ziel })
  assert.deepEqual([erg.ok, erg.kopiert], [true, 10])
  assert.equal(archiv(ziel).integritaet().ok, true)
})

test('Umzug mit Schutz: alle Archivdateien werden am Ende in Paketen geschützt, Schutzfehler werden gemeldet', (t) => {
  const { wurzel, ziel } = ordner(t)
  altarchiv(wurzel)
  const aufrufe = []
  const erg = umziehen({ wurzel, ziel, schutz: { schuetzen(z) { aufrufe.push(z); return { erfolgreich: true } } } })
  assert.deepEqual([erg.ok, erg.geschuetzt], [true, true])
  const a = archiv(ziel)
  assert.deepEqual(aufrufe.flatMap((z) => z.dateien), a.eintraege().map((x) => a.pfad(x)), 'inklusive Protokoll')

  const { wurzel: w2, ziel: z2 } = ordner(t)
  altarchiv(w2)
  const fehl = umziehen({ wurzel: w2, ziel: z2, schutz: { schuetzen() { return { erfolgreich: false, fehler: ['kein NTFS'] } } } })
  assert.deepEqual([fehl.ok, fehl.kopiert, fehl.geschuetzt, fehl.schutzFehler], [true, 10, false, ['kein NTFS']], 'Kopie ist korrekt, Schutz fehlt – getrennt gemeldet')
})

test('Umzug bemerkt eine fehlerhafte Kopie beim Zurücklesen und bricht ab', (t) => {
  const { wurzel, ziel } = ordner(t)
  altarchiv(wurzel)
  const lesen = fs.readFileSync
  fs.readFileSync = (p, ...rest) => { const b = lesen(p, ...rest); return String(p).startsWith(ziel) && String(p).includes('umsatzbeleg') ? Buffer.from('verfälschte Kopie') : b }
  let erg
  try { erg = umziehen({ wurzel, ziel }) } finally { fs.readFileSync = lesen }
  assert.equal(erg.ok, false)
  assert.equal(erg.kopiert, 1, 'nur das JSON vor dem ersten Umsatzbeleg')
  assert.match(erg.fehler[0], /Umsatzbeleg Bestellung 9001\.pdf: Kopie im Archiv weicht vom Original ab/)
})
