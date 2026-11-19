'use strict'
// „Meine Angaben“ (Plan 7.2, Schritt 2.1): eigene Angaben für Belege und E-Rechnungen – Felder, Prüfung, Vorschlag.
// Gespeichert wird in den Plugin-Daten (Plugin-Daten „buchhaltung“ (Datenbank), Schlüssel „angaben“), nicht im Code.
// Änderungen gelten erst für neue Belege (Umstellung des Codes in Schritt 2.3); bestehende Belege bleiben unverändert.
// Keine Geheimnisse hier (Tokens bleiben im Hauptprozess).

// typ: text (Standard) | email | textarea | zahl | datum | auswahl | liste (eine Angabe je Zeile)
const FELDER = [
  { feld: 'firmenname', gruppe: 'Unternehmen', label: 'Firmen- bzw. Shopname', pflicht: true },
  { feld: 'inhaber', gruppe: 'Unternehmen', label: 'Vollständiger Name (Inhaber/in)', pflicht: true },
  { feld: 'taetigkeit', gruppe: 'Unternehmen', label: 'Art des Betriebs (Anlage EÜR) bzw. Gegenstand des Unternehmens', maxLaenge: 100 },
  { feld: 'gruendungsdatum', gruppe: 'Unternehmen', label: 'Gründungsdatum', typ: 'datum' },
  { feld: 'strasse', gruppe: 'Anschrift', label: 'Straße und Hausnummer', pflicht: true },
  { feld: 'plz', gruppe: 'Anschrift', label: 'PLZ', pflicht: true },
  { feld: 'ort', gruppe: 'Anschrift', label: 'Ort', pflicht: true },
  { feld: 'land', gruppe: 'Anschrift', label: 'Land (Ländercode, z. B. DE)', pflicht: true, standard: 'DE' },
  { feld: 'email', gruppe: 'Unternehmen', label: 'E-Mail', pflicht: true, typ: 'email', hilfe: 'Für E-Rechnungen Pflicht (elektronische Adresse)' },
  { feld: 'telefon', gruppe: 'Unternehmen', label: 'Telefon' },
  { feld: 'website', gruppe: 'Unternehmen', label: 'Website' },
  { feld: 'steuernummer', gruppe: 'Steuern', label: 'Steuernummer (wie auf dem Bescheid)', hilfe: 'Steuernummer oder USt-IdNr./W-IdNr. ist für E-Rechnungen nötig' },
  { feld: 'finanzamt', gruppe: 'Steuern', label: 'Finanzamt' },
  { feld: 'ustId', gruppe: 'Steuern', label: 'USt-IdNr.', hilfe: 'z. B. DE123456789' },
  {
    feld: 'rechtsform', gruppe: 'Steuern', label: 'Rechtsform', typ: 'auswahl', pflicht: true, standard: 'einzelunternehmen',
    optionen: [
      { wert: 'einzelunternehmen', label: 'Einzelunternehmen' },
      { wert: 'gmbh', label: 'GmbH' },
      { wert: 'ug', label: 'UG (haftungsbeschränkt)' }
    ]
  },
  {
    feld: 'einkunftsart', gruppe: 'Steuern', label: 'Einkunftsart (für die Anlage EÜR)', typ: 'auswahl',
    anzeigenWenn: { feld: 'rechtsform', wert: 'einzelunternehmen' },
    optionen: [
      { wert: '', label: 'Bitte wählen' },
      { wert: 'selbstaendig', label: 'Selbständige Arbeit (freier Beruf, z. B. Entwickler, Berater)' },
      { wert: 'gewerbe', label: 'Gewerbebetrieb' }
    ]
  },
  {
    feld: 'versteuerung', gruppe: 'Steuern', label: 'Versteuerung', typ: 'auswahl', standard: 'ist',
    optionen: [
      { wert: 'ist', label: 'Ist (nach vereinnahmten Entgelten)' },
      { wert: 'soll', label: 'Soll (nach vereinbarten Entgelten)' }
    ]
  },
  {
    feld: 'kontenrahmen', gruppe: 'Steuern', label: 'Kontenrahmen (wie in Lexoffice)', typ: 'auswahl', standard: 'SKR03',
    optionen: [
      { wert: 'SKR03', label: 'SKR03' },
      { wert: 'SKR04', label: 'SKR04' }
    ]
  },
  { feld: 'wId', gruppe: 'Steuern', label: 'Wirtschafts-Identifikationsnummer (W-IdNr.)', hilfe: 'DE + 9 Ziffern, optional - + 5 Ziffern' },
  { feld: 'hinweis19', gruppe: 'Steuern', label: 'Hinweistext Kleinunternehmer', typ: 'textarea', standard: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.' },
  { feld: 'kontoinhaber', gruppe: 'Bankverbindung', label: 'Kontoinhaber/in' },
  { feld: 'iban', gruppe: 'Bankverbindung', label: 'IBAN' },
  { feld: 'bic', gruppe: 'Bankverbindung', label: 'BIC' },
  { feld: 'bank', gruppe: 'Bankverbindung', label: 'Bank' },
  { feld: 'nummernFormat', gruppe: 'Rechnungen und Angebote', label: 'Nummernkreis', standard: 'RE-{JJJJ}-{NNNN}', hilfe: 'Platzhalter: {JJJJ} Jahr, {MM} Monat, {NNNN} laufende Nummer (Anzahl N = Stellen)' },
  { feld: 'naechsteNummer', gruppe: 'Rechnungen und Angebote', label: 'Nächste laufende Nummer', typ: 'zahl', standard: '1' },
  { feld: 'zahlungsbedingungen', gruppe: 'Rechnungen und Angebote', label: 'Zahlungsbedingungen', typ: 'textarea' },
  { feld: 'dankestext', gruppe: 'Rechnungen und Angebote', label: 'Dankestext', typ: 'textarea' },
  { feld: 'eigeneNamen', gruppe: 'Belegerkennung', label: 'Eigene Namen (eine Angabe je Zeile)', typ: 'liste', hilfe: 'Daran erkennt Vendo eingelesene Rechnungen als eigene Einnahmen' }
]
const NAMEN = new Set(FELDER.map((f) => f.feld))
const standardwerte = () => ({ ...Object.fromEntries(FELDER.map((f) => [f.feld, f.typ === 'liste' ? [] : (f.standard || '')])), steuerzeitraeume: [] })

// ---------- Steuerstatus je Zeitraum (Schritt 2.2, Plan 7.2 + 8.1) ----------
// Zeilen { von, bis, art: 'klein' | 'regel', satz }. Datum als JJJJ-MM-TT (Berliner Kalendertag), von leer = „seit Beginn“
// (nur erste Zeile), bis leer = „bis heute und weiter“ (nur letzte Zeile). Die Zeilen müssen lückenlos aneinander anschließen.
const STEUERARTEN = { klein: 'Kleinunternehmer (§ 19 UStG)', regel: 'Regelbesteuerung' }
const MAX_ZEITRAEUME = 20
const tagGueltig = (t) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false
  const d = new Date(`${t}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t && t >= '2000-01-01' && t <= '2099-12-31'
}
const tagPlus = (t, n) => { const d = new Date(`${t}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const tagDeutsch = (t) => t ? `${t.slice(8, 10)}.${t.slice(5, 7)}.${t.slice(0, 4)}` : ''
function satzLesen(roh) {
  if (typeof roh === 'number') return roh
  const s = String(roh ?? '').replace(/%/g, '').trim().replace(',', '.')
  return /^\d{1,2}(\.\d{1,2})?$/.test(s) ? Number(s) : String(roh ?? '').trim()
}
function zeitraeumeNormalisieren(roh) {
  if (!Array.isArray(roh)) return []
  return roh.slice(0, MAX_ZEITRAEUME).filter((z) => z && typeof z === 'object').map((z) => {
    const art = z.art === 'regel' ? 'regel' : 'klein'
    return { von: String(z.von ?? '').trim(), bis: String(z.bis ?? '').trim(), art, satz: art === 'regel' ? satzLesen(z.satz) : null }
  }).sort((a, b) => (a.von || '').localeCompare(b.von || '')) // stabil: „seit Beginn“ zuerst
}
// Erster Fehler als Text (oder null) und Hinweise
function zeitraeumePruefen(liste) {
  const hinweise = []
  if (!liste.length) return { fehler: null, hinweise }
  const zeile = (i) => liste.length > 1 ? `Zeile ${i + 1}: ` : ''
  for (const [i, z] of liste.entries()) {
    if (z.von && !tagGueltig(z.von)) return { fehler: `${zeile(i)}„von“ ist kein gültiges Datum.`, hinweise }
    if (z.bis && !tagGueltig(z.bis)) return { fehler: `${zeile(i)}„bis“ ist kein gültiges Datum.`, hinweise }
    if (z.von && z.bis && z.bis < z.von) return { fehler: `${zeile(i)}„bis“ liegt vor „von“.`, hinweise }
    if (!z.von && i > 0) return { fehler: `${zeile(i)}Bitte ein Anfangsdatum angeben (nur der erste Zeitraum darf „seit Beginn“ sein).`, hinweise }
    if (!z.bis && i < liste.length - 1) return { fehler: `${zeile(i)}Bitte ein Enddatum angeben (nur der letzte Zeitraum darf offen bleiben).`, hinweise }
    if (z.art === 'regel' && !(typeof z.satz === 'number' && z.satz > 0 && z.satz <= 30)) return { fehler: `${zeile(i)}Bitte den Steuersatz in Prozent angeben, z. B. 19.`, hinweise }
    if (i > 0) {
      const vorher = liste[i - 1]
      if (z.von <= vorher.bis) return { fehler: `Zeile ${i} und ${i + 1} überschneiden sich (${tagDeutsch(z.von)}).`, hinweise }
      if (z.von !== tagPlus(vorher.bis, 1)) return { fehler: `Zwischen ${tagDeutsch(vorher.bis)} und ${tagDeutsch(z.von)} fehlt ein Zeitraum.`, hinweise }
    }
  }
  const letzte = liste.at(-1)
  if (letzte.bis) hinweise.push(`Nach dem ${tagDeutsch(letzte.bis)} ist kein Steuerstatus angegeben. Für die laufende Zeit bitte den letzten Zeitraum offen lassen.`)
  if (liste[0].von) hinweise.push(`Vor dem ${tagDeutsch(liste[0].von)} ist kein Steuerstatus angegeben.`)
  if (liste.some((z) => z.art === 'regel' && z.satz !== 19 && z.satz !== 7)) hinweise.push('Ungewöhnlicher Steuersatz – in Deutschland gelten 19 % oder 7 %.')
  return { fehler: null, hinweise }
}
// Steuerstatus an einem Tag (JJJJ-MM-TT) → { art, satz, von, bis } oder null, wenn für den Tag nichts angegeben ist
function steuerstatusAm(liste, tag) {
  const t = String(tag || '').slice(0, 10)
  return (liste || []).find((z) => (!z.von || z.von <= t) && (!z.bis || t <= z.bis)) || null
}

// Vorschlag aus den Shopify-Bestellungen (Plan 8.1): Regelbesteuerung vom ersten bis zum letzten Tag mit Steuer, sonst
// Kleinunternehmer. befund = [{ datum, steuer, brutto, storniert }]. Nur ein Vorschlag – gilt erst nach „Speichern“.
function steuerVorschlag(befund = []) {
  const mit = befund.filter((b) => !b.storniert && b.steuer > 0).sort((a, b) => a.datum.localeCompare(b.datum))
  if (!mit.length) return { zeitraeume: [{ von: '', bis: '', art: 'klein', satz: null }], anzahl: 0, von: null, bis: null, satz: null, steuer: 0 }
  const saetze = mit.filter((b) => b.brutto > b.steuer).map((b) => (b.steuer / (b.brutto - b.steuer)) * 100).sort((a, b) => a - b)
  const mitte = saetze.length ? saetze[Math.floor(saetze.length / 2)] : 19
  const satz = [19, 7].find((s) => Math.abs(s - mitte) <= 0.5) ?? Math.round(mitte * 10) / 10
  const von = mit[0].datum
  const bis = mit.at(-1).datum
  return {
    zeitraeume: [
      { von: '', bis: tagPlus(von, -1), art: 'klein', satz: null },
      { von, bis, art: 'regel', satz },
      { von: tagPlus(bis, 1), bis: '', art: 'klein', satz: null }
    ],
    anzahl: mit.length, von, bis, satz, steuer: Math.round(mit.reduce((s, b) => s + b.steuer, 0) * 100) / 100
  }
}
// Passen die Bestellungen zum Steuerstatus? (Shopify berechnet Steuer, laut Angabe gilt aber § 19 – oder umgekehrt.)
function steuerAbgleich(liste, befund = []) {
  const ergebnis = { geprueft: 0, steuerTrotzKlein: [], ohneSteuerBeiRegel: [], ohneStatus: [] }
  if (!liste?.length) return ergebnis
  for (const b of befund) {
    if (b.storniert || !(b.brutto > 0)) continue
    ergebnis.geprueft++
    const z = steuerstatusAm(liste, b.datum)
    const kurz = { nr: b.nr, datum: b.datum }
    if (!z) ergebnis.ohneStatus.push(kurz)
    else if (z.art === 'klein' && b.steuer > 0) ergebnis.steuerTrotzKlein.push(kurz)
    else if (z.art === 'regel' && !(b.steuer > 0)) ergebnis.ohneSteuerBeiRegel.push(kurz)
  }
  return ergebnis
}

// ---------- Normalisieren: nur bekannte Felder, Leerraum, Groß-/Kleinschreibung bei Kennungen ----------
function normalisieren(eingabe = {}) {
  const w = standardwerte()
  for (const f of FELDER) {
    const roh = eingabe[f.feld]
    if (roh == null) continue
    if (f.typ === 'liste') {
      const teile = (Array.isArray(roh) ? roh : String(roh).split(/\r?\n|,/)).map((x) => String(x).trim().replace(/\s+/g, ' ')).filter(Boolean)
      w[f.feld] = [...new Set(teile)].slice(0, 20)
      continue
    }
    let s = String(roh).replace(/\r\n/g, '\n').trim()
    if (f.typ !== 'textarea') s = s.replace(/\s+/g, ' ')
    if (['land', 'ustId', 'wId', 'iban', 'bic'].includes(f.feld)) s = s.toUpperCase()
    if (['ustId', 'wId', 'iban', 'bic'].includes(f.feld)) s = s.replace(/\s+/g, '')
    if (f.feld === 'email') s = s.toLowerCase()
    w[f.feld] = s
  }
  w.steuerzeitraeume = zeitraeumeNormalisieren(eingabe.steuerzeitraeume)
  return w
}

// ---------- Prüfen ----------
function ibanGueltig(iban) {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false
  if (iban.startsWith('DE') && iban.length !== 22) return false
  const umgestellt = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55))
  let rest = 0
  for (const ziffer of umgestellt) rest = (rest * 10 + Number(ziffer)) % 97
  return rest === 1
}
const ibanAnzeige = (iban) => String(iban || '').replace(/(.{4})/g, '$1 ').trim()
function datumIsoGueltig(t) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false
  if (t < '0001-01-01') return false
  const d = new Date(`${t}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t
}

function pruefen(werte) {
  const w = werte || {}
  const fehler = {}
  const leer = (f) => !w[f] || (Array.isArray(w[f]) && !w[f].length)
  const sichtbar = (f) => !f.anzeigenWenn || w[f.anzeigenWenn.feld] === f.anzeigenWenn.wert
  for (const f of FELDER) {
    if (!sichtbar(f)) continue
    const v = w[f.feld]
    if (f.typ === 'liste') { if ((v || []).some((x) => x.length < 2 || x.length > 60)) fehler[f.feld] = 'Jeder Name muss 2 bis 60 Zeichen lang sein.'; continue }
    if (String(v || '').length > (f.maxLaenge || (f.typ === 'textarea' ? 1000 : 200))) fehler[f.feld] = 'Zu lang.'
  }
  const regel = (feld, ok, text) => { if (!leer(feld) && !fehler[feld] && !ok(w[feld])) fehler[feld] = text }
  const heute = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' })
  regel('gruendungsdatum', (v) => datumIsoGueltig(v) && v <= heute, 'Bitte ein gültiges Gründungsdatum bis heute angeben.')
  for (const f of FELDER.filter((x) => x.typ === 'auswahl')) {
    if (!sichtbar(f)) continue
    const optionen = f.optionen.filter((x) => x.wert).map((x) => x.wert)
    regel(f.feld, (v) => optionen.includes(v), 'Bitte eine gültige Auswahl treffen.')
  }
  regel('land', (v) => /^[A-Z]{2}$/.test(v), 'Bitte den zweistelligen Ländercode angeben, z. B. DE oder AT.')
  regel('plz', (v) => (w.land || 'DE') === 'DE' ? /^\d{5}$/.test(v) : /^[A-Z0-9][A-Z0-9 -]{2,9}$/i.test(v), (w.land || 'DE') === 'DE' ? 'Eine deutsche PLZ hat 5 Ziffern.' : 'Ungültige Postleitzahl.')
  regel('email', (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v), 'Das ist keine gültige E-Mail-Adresse.')
  regel('website', (v) => /^(https?:\/\/)?[a-z0-9äöü-]+(\.[a-z0-9äöü-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(v), 'Bitte eine Adresse wie beispiel.de angeben.')
  regel('telefon', (v) => /^\+?[0-9][0-9 ()/-]{4,24}$/.test(v), 'Bitte nur Ziffern, Leerzeichen, +, /, - und Klammern.')
  regel('steuernummer', (v) => /^[0-9][0-9 /]{8,18}$/.test(v) && (v.match(/\d/g) || []).length >= 10 && (v.match(/\d/g) || []).length <= 13, 'Eine Steuernummer hat 10 bis 13 Ziffern (z. B. 123/456/78901).')
  regel('ustId', (v) => v.startsWith('DE') ? /^DE\d{9}$/.test(v) : /^[A-Z]{2}[0-9A-Z]{2,13}$/.test(v), 'Eine deutsche USt-IdNr. ist DE + 9 Ziffern.')
  regel('wId', (v) => /^DE\d{9}(-\d{5})?$/.test(v), 'Die W-IdNr. ist DE + 9 Ziffern, optional mit -00001.')
  regel('iban', ibanGueltig, 'Die IBAN ist ungültig (Prüfsumme oder Länge stimmt nicht).')
  regel('bic', (v) => /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v), 'Ein BIC hat 8 oder 11 Zeichen, z. B. NTSBDEB1XXX.')
  regel('nummernFormat', (v) => /\{N+\}/.test(v) && !/[\\/:*?"<>|]/.test(v) && !/\{(?!JJJJ\}|JJ\}|MM\}|N+\})[^}]*\}/.test(v) && v.length <= 40, 'Der Nummernkreis braucht {NNNN} und darf nur {JJJJ}, {JJ}, {MM} enthalten (keine Zeichen wie / \\ : *).')
  regel('naechsteNummer', (v) => /^\d{1,9}$/.test(v) && Number(v) >= 1, 'Bitte eine ganze Zahl ab 1.')

  const zeitraeume = zeitraeumePruefen(Array.isArray(w.steuerzeitraeume) ? w.steuerzeitraeume : [])
  if (zeitraeume.fehler) fehler.steuerzeitraeume = zeitraeume.fehler

  const fehlend = FELDER.filter((f) => f.pflicht && leer(f.feld)).map((f) => f.feld)
  if (leer('steuernummer') && leer('ustId') && leer('wId')) fehlend.push('steuerkennung')
  if (leer('steuerzeitraeume')) fehlend.push('steuerzeitraeume')
  const hinweise = [...zeitraeume.hinweise]
  if (leer('hinweis19')) hinweise.push('Ohne Hinweistext fehlt auf Belegen der Hinweis auf die Kleinunternehmerregelung.')
  if (leer('iban')) hinweise.push('Ohne IBAN steht keine Bankverbindung auf den Belegen.')
  if (leer('eigeneNamen')) hinweise.push('Ohne eigene Namen kann Vendo eingelesene Rechnungen nicht als Einnahmen erkennen.')
  return { ok: !Object.keys(fehler).length, vollstaendig: !Object.keys(fehler).length && !fehlend.length, fehler, fehlend, hinweise }
}

// Vorschau des Nummernkreises, z. B. RE-{JJJJ}-{NNNN} + 7 → RE-2026-0007
function nummerVorschau(format, nummer, datum = new Date()) {
  const n = Math.max(1, Number(nummer) || 1)
  return String(format || '')
    .replace(/\{JJJJ\}/g, String(datum.getFullYear()))
    .replace(/\{JJ\}/g, String(datum.getFullYear()).slice(2))
    .replace(/\{MM\}/g, String(datum.getMonth() + 1).padStart(2, '0'))
    .replace(/\{(N+)\}/g, (_, ns) => String(n).padStart(ns.length, '0'))
}

// Welche Felder haben sich geändert? (für den Änderungsverlauf)
function unterschiede(alt = {}, neu = {}) {
  const gleich = (a, b) => JSON.stringify(a ?? (Array.isArray(b) ? [] : '')) === JSON.stringify(b ?? (Array.isArray(a) ? [] : ''))
  return [...FELDER.map((f) => f.feld), 'steuerzeitraeume'].filter((f) => !gleich(alt[f], neu[f])).map((f) => ({ feld: f, alt: alt[f] ?? null, neu: neu[f] }))
}

// Vorschlag aus den bisher fest im Code stehenden Angaben (beleg-layout.js FIRMA, parser.js EIGENE_NAMEN).
// Nur ein Vorschlag fürs Formular – wird erst durch „Speichern“ übernommen. Unsichere Teile bleiben leer.
function vorschlag(firma = {}, eigeneNamen = []) {
  const w = {}
  const zeilen = (firma.zeilen || []).map(String)
  const schluss = (firma.schluss || []).join(' ').replace(/\s+/g, ' ')
  if (firma.name) w.firmenname = String(firma.name)
  const mail = zeilen.find((z) => /@/.test(z))
  if (mail) w.email = mail.trim()
  const web = zeilen.find((z) => !/@/.test(z) && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(z.trim()))
  if (web) w.website = web.trim()
  const plzZeile = zeilen.find((z) => /\b\d{5}\b/.test(z))
  if (plzZeile) {
    w.plz = plzZeile.match(/\b\d{5}\b/)[0]
    if (/germany|deutschland/i.test(plzZeile)) w.land = 'DE'
  }
  const strasse = zeilen.find((z) => z !== plzZeile && !/@/.test(z) && z !== web && /\d/.test(z))
  if (strasse) {
    const [s, o] = strasse.split(/\s+\/\s+/)
    w.strasse = s.trim()
    if (o) w.ort = o.trim()
  }
  const inhaber = schluss.match(/Empfänger:\s*([^,]+),/)
  if (inhaber) { w.inhaber = inhaber[1].trim(); w.kontoinhaber = inhaber[1].trim() }
  const iban = schluss.match(/IBAN:\s*([A-Z]{2}[0-9A-Z ]{13,32}?)(?=,|$|\s+Bank)/)
  if (iban) w.iban = iban[1].replace(/\s+/g, '')
  const bank = schluss.match(/Bank:\s*([^,]+?)(?=,|$)/)
  if (bank) w.bank = bank[1].trim()
  const wid = schluss.match(/W-IdNr\.?:\s*(DE\d{9}(?:-\d{5})?)/)
  if (wid) w.wId = wid[1]
  const namen = (eigeneNamen || []).map((r) => String(r.source || r).replace(/[\\^$.*+?()[\]{}|]/g, '')).filter((x) => x.length >= 2)
  if (namen.length) w.eigeneNamen = namen.map((x) => x.charAt(0).toUpperCase() + x.slice(1))
  return w
}

module.exports = { FELDER, NAMEN, STEUERARTEN, standardwerte, normalisieren, pruefen, ibanGueltig, ibanAnzeige, nummerVorschau, unterschiede, vorschlag, steuerstatusAm, steuerVorschlag, steuerAbgleich, tagDeutsch }
