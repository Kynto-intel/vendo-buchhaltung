'use strict'
// Buchhaltung in PostgreSQL (Plan Abschnitt 11.2, Phase D): ein abgeleiteter Index, keine zweite Wahrheit.
//
// Das Belegarchiv (Dateien + Hash-Kette) bleibt maßgeblich. Die Tabellen im Schema „buchhaltung“ werden jederzeit
// vollständig aus dem Archiv und den eingelesenen Belegen neu aufgebaut (aufbauen) und lassen sich gegen einen frischen
// Aufbau prüfen (pruefen). Kundennamen und Anschriften stehen nicht in den Tabellen, nur im Archiv.
// Vorbild für die Trennung „Daten in der Datenbank, Belegdateien mit SHA-256 im Dateisystem“: „haben“ (nur die Idee).

const crypto = require('node:crypto')

const MIGRATIONEN = [{
  version: 1,
  sql: `
    CREATE SCHEMA IF NOT EXISTS buchhaltung;
    CREATE TABLE IF NOT EXISTS buchhaltung.bestellungen (
      nr text PRIMARY KEY, version int NOT NULL, bestelltag date, zahlungstag date, storniert boolean NOT NULL,
      bezahlt boolean NOT NULL, brutto numeric(12,2) NOT NULL, mwst numeric(12,2) NOT NULL, netto numeric(12,2) NOT NULL,
      wirksam numeric(12,2) NOT NULL, satz numeric(5,2), kleinunternehmer boolean NOT NULL, land text, zahlungsart text,
      beleg_datei text, original_sha text, rechnung jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS buchhaltung.zahlungen (
      nr text NOT NULL, lfd int NOT NULL, art text NOT NULL, tag date, betrag numeric(12,2) NOT NULL, zahlungsart text,
      PRIMARY KEY (nr, lfd));
    CREATE TABLE IF NOT EXISTS buchhaltung.einkaeufe (
      ref text PRIMARY KEY, version int, rechnungsnummer text, datum date, brutto numeric(12,2), mwst numeric(12,2),
      netto numeric(12,2), wirksam numeric(12,2), beleg_datei text, beleg_sha text, rechnung jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS buchhaltung.belege (
      id text PRIMARY KEY, lieferant text, rechnungsnummer text, datum date, art text, brutto numeric(12,2),
      mwst numeric(12,2), netto numeric(12,2), wirksam numeric(12,2), ausgeblendet boolean NOT NULL, p13b jsonb,
      beleg_sha text, rechnung jsonb);
    CREATE TABLE IF NOT EXISTS buchhaltung.aufbau (
      id int PRIMARY KEY CHECK (id = 1), zeit timestamptz NOT NULL, quelle text NOT NULL, anzahl jsonb NOT NULL);
    CREATE INDEX IF NOT EXISTS bestellungen_bestelltag ON buchhaltung.bestellungen (bestelltag);
    CREATE INDEX IF NOT EXISTS einkaeufe_datum ON buchhaltung.einkaeufe (datum);`
}]

// Spalten je Tabelle in fester Reihenfolge (Einfügen und Prüfen nutzen dieselbe Liste)
const TABELLEN = {
  bestellungen: { schluessel: 'nr', spalten: ['nr', 'version', 'bestelltag', 'zahlungstag', 'storniert', 'bezahlt', 'brutto', 'mwst', 'netto', 'wirksam', 'satz', 'kleinunternehmer', 'land', 'zahlungsart', 'beleg_datei', 'original_sha', 'rechnung'] },
  zahlungen: { schluessel: "nr || '/' || lfd", spalten: ['nr', 'lfd', 'art', 'tag', 'betrag', 'zahlungsart'] },
  einkaeufe: { schluessel: 'ref', spalten: ['ref', 'version', 'rechnungsnummer', 'datum', 'brutto', 'mwst', 'netto', 'wirksam', 'beleg_datei', 'beleg_sha', 'rechnung'] },
  belege: { schluessel: 'id', spalten: ['id', 'lieferant', 'rechnungsnummer', 'datum', 'art', 'brutto', 'mwst', 'netto', 'wirksam', 'ausgeblendet', 'p13b', 'beleg_sha', 'rechnung'] }
}

