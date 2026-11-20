'use strict'
// Datenschutz im Alltag (Plan 8.6, Schritt 7.3): Verzeichnis der Verarbeitungstätigkeiten (Art. 30 DSGVO) als Entwurf,
// Auskunft je Person (Art. 15) als ZIP, Löschanfragen als Sperre bis zum Ende der Aufbewahrungsfrist (Art. 17 Abs. 3 lit. b,
// Art. 18) statt Löschen. „haben“ hat dafür keine Vorlage (nur Archivieren statt Löschen von Kontakten).
// Grundsatz: Rechnungs- und Kundendaten gehen nie an Hermes oder KI-Anbieter; dieses Modul wird nur vom Plugin selbst benutzt.

const fs = require('node:fs')
const crypto = require('node:crypto')

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const AUFBEWAHRUNG_BELEGE = 8 // Jahre, § 147 Abs. 3 AO / § 14b UStG (ab 2025); Beginn mit Ende des Kalenderjahres (§ 147 Abs. 4 AO)
const ARTEN_PERSON = new Set(['shopify-original', 'umsatzbeleg', 'shopify-zahlungen'])
const klein = (t) => String(t || '').trim().toLowerCase()
const tagDe = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(String(iso || '')) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '–')
const dateiname = (t) => String(t || '').split('/').pop()

// Bestellungen einer Person: E-Mail genau (ohne Groß/klein) oder Name als Teil (ab 3 Zeichen)
function suchen(shop = [], begriff = '') {
  const b = klein(begriff)
  if (b.length < 3) throw new Error('Bitte mindestens 3 Zeichen (E-Mail-Adresse oder Name) eingeben.')
  const mail = b.includes('@')
  return shop.filter(({ rechnung: r }) => {
    const e = r?.empfaenger || {}
    return mail ? klein(e.email) === b : klein(e.name).includes(b)
  }).map(({ rechnung: r }) => ({ nr: String(r.referenz), datum: r.datum, name: r.empfaenger?.name || '', email: r.empfaenger?.email || '', ort: [r.empfaenger?.plz, r.empfaenger?.ort].filter(Boolean).join(' ') }))
    .sort((a, b2) => String(a.datum).localeCompare(String(b2.datum)))
}

// Archiveinträge mit Personenbezug zu diesen Bestellungen (alle Versionen und Neufassungen)
const eintraegeZu = (archiv, nrs) => { const s = new Set(nrs.map(String)); return archiv.eintraege().filter((e) => ARTEN_PERSON.has(e.art) && s.has(String(e.meta?.bestellung))) }

// Gesperrt bis: Ende des Kalenderjahres, in dem der jüngste Beleg entstanden ist (Zeit der Ablage), plus 8 Jahre.
// Bestelltag zählt mit, falls ein Beleg später entstanden ist, gewinnt der spätere (z. B. Neufassung 2026 für 2024).
function gesperrtBis({ archiv, shop = [], nrs = [] }) {
  const jahre = [...eintraegeZu(archiv, nrs).map((e) => Number(String(e.zeit || '').slice(0, 4))),
    ...shop.filter((x) => nrs.includes(String(x.rechnung?.referenz))).map((x) => Number(String(x.rechnung.datum || '').slice(0, 4)))].filter(Boolean)
  return jahre.length ? `${Math.max(...jahre) + AUFBEWAHRUNG_BELEGE}-12-31` : null
}

