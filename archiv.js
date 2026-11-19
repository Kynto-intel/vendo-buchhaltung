'use strict'
// Zentrales, unveränderliches Belegarchiv (Plan 7.5, Schritt 1.1). Seit Schritt 1.5 schreiben Shopify- und Shirtigo-Abgleich hierher.
//
// Aufbau:
//   <wurzel>\<Jahr>\<Art>\<Name>__<Hash12>.<Endung>   jede Datei wird genau einmal geschrieben und danach schreibgeschützt
//   <wurzel>\index.jsonl                              nur anhängen; je Zeile SHA-256 der Datei + Hash der Vorzeile (Kette)
//
// Es gibt bewusst keine Funktion zum Löschen oder Überschreiben. Gleicher Inhalt in derselben Art wird nicht doppelt abgelegt.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const NULLHASH = '0'.repeat(64)
const ART = /^[a-z0-9][a-z0-9-]{0,39}$/ // z. B. shopify-original, umsatzbeleg, eingang, e-rechnung, pruefbericht, zeitstempel
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex')

// Dateiname ohne Pfadteile und Windows-Sonderzeichen; Endung klein
function sichererName(name) {
  const basis = path.basename(String(name || '')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim()
  const roh = path.extname(basis).toLowerCase()
  const endung = /^\.[a-z0-9]{1,10}$/.test(roh) ? roh : '' // nie mit Punkt enden (Windows)
  const stamm = basis.slice(0, basis.length - path.extname(basis).length).replace(/[. ]+$/, '').slice(0, 80) || 'datei'
  return { stamm, endung }
}

// optionen.schutz: { schuetzen({ dateien, nurLoeschen, ordner }) → { erfolgreich } } – in der App ./schutz (Windows-Rechte),
// in Tests ein Stub oder weggelassen. Ein fehlgeschlagener Schutz verhindert das Ablegen nicht, wird aber gemeldet.
function archiv(wurzel, { schutz = null } = {}) {
  if (!path.isAbsolute(String(wurzel || ''))) throw new Error('Archivordner muss ein absoluter Pfad sein.')
  const INDEX = path.join(wurzel, 'index.jsonl')
  let cache = null // { groesse, eintraege }

  function indexLesen() {
    const groesse = fs.existsSync(INDEX) ? fs.statSync(INDEX).size : 0
    if (cache && cache.groesse === groesse) return cache.eintraege
    const eintraege = groesse ? fs.readFileSync(INDEX, 'utf8').split('\n').filter(Boolean).map((z, i) => {
      try { return JSON.parse(z) } catch { return { kaputt: true, zeile: i + 1 } }
    }) : []
    cache = { groesse, eintraege }
    return eintraege
  }

  function anhaengen(eintrag) {
    const liste = indexLesen()
    if (liste.some((e) => e.kaputt)) throw new Error('Archivindex ist beschädigt – bitte zuerst die Integritätsprüfung ansehen.')
    const e = { nr: liste.length + 1, ...eintrag, vorher: liste.at(-1)?.hash || NULLHASH }
    e.hash = sha(JSON.stringify(e))
    fs.mkdirSync(wurzel, { recursive: true })
    fs.appendFileSync(INDEX, JSON.stringify(e) + '\n', 'utf8')
    cache = null
    return e
  }

  // inhalt: Buffer oder absoluter Pfad einer Quelldatei (wird kopiert, nie verschoben)
  // angaben: { art, jahr, name, meta?, sofortSchuetzen? } – meta ist ein kleines JSON-Objekt (z. B. Bestellnummer, Quelle).
  // sofortSchuetzen: false = Schutz später gesammelt über nachSchuetzen() (ein Windows-Aufruf statt einer je Datei)
  function ablegen(inhalt, { art, jahr, name, meta = {}, sofortSchuetzen = true } = {}) {
    if (!ART.test(String(art || ''))) throw new Error('Ungültige Belegart.')
    jahr = Number(jahr)
    if (!Number.isInteger(jahr) || jahr < 2000 || jahr > 2100) throw new Error('Ungültiges Jahr.')
    if (typeof inhalt === 'string') {
      if (!path.isAbsolute(inhalt)) throw new Error('Quelldatei muss ein absoluter Pfad sein.')
      if (!fs.statSync(inhalt, { throwIfNoEntry: false })?.isFile()) throw new Error('Quelldatei nicht gefunden.')
      name ||= path.basename(inhalt)
      inhalt = fs.readFileSync(inhalt)
    }
    if (!Buffer.isBuffer(inhalt) || !inhalt.length) throw new Error('Leere Datei kann nicht archiviert werden.')
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('Ungültige Zusatzangaben.')
    const metaText = JSON.stringify(meta)
    if (metaText.length > 4000) throw new Error('Zusatzangaben sind zu groß.')

    const hash = sha(inhalt)
    const vorhanden = indexLesen().find((e) => e.sha256 === hash && e.art === art)
    if (vorhanden) return { ...vorhanden, doppelt: true }

    const { stamm, endung } = sichererName(name)
    const relativ = path.join(String(jahr), art, `${stamm}__${hash.slice(0, 12)}${endung}`)
    const ziel = path.join(wurzel, relativ)
    fs.mkdirSync(path.dirname(ziel), { recursive: true })
    try {
      fs.writeFileSync(ziel, inhalt, { flag: 'wx' })
    } catch (fehler) {
      // Datei existiert schon (z. B. Abbruch vor dem Indexeintrag): nur übernehmen, wenn der Inhalt identisch ist
      if (fehler.code !== 'EEXIST' || sha(fs.readFileSync(ziel)) !== hash) throw fehler
    }
    try { fs.chmodSync(ziel, 0o444) } catch { /* Schreibschutz ist zusätzlich, nicht Pflicht */ }
    const eintrag = anhaengen({
      zeit: new Date().toISOString(), art, jahr, datei: relativ.split(path.sep).join('/'),
      name: `${stamm}${endung}`, sha256: hash, bytes: inhalt.length, meta: JSON.parse(metaText)
    })
    return sofortSchuetzen ? { ...eintrag, ...schuetzen([ziel]) } : { ...eintrag, geschuetzt: false }
  }

  // Schützt Dateien samt Jahres-/Art-Ordnern, Archivordner und Index. Liefert { geschuetzt, schutzFehler? }.
  function schuetzen(dateien) {
    if (!schutz) return { geschuetzt: false }
    const ordner = new Set([wurzel])
    for (const datei of dateien) for (let o = path.dirname(datei); o.startsWith(wurzel) && o !== wurzel; o = path.dirname(o)) ordner.add(o)
    try {
      const erg = schutz.schuetzen({ dateien, nurLoeschen: [INDEX], ordner: [...ordner] })
      return erg.erfolgreich ? { geschuetzt: true } : { geschuetzt: false, schutzFehler: erg.fehler }
    } catch (fehler) {
      return { geschuetzt: false, schutzFehler: [fehler.message] }
    }
  }

  // Schutz für alle Archivdateien (nach-)setzen, z. B. nach einer Migration oder wenn er entfernt wurde
  const alleSchuetzen = () => schuetzen(eintraege().map((e) => pfad(e)))
  const nachSchuetzen = (liste) => liste.length ? schuetzen(liste.map((e) => pfad(e))) : { geschuetzt: !!schutz }

  const eintraege = () => indexLesen().filter((e) => !e.kaputt).map((e) => ({ ...e }))
  const finden = (hash) => eintraege().filter((e) => e.sha256 === hash)
  const pfad = (eintrag) => path.join(wurzel, ...String(eintrag.datei).split('/'))

  // Prüft Kette, Einträge und Dateien. Meldet auch Dateien, die im Archiv liegen, aber nicht im Index stehen.
  // Gemeinsamer Kern als Generator: integritaet() läuft in einem Zug, integritaetAsync() gibt zwischendurch den
  // Hauptprozess frei (Schritt 1.10: Archiv mit über 1.400 Dateien blockierte sonst ~0,6 s).
  function* pruefKern() {
    cache = null
    const fehler = []
    const zeilen = indexLesen()
    const bekannt = new Set()
    let vorher = NULLHASH
    for (const [i, e] of zeilen.entries()) {
      if (i % 20 === 0) yield
      if (e.kaputt) { fehler.push(`Indexzeile ${e.zeile} ist unlesbar`); continue }
      const { hash, ...rest } = e
      if (e.nr !== i + 1) fehler.push(`Indexnummer ${e.nr} an Position ${i + 1}`)
      if (e.vorher !== vorher) fehler.push(`Index-Kette unterbrochen bei Eintrag ${e.nr}`)
      if (sha(JSON.stringify(rest)) !== hash) fehler.push(`Indexeintrag verändert: ${e.nr}`)
      vorher = hash
      const datei = pfad(e)
      bekannt.add(path.resolve(datei))
      if (!fs.existsSync(datei)) fehler.push(`Datei fehlt: ${e.datei}`)
      else if (sha(fs.readFileSync(datei)) !== e.sha256) fehler.push(`Datei verändert: ${e.datei}`)
    }
    const alle = (o) => fs.existsSync(o) ? fs.readdirSync(o, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? alle(path.join(o, d.name)) : [path.join(o, d.name)]) : []
    for (const datei of alle(wurzel)) {
      if (path.resolve(datei) === path.resolve(INDEX) || bekannt.has(path.resolve(datei))) continue
      fehler.push(`Datei nicht im Index: ${path.relative(wurzel, datei).split(path.sep).join('/')}`)
    }
    return { ok: fehler.length === 0, geprueft: zeilen.length, letzterHash: vorher, fehler }
  }
  function integritaet() {
    const lauf = pruefKern()
    for (;;) { const s = lauf.next(); if (s.done) return s.value }
  }
  async function integritaetAsync() {
    const lauf = pruefKern()
    for (;;) { const s = lauf.next(); if (s.done) return s.value; await new Promise((r) => setImmediate(r)) }
  }

  return { ablegen, eintraege, finden, pfad, integritaet, integritaetAsync, alleSchuetzen, nachSchuetzen, WURZEL: wurzel, INDEX }
}

module.exports = { archiv, sichererName }