const TAG = /^\d{4}-\d{2}-\d{2}/
const tag = (x) => (TAG.test(String(x || '')) ? String(x).slice(0, 10) : null)
const zahl = (x) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Math.round(Number(x) * 100) / 100 : null)
const text = (x) => (x === undefined || x === null || x === '' ? null : String(x))
const versionNr = (x) => { const n = parseInt(String(x ?? '').replace(/\D/g, ''), 10); return Number.isFinite(n) ? n : null }
// Rechnung ohne Kundendaten (Name, Anschrift, E-Mail) und ohne Bild-Links
function ohneKunde(r) {
  if (!r || typeof r !== 'object') return null
  const { empfaenger, ...rest } = r
  if (Array.isArray(rest.positionen)) rest.positionen = rest.positionen.map(({ bildUrl, ...p }) => p)
  return JSON.parse(JSON.stringify(rest)) // undefined-Felder fallen weg, wie später in jsonb
}

// Aus den Quellen des Plugins die Zeilen aller Tabellen bauen (rein, ohne Datenbank: testbar)
// shop: bestellungen.eintraege(), shirtigo: shirtigoB.eintraege(), belege: eingelesene PDFs (auch ausgeblendete, mit § 13b)
function zeilenBauen({ shop = [], shirtigo = [], belege = [] } = {}) {
  const bestellungen = []
  const zahlungen = []
  for (const e of shop) {
    const r = e?.rechnung
    if (!r) continue
    const nr = String(r.referenz ?? e.id).replace(/^s/, '')
    const z = r.zahlung || {}
    bestellungen.push([nr, versionNr(e.beleg?.version ?? r.version), tag(r.datum), tag(z.datum), !!r.storniert, !!z.bezahlt,
      zahl(r.summen?.brutto) ?? 0, zahl(r.summen?.mwst) ?? 0, zahl(r.summen?.netto) ?? 0, zahl(r.wirksam) ?? 0, zahl(r.summen?.mwstSatz),
      !!r.kleinunternehmer, text(r.empfaenger?.land), text(z.art), text(e.beleg?.pdf), text(e.beleg?.sha256), ohneKunde(r)])
    let lfd = 0
    for (const [art, liste] of [['eingang', z.eingaenge], ['erstattung', z.erstattungen]]) {
      for (const p of Array.isArray(liste) ? liste : []) zahlungen.push([nr, ++lfd, art, tag(p.datum), zahl(p.betrag) ?? 0, text(p.gateway)])
    }
  }
  const einkaeufe = shirtigo.filter((e) => e?.rechnung).map((e) => {
    const r = e.rechnung
    return [String(e.id).replace(/^t/, ''), versionNr(r.version), text(r.rechnungsnummer), tag(r.datum), zahl(r.summen?.brutto), zahl(r.summen?.mwst),
      zahl(r.summen?.netto), zahl(r.wirksam), text(e.beleg?.pdf), text(e.beleg?.sha256), ohneKunde(r)]
  })
  const belegZeilen = belege.filter((d) => d?.id).map((d) => {
    const r = d.rechnung || null
    return [String(d.id), text(r?.lieferant), text(r?.rechnungsnummer), tag(r?.datum), text(r?.art), zahl(r?.summen?.brutto), zahl(r?.summen?.mwst),
      zahl(r?.summen?.netto), zahl(r?.wirksam), !!d.ausgeblendet, r?.p13b ? JSON.parse(JSON.stringify(r.p13b)) : null, text(d.archiv?.sha256), ohneKunde(r)]
  })
  return { bestellungen, zahlungen, einkaeufe, belege: belegZeilen }
}

// Kennung der Quellen: ändert sie sich nicht, muss nicht neu aufgebaut werden
const quelleVon = (teile) => crypto.createHash('sha256').update(JSON.stringify(teile)).digest('hex')

