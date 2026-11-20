'use strict'
// Dashboard „Übersicht“ (Schritt 4.5, Plan 7.7/8.4): EÜR-Zahlen je Jahr und Aufgaben & Fristen.
// Reine Rechenfunktionen ohne Dateizugriff. Ohne Gewähr – keine Steuerberatung.
//
// EÜR (Anlage EÜR 2025, amtlicher Vordruck vom 29.08.2025; Zeilen wechseln jährlich, darum Kennzahlen):
// - Kz 111 Betriebseinnahmen als umsatzsteuerlicher Kleinunternehmer
// - Kz 112 umsatzsteuerpflichtige Betriebseinnahmen (netto) und Kz 140 vereinnahmte Umsatzsteuer (Regelbesteuerung)
// - Kz 100 Waren, Rohstoffe und Hilfsstoffe (hier: Shirtigo-Produktion)
// - Kz 186 an das Finanzamt gezahlte Umsatzsteuer (hier: § 13b-Steuer im Jahr der Zahlung)
// - übrige Ausgaben aus eingelesenen Belegen je nach Art (z. B. Kz 224 Werbekosten) – Zuordnung bleibt beim Nutzer
// EÜR zählt nach Zu- und Abfluss (§ 11 EStG): Shopify nach Zahlungseingang, Shirtigo nach Zahlungsdatum, eingelesene Belege
// nach Rechnungsdatum (Näherung), § 13b-Steuer im Jahr der Anmeldung bzw. Fälligkeit.

const steuer = require('./steuer')

const rund = (n) => Math.round(n * 100) / 100

function euerJahre({ einnahmen = [], ausgaben = [], p13bMonate = [] } = {}) {
  const jahre = new Map()
  const jahr = (j) => {
    if (!jahre.has(j)) jahre.set(j, { jahr: j, kz111: 0, kz112: 0, kz140: 0, kz100: 0, sonstige: 0, gebuehren: 0, kz186: 0 })
    return jahre.get(j)
  }
  for (const x of steuer.posten(einnahmen)) {
    const j = jahr(x.datum.slice(0, 4))
    if (x.ust) { j.kz112 += x.umsatz; j.kz140 += x.ust } else j.kz111 += x.umsatz
  }
  for (const r of ausgaben) {
    if (!r || r.art === 'einnahme' || !r.datum) continue
    const j = jahr(r.datum.slice(0, 4))
    if (r.anbieter === 'shirtigo-api') j.kz100 += r.wirksam ?? 0
    else j.sonstige += r.wirksam ?? 0
    // davon Gebühren (4.8): Shopify-Payments-Gebühren ganz, bei Shopify-Rechnungen der Anteil der Transaktionsgebühren
    if (r.gebuehr) j.gebuehren += r.wirksam ?? 0
    else if (r.gebuehren) j.gebuehren += r.gebuehren
  }
  for (const m of p13bMonate) {
    if (!m.steuer) continue
    jahr((m.angemeldet || m.faellig).slice(0, 4)).kz186 += m.steuer
  }
  return [...jahre.values()].map((j) => {
    for (const k of ['kz111', 'kz112', 'kz140', 'kz100', 'sonstige', 'gebuehren', 'kz186']) j[k] = rund(j[k])
    const einnahmenSumme = rund(j.kz111 + j.kz112 + j.kz140)
    const ausgabenSumme = rund(j.kz100 + j.sonstige + j.kz186)
    return { ...j, einnahmen: einnahmenSumme, ausgaben: ausgabenSumme, gewinn: rund(einnahmenSumme - ausgabenSumme) }
  }).sort((a, b) => b.jahr.localeCompare(a.jahr))
}