// Auskunft (Art. 15): Lesbare Auskunft, Datenauszug (JSON) und Kopien der Belege und Originaldatensätze dieser Bestellungen
function auskunft({ archiv, shop = [], shirtigo = [], nrs = [], firma = {}, jetzt = new Date().toISOString() }) {
  nrs = [...new Set(nrs.map(String))]
  const best = shop.filter((x) => nrs.includes(String(x.rechnung?.referenz)))
  if (!best.length) throw new Error('Keine passenden Bestellungen.')
  const dateien = []
  const fehler = []
  for (const e of eintraegeZu(archiv, nrs)) {
    let inhalt
    try { inhalt = fs.readFileSync(archiv.pfad(e)) } catch { fehler.push(`Datei fehlt im Archiv: ${e.datei}`); continue }
    if (sha(inhalt) !== e.sha256) { fehler.push(`Datei passt nicht zur Prüfsumme: ${e.datei}`); continue }
    dateien.push({ name: `${e.art === 'umsatzbeleg' ? 'belege' : 'originale'}/${dateiname(e.datei)}`, inhalt })
  }
  const daten = best.map(({ rechnung: r }) => ({
    bestellung: r.referenz, datum: r.datum, empfaenger: r.empfaenger || {},
    positionen: (r.positionen || []).map((p) => ({ bezeichnung: p.bezeichnung, farbe: p.farbe, groesse: p.groesse, menge: p.menge, gesamt: p.gesamt })),
    summen: r.summen || {}, zahlung: { art: r.zahlung?.art || null, datum: r.zahlung?.datum || null, bezahlt: !!r.zahlung?.bezahlt }, storniert: !!r.storniert,
    weitergabeShirtigo: shirtigo.filter((s) => String(s.rechnung?.referenz) === String(r.referenz)).map((s) => String(s.id).replace(/^t/, ''))
  }))
  const person = daten[0].empfaenger
  const bis = gesperrtBis({ archiv, shop, nrs })
  const text = [
    `# Auskunft nach Art. 15 DSGVO`, '',
    `Verantwortlich: ${[firma.firmenname, firma.inhaber].filter(Boolean).join(', ')}, ${[firma.strasse, [firma.plz, firma.ort].filter(Boolean).join(' ')].filter(Boolean).join(', ')}${firma.email ? `, ${firma.email}` : ''}`,
    `Erstellt am ${tagDe(jetzt)} für: ${person.name || '–'}${person.email ? ` (${person.email})` : ''}`, '',
    '## Welche Daten wir verarbeiten',
    '- Name, Lieferanschrift und E-Mail-Adresse aus Ihren Bestellungen, bestellte Artikel, Beträge, Zahlungsart und Zahlungstag.',
    `- Bestellungen: ${daten.map((d) => `${d.bestellung} vom ${tagDe(d.datum)}`).join('; ')}.`,
    '- Die Daten liegen vollständig in daten.json; Kopien der Belege und der gespeicherten Bestelldatensätze in belege/ und originale/.', '',
    '## Zwecke und Rechtsgrundlagen',
    '- Abwicklung Ihrer Bestellung (Art. 6 Abs. 1 lit. b DSGVO).',
    '- Erfüllung der steuer- und handelsrechtlichen Aufbewahrungspflichten (Art. 6 Abs. 1 lit. c DSGVO, § 147 AO, § 14b UStG).', '',
    '## Empfänger',
    '- Shopify (Shopbetrieb), der von Ihnen gewählte Zahlungsanbieter' + (daten.some((d) => d.weitergabeShirtigo.length) ? ', Shirtigo (Herstellung und Versand der Ware)' : '') + '. Keine Weitergabe an KI-Dienste.', '',
    '## Herkunft der Daten', '- Ihre Angaben bei der Bestellung im Online-Shop.', '',
    '## Speicherdauer',
    `- Rechnungen und Buchungsbelege werden 8 Jahre ab Ende des Jahres ihrer Entstehung aufbewahrt. Für diese Bestellungen: bis ${tagDe(bis)}. Danach werden die Daten gelöscht.`, '',
    '## Ihre Rechte',
    '- Berichtigung (Art. 16), Löschung (Art. 17; während der Aufbewahrungsfrist nur Sperrung), Einschränkung (Art. 18), Datenübertragbarkeit (Art. 20), Widerspruch (Art. 21) und Beschwerde bei einer Datenschutz-Aufsichtsbehörde (Art. 77).', ''
  ].join('\r\n')
  dateien.unshift({ name: 'daten.json', inhalt: Buffer.from(JSON.stringify(daten, null, 2), 'utf8') })
  dateien.unshift({ name: 'auskunft.md', inhalt: Buffer.from(text, 'utf8') })
  if (fehler.length) dateien.push({ name: 'FEHLER.txt', inhalt: Buffer.from(fehler.join('\r\n') + '\r\n', 'utf8') })
  return { dateien, fehler, gesperrtBis: bis, bestellungen: nrs, name: person.name || '' }
}