async function einfuegen(c, tabelle, zeilen, ziel = `buchhaltung.${tabelle}`) {
  const { spalten } = TABELLEN[tabelle]
  for (let i = 0; i < zeilen.length; i += 200) {
    const paket = zeilen.slice(i, i + 200)
    const werte = []
    const platz = paket.map((z) => `(${z.map((w) => { werte.push(w !== null && typeof w === 'object' ? JSON.stringify(w) : w); return `$${werte.length}` }).join(', ')})`)
    await c.query(`INSERT INTO ${ziel} (${spalten.join(', ')}) VALUES ${platz.join(', ')}`, werte)
  }
}

async function einrichten(db) { return db.migrieren(MIGRATIONEN) }

// Alles neu aufbauen, in einer Transaktion (wer liest, sieht nie einen halben Stand)
async function aufbauen(db, zeilen, quelle) {
  const anzahl = Object.fromEntries(Object.keys(TABELLEN).map((t) => [t, zeilen[t].length]))
  await db.transaktion(async (c) => {
    await c.query(`TRUNCATE ${Object.keys(TABELLEN).map((t) => `buchhaltung.${t}`).join(', ')}`)
    for (const t of Object.keys(TABELLEN)) await einfuegen(c, t, zeilen[t])
    await c.query(`INSERT INTO buchhaltung.aufbau (id, zeit, quelle, anzahl) VALUES (1, now(), $1, $2)
      ON CONFLICT (id) DO UPDATE SET zeit = now(), quelle = $1, anzahl = $2`, [quelle, JSON.stringify(anzahl)])
  })
  return anzahl
}

async function stand(db) {
  const r = await db.abfrage('SELECT zeit, quelle, anzahl FROM buchhaltung.aufbau WHERE id = 1')
  return r.rows[0] ? { zeit: r.rows[0].zeit.toISOString(), quelle: r.rows[0].quelle, anzahl: r.rows[0].anzahl } : null
}

// Gegenprobe (D.3): frischer Aufbau in Temp-Tabellen, dann Zeile für Zeile vergleichen (EXCEPT in beide Richtungen)
async function pruefen(db, zeilen) {
  return db.transaktion(async (c) => {
    const ergebnis = {}
    for (const [t, { schluessel }] of Object.entries(TABELLEN)) {
      await c.query(`CREATE TEMP TABLE frisch_${t} (LIKE buchhaltung.${t}) ON COMMIT DROP`)
      await einfuegen(c, t, zeilen[t], `frisch_${t}`)
      const fehlt = await c.query(`SELECT ${schluessel} AS k FROM (SELECT * FROM frisch_${t} EXCEPT SELECT * FROM buchhaltung.${t}) x ORDER BY 1 LIMIT 5`)
      const zuviel = await c.query(`SELECT ${schluessel} AS k FROM (SELECT * FROM buchhaltung.${t} EXCEPT SELECT * FROM frisch_${t}) x ORDER BY 1 LIMIT 5`)
      ergebnis[t] = { fehltOderAnders: fehlt.rows.map((z) => z.k), nurInDatenbank: zuviel.rows.map((z) => z.k) }
    }
    const ok = Object.values(ergebnis).every((x) => !x.fehltOderAnders.length && !x.nurInDatenbank.length)
    return { ok, zeit: new Date().toISOString(), tabellen: ergebnis }
  })
}

// Summen je Jahr aus der Datenbank (für den Abgleich mit der Anzeige und später für Auswertungen per SQL)
async function jahresSummen(db) {
  const r = await db.abfrage(`SELECT to_char(bestelltag, 'YYYY') AS jahr, count(*)::int AS anzahl, sum(brutto)::text AS brutto,
    sum(mwst)::text AS mwst, sum(wirksam)::text AS wirksam FROM buchhaltung.bestellungen GROUP BY 1 ORDER BY 1`)
  return r.rows.map((z) => ({ jahr: z.jahr, anzahl: z.anzahl, brutto: Number(z.brutto), mwst: Number(z.mwst), wirksam: Number(z.wirksam) }))
}

module.exports = { MIGRATIONEN, TABELLEN, zeilenBauen, quelleVon, einrichten, aufbauen, stand, pruefen, jahresSummen, ohneKunde }