// Nächster Werktag ab einem Datum (Samstag/Sonntag → Montag, § 108 Abs. 3 AO; Feiertage nicht berücksichtigt)
function werktag(tag) {
  const d = new Date(`${tag}T00:00:00Z`)
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
const tagePlus = (tag, n) => { const d = new Date(`${tag}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const tagText = (t) => t.split('-').reverse().join('.')
const monatText = (m) => `${m.slice(5, 7)}.${m.slice(0, 4)}`
const STUFEN = ['rot', 'gelb', 'info']

// Aufgaben & Fristen. Jede Aufgabe: { schluessel, stufe: rot|gelb|info, titel, text, frist, ziel, erledigbar }.
// ziel: Tab oder Feld, das die Aufgabe löst (angaben, steuer, usb, archiv). erledigt: { schluessel: 'JJJJ-MM-TT' }.
// Jährlicher Regel-Check (Plan 8.5): Punkte, die jedes Jahr gegen den aktuellen Gesetzesstand geprüft werden
const REGELCHECK = ['§ 19 UStG: Kleinunternehmergrenzen (25.000 € Vorjahr, 100.000 € laufendes Jahr) und Rechnungshinweis', 'Aufbewahrungsfristen (§ 147 AO, § 14b UStG)', 'E-Rechnung: Empfangspflicht, Formate, Fristen', '§ 13b UStG: Voranmeldung, Umsatzsteuer-Jahreserklärung, Einstufung der Anbieter', 'EU-Fernverkauf (10.000 €) und OSS', 'Datenschutz: Verzeichnis der Verarbeitungstätigkeiten aktuell']
const tageZwischen = (von, bis) => Math.floor((Date.parse(`${bis}T00:00:00Z`) - Date.parse(String(von).slice(0, 10) + 'T00:00:00Z')) / 86_400_000)

function aufgaben({ heute, pflichtFehlen = [], belegeWartend = 0, archiv = null, p13bMonate = [], waechter = null, statusPasst = true, erledigt = {}, verfahren = null } = {}) {
  const liste = []
  const neu = (a) => liste.push({ frist: null, erledigbar: false, ...a })
  const jahr = Number(heute.slice(0, 4))

  if (pflichtFehlen.length) {
    neu({ schluessel: 'angaben', stufe: belegeWartend ? 'rot' : 'gelb', titel: 'Pflichtangaben fehlen', ziel: 'angaben',
      text: belegeWartend ? `${belegeWartend} Umsatzbeleg(e) warten darauf. Ohne Pflichtangaben erzeugt Vendo keine neuen Umsatzbelege.` : 'Ohne Pflichtangaben erzeugt Vendo keine neuen Umsatzbelege.' })
  }
  if (archiv) {
    if (archiv.pruefung?.ok === false) neu({ schluessel: 'archivpruefung', stufe: 'rot', titel: 'Archivprüfung meldet Fehler', text: 'Details im Archiv-Status.', ziel: 'archiv' })
    const u = archiv.usb || {}
    if (!u.letzteSicherung) neu({ schluessel: 'usb', stufe: 'gelb', titel: 'Noch keine USB-Sicherung', text: 'Das Belegarchiv liegt nur auf diesem PC.', ziel: 'usb' })
    else if (u.tageSeit >= 7) neu({ schluessel: 'usb', stufe: u.tageSeit >= 30 ? 'rot' : 'gelb', titel: 'USB-Sicherung fällig', text: `Letzte Sicherung vor ${u.tageSeit} Tagen (empfohlen: wöchentlich).`, ziel: 'usb' })
    // Siegel (8.5): neue Einträge ohne Zeitstempel, wenn das letzte Siegel mindestens eine Woche alt ist
    const sg = archiv.pruefung?.siegel
    if (sg && sg.nochNichtVersiegelt > 0 && (!sg.zuletzt || tageZwischen(sg.zuletzt, heute) >= 7)) {
      neu({ schluessel: 'siegel', stufe: 'gelb', titel: 'Archiv versiegeln', ziel: 'archiv',
        text: `${sg.nochNichtVersiegelt} Einträge ${sg.zuletzt ? `seit dem letzten Siegel (${tagText(String(sg.zuletzt).slice(0, 10))})` : ''} noch ohne Zeitstempel. Wartung → „Archiv versiegeln“.`.replace('  ', ' ') })
    }
    if (archiv.wiederherstellungstest?.faellig) neu({ schluessel: 'wiederherstellungstest', stufe: 'gelb', titel: 'Wiederherstellungstest fällig', text: archiv.wiederherstellungstest.zeit ? 'Der letzte Test ist über ein Jahr her oder war nicht erfolgreich.' : 'Noch nie getestet, ob sich die USB-Sicherung wiederherstellen lässt.', ziel: 'archiv' })
  }
  for (const m of p13bMonate) {
    if (!m.pflicht || m.angemeldet) continue
    neu({ schluessel: `p13b-${m.monat}`, stufe: m.ueberfaellig ? 'rot' : 'gelb', titel: `§ 13b-Voranmeldung ${monatText(m.monat)}`, frist: m.faellig, ziel: 'steuer',
      text: `${m.ueberfaellig ? 'Überfällig seit' : 'Abgeben und zahlen bis'} ${tagText(m.faellig)}${m.steuer ? ` – ${m.steuer.toLocaleString('de-DE', { minimumFractionDigits: 2 })} € Steuer` : ''}${m.offenWaehrung ? ' (Euro-Betrag fehlt noch)' : ''}.` })
  }
  if (waechter && !statusPasst) neu({ schluessel: 'steuerstatus', stufe: 'rot', titel: 'Steuerstatus prüfen', text: 'Laut Umsatz gilt die Kleinunternehmerregelung nicht mehr, in „Meine Angaben“ steht noch Kleinunternehmer.', ziel: 'steuer' })
  else if (waechter && ['orange', 'rot'].includes(waechter.stufe)) neu({ schluessel: 'grenzwerte', stufe: 'gelb', titel: 'Umsatzgrenzen beachten', text: waechter.meldungen[0]?.text || 'Siehe Kleinunternehmer-Ampel.', ziel: 'steuer' })

  // Verfahrensdokumentation (8.5): bestätigen, solange sie unbestätigt oder seit der Bestätigung geändert ist
  if (verfahren && !verfahren.gueltig) {
    neu({ schluessel: 'verfahren', stufe: verfahren.bestaetigt ? 'gelb' : 'info', titel: 'Verfahrensdokumentation bestätigen', ziel: 'verfahren',
      text: `${verfahren.bestaetigt ? 'Seit der letzten Bestätigung geändert. ' : ''}${verfahren.fehlend ? `${verfahren.fehlend} Angabe(n) fehlen noch. ` : ''}Durchsehen und „Durchgesehen – bestätigen“.` })
  }
  // Jährlicher Regel-Check (8.5): im Januar fällig; Abhaken legt ein Protokoll im Archiv ab
  const regel = `regelcheck-${jahr}`
  if (!erledigt[regel]) {
    const frist = `${jahr}-01-31`
    neu({ schluessel: regel, stufe: heute > frist ? 'gelb' : 'info', titel: `Jährlicher Regel-Check ${jahr}`, frist, ziel: null, erledigbar: true,
      text: `Gesetzesstand prüfen: ${REGELCHECK.join('; ')}. Abhaken legt ein Protokoll im Archiv ab.` })
  }

  // Steuererklärung mit EÜR für das Vorjahr: Abgabe ohne Berater bis 31.07. (§ 149 Abs. 2 AO), Wochenende → Montag
  const vorjahr = jahr - 1
  const euer = `euer-${vorjahr}`
  if (!erledigt[euer]) {
    const frist = werktag(`${jahr}-07-31`)
    neu({ schluessel: euer, stufe: heute > frist ? 'rot' : heute >= tagePlus(frist, -60) ? 'gelb' : 'info', titel: `Steuererklärung ${vorjahr} mit Anlage EÜR`, frist, ziel: 'uebersicht', erledigbar: true,
      text: heute > frist ? `Frist ${tagText(frist)} abgelaufen – falls noch nicht abgegeben, bitte beim Finanzamt melden.` : `Abgabe ohne Steuerberater bis ${tagText(frist)}. Zahlen siehe EÜR-Tabelle.` })
  }
  const konto = `konto-${vorjahr}`
  if (!erledigt[konto]) neu({ schluessel: konto, stufe: 'info', titel: `Kontoauszüge ${vorjahr} sichern`, text: 'Jahresauszüge bei der Bank herunterladen und aufbewahren (Vendo verarbeitet keine Kontoauszüge).', ziel: null, erledigbar: true })

  return liste.sort((a, b) => STUFEN.indexOf(a.stufe) - STUFEN.indexOf(b.stufe) || String(a.frist || '9999').localeCompare(String(b.frist || '9999')))
}

module.exports = { REGELCHECK, euerJahre, aufgaben, werktag }