// Verzeichnis der Verarbeitungstätigkeiten (Art. 30 Abs. 1), Entwurf aus dem tatsächlichen Aufbau
function verzeichnis({ firma = {}, zahlungsarten = [], shirtigo = false, jetzt = new Date().toISOString() } = {}) {
  const fehlt = (w, was) => (String(w || '').trim() ? w : `**Fehlt: ${was}**`)
  const za = zahlungsarten.length ? zahlungsarten.join(', ') : 'laut Shopify-Einstellungen'
  const taetigkeit = (titel, zeilen) => [`## ${titel}`, '', ...zeilen.map(([k, v]) => `- **${k}:** ${v}`), '']
  const LOESCH = 'Rechnungen und Buchungsbelege 8 Jahre ab Ende des Entstehungsjahres (§ 147 AO, § 14b UStG), danach Löschung; Löschanfragen werden bis dahin als Sperre vermerkt'
  return [
    '# Verzeichnis von Verarbeitungstätigkeiten (Art. 30 Abs. 1 DSGVO) – Entwurf', '',
    `Erstellt am ${tagDe(jetzt)} aus dem Aufbau der Buchhaltung. Entwurf ohne Gewähr; bitte prüfen und ergänzen (z. B. Newsletter, Kontaktformular, Website-Analyse, die hier nicht erfasst sind).`, '',
    '## Verantwortlicher', '',
    `- ${fehlt(firma.firmenname, 'Firmenname')}, ${fehlt(firma.inhaber, 'Inhaber/in')}`,
    `- ${fehlt([firma.strasse, [firma.plz, firma.ort].filter(Boolean).join(' ')].filter(Boolean).join(', '), 'Anschrift')}, ${fehlt(firma.email, 'E-Mail')}`,
    '- Datenschutzbeauftragter: nicht benannt (keine Pflicht bei weniger als 20 Personen, die ständig personenbezogene Daten verarbeiten, § 38 BDSG) – bitte bestätigen', '',
    ...taetigkeit('1. Bestellabwicklung im Online-Shop', [
      ['Zweck', 'Annahme, Bezahlung und Abwicklung von Bestellungen'], ['Rechtsgrundlage', 'Art. 6 Abs. 1 lit. b DSGVO (Vertrag)'],
      ['Betroffene', 'Kundinnen und Kunden'], ['Daten', 'Name, Liefer- und Rechnungsanschrift, E-Mail, bestellte Artikel, Beträge, Zahlungsart'],
      ['Empfänger', `Shopify (Shopsystem, Auftragsverarbeiter), Zahlungsanbieter: ${za}`],
      ['Drittland', 'Shopify (Irland, Konzern in Kanada/USA): Angemessenheitsbeschluss bzw. Standardvertragsklauseln – im Shopify-Auftragsverarbeitungsvertrag prüfen'],
      ['Löschfrist', LOESCH], ['Technische und organisatorische Maßnahmen', 'Zugriff nur über das Shop-Konto mit Zwei-Faktor-Anmeldung (bitte bestätigen)']]),
    ...(shirtigo ? taetigkeit('2. Herstellung und Versand (Print-on-Demand)', [
      ['Zweck', 'Druck und Versand der bestellten Ware'], ['Rechtsgrundlage', 'Art. 6 Abs. 1 lit. b DSGVO'],
      ['Betroffene', 'Kundinnen und Kunden'], ['Daten', 'Name, Lieferanschrift, bestellte Artikel'],
      ['Empfänger', 'Shirtigo (Auftragsverarbeiter, Vertrag zur Auftragsverarbeitung prüfen), Versanddienstleister'], ['Drittland', 'keines bekannt'], ['Löschfrist', LOESCH]]) : []),
    ...taetigkeit(`${shirtigo ? 3 : 2}. Buchführung und Belegarchiv`, [
      ['Zweck', 'Erfüllung der Aufzeichnungs- und Aufbewahrungspflichten, Steuererklärung'], ['Rechtsgrundlage', 'Art. 6 Abs. 1 lit. c DSGVO (§ 147 AO, § 14b UStG)'],
      ['Betroffene', 'Kundinnen und Kunden, Lieferanten'], ['Daten', 'Bestelldatensätze, Umsatzbelege, Zahlungsnachweise, Eingangsrechnungen'],
      ['Empfänger', 'Finanzamt (nur auf Anforderung), Steuerberatung (falls beauftragt). Keine Weitergabe an Hermes oder KI-Anbieter'],
      ['Drittland', 'keines; Verarbeitung lokal auf dem eigenen Rechner'], ['Löschfrist', LOESCH],
      ['Technische und organisatorische Maßnahmen', 'Lokales Archiv mit Hash-Kette und Zeitstempeln, Windows-Dateischutz, verschlüsselte Zugangsdaten, Benutzerkonto mit Passwort']]),
    ...taetigkeit(`${shirtigo ? 4 : 3}. Datensicherung`, [
      ['Zweck', 'Schutz vor Datenverlust (Art. 32 DSGVO)'], ['Rechtsgrundlage', 'Art. 6 Abs. 1 lit. c und f DSGVO'],
      ['Betroffene', 'wie Buchführung'], ['Daten', 'Kopie des Belegarchivs'], ['Empfänger', 'keine'],
      ['Löschfrist', 'wie Buchführung'], ['Technische und organisatorische Maßnahmen', 'AES-256-GCM-verschlüsselter USB-Stick, Wiederherstellungsschlüssel getrennt verwahrt, jährlicher Wiederherstellungstest']]),
    '## Anfragen von Betroffenen', '',
    '- Auskunft: per Knopf als ZIP (Meine Angaben → Datenschutz). Frist: ein Monat (Art. 12 Abs. 3).',
    '- Löschung: Während der Aufbewahrungsfrist wird gesperrt statt gelöscht (Art. 17 Abs. 3 lit. b, Art. 18); im Shopify-Kundenkonto ist die Löschung dort selbst anzustoßen.', ''
  ].join('\n')
}

module.exports = { suchen, gesperrtBis, auskunft, verzeichnis, AUFBEWAHRUNG_BELEGE }
