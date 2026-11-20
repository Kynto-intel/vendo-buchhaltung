import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

// Tests für das Dashboard „Übersicht“ (plugins/buchhaltung/uebersicht.js), Schritt 4.5: EÜR je Jahr und Aufgaben & Fristen.
// Nur synthetische Werte im Testcode, keine echten Daten.

const require = createRequire(import.meta.url)
const { euerJahre, aufgaben, werktag } = require('../uebersicht.js')

const shop = (nr, datum, betrag, { mwst = 0, regel = false, erst = [] } = {}) => ({
  anbieter: 'shopify-api', art: 'einnahme', referenz: String(nr), datum, wirksam: betrag - mwst, regelbesteuerung: regel ? 19 : undefined,
  summen: { brutto: betrag, mwst, netto: betrag - mwst }, empfaenger: { land: 'DE' },
  zahlung: { bekannt: true, datum, eingaenge: [{ datum, betrag: betrag + erst.reduce((s, [, b]) => s + b, 0) }], erstattungen: erst.map(([d, b]) => ({ datum: d, betrag: b })) }
})

test('EÜR je Jahr: Kz 111 Kleinunternehmer, Kz 112/140 in der Regelbesteuerung, Kz 100 Shirtigo, übrige Belege, Kz 186 § 13b im Zahlungsjahr (Schritt 4.5)', () => {
  const jahre = euerJahre({
    einnahmen: [
      shop(1, '2024-03-01', 100),
      shop(2, '2024-05-02', 23.8, { mwst: 3.8, regel: true }),
      shop(3, '2025-12-30', 50, { erst: [['2026-01-05', 10]] }) // 60 bezahlt 2025, 10 erstattet 2026
    ],
    ausgaben: [
      { anbieter: 'shirtigo-api', art: 'ausgabe', datum: '2024-03-05', wirksam: 11.9 },
      { anbieter: 'allgemein', art: 'ausgabe', datum: '2025-02-01', wirksam: 30 },
      { anbieter: 'shopify-api', art: 'einnahme', datum: '2025-02-01', wirksam: 999 }, // Einnahme: nicht als Ausgabe
      { anbieter: 'allgemein', art: 'ausgabe', datum: null, wirksam: 5 } // ohne Datum: nicht zuzuordnen
    ],
    p13bMonate: [
      { monat: '2025-12', steuer: 19, faellig: '2026-01-12', angemeldet: null }, // Zahlung im Folgejahr
      { monat: '2025-11', steuer: 5.7, faellig: '2025-12-10', angemeldet: '2025-12-08' },
      { monat: '2025-10', steuer: 0, faellig: '2025-11-10', angemeldet: null }
    ]
  })
  assert.deepEqual(jahre.map((j) => j.jahr), ['2026', '2025', '2024'])
  assert.deepEqual(jahre.find((j) => j.jahr === '2024'), { jahr: '2024', kz111: 100, kz112: 20, kz140: 3.8, kz100: 11.9, sonstige: 0, gebuehren: 0, kz186: 0, einnahmen: 123.8, ausgaben: 11.9, gewinn: 111.9 })
  assert.deepEqual(jahre.find((j) => j.jahr === '2025'), { jahr: '2025', kz111: 60, kz112: 0, kz140: 0, kz100: 0, sonstige: 30, gebuehren: 0, kz186: 5.7, einnahmen: 60, ausgaben: 35.7, gewinn: 24.3 })
  assert.deepEqual(jahre.find((j) => j.jahr === '2026'), { jahr: '2026', kz111: -10, kz112: 0, kz140: 0, kz100: 0, sonstige: 0, gebuehren: 0, kz186: 19, einnahmen: -10, ausgaben: 19, gewinn: -29 })
})

test('Aufgaben: Stufen, Reihenfolge, Ziele, § 13b-Monate, Archiv, Steuerstatus, EÜR-Frist mit Wochenende, erledigte Jahresaufgaben (Schritt 4.5)', () => {
  assert.deepEqual(['2027-07-31', '2026-07-31', '2028-07-31'].map(werktag), ['2027-08-02', '2026-07-31', '2028-07-31'], '31.07.2027 ist ein Samstag')
  const archiv = (extra = {}) => ({ pruefung: { ok: true }, usb: { letzteSicherung: '2026-10-20T10:00:00Z', tageSeit: 9 }, wiederherstellungstest: { faellig: false }, ...extra })
  const liste = aufgaben({
    heute: '2026-10-29', pflichtFehlen: ['firmenname'], belegeWartend: 2, archiv: archiv(),
    p13bMonate: [
      { monat: '2026-09', pflicht: true, angemeldet: null, ueberfaellig: true, faellig: '2026-10-12', steuer: 19, offenWaehrung: 0 },
      { monat: '2026-10', pflicht: true, angemeldet: null, ueberfaellig: false, faellig: '2026-11-10', steuer: 2.5, offenWaehrung: 1 },
      { monat: '2026-08', pflicht: true, angemeldet: '2026-09-08', ueberfaellig: false, faellig: '2026-09-10', steuer: 5 },
      { monat: '2026-07', pflicht: false, angemeldet: null, ueberfaellig: false, faellig: '2026-08-10', steuer: 0 }
    ],
    waechter: { stufe: 'gruen', meldungen: [] }, statusPasst: true
  })
  assert.deepEqual(liste.map((a) => [a.schluessel, a.stufe, a.ziel]), [
    ['euer-2025', 'rot', 'uebersicht'], ['p13b-2026-09', 'rot', 'steuer'], ['angaben', 'rot', 'angaben'],
    ['regelcheck-2026', 'gelb', null], ['p13b-2026-10', 'gelb', 'steuer'], ['usb', 'gelb', 'usb'], ['konto-2025', 'info', null]
  ], 'rot vor gelb vor info, innerhalb nach Frist (frühere zuerst, ohne Frist zuletzt); angemeldete und Monate ohne Pflicht fehlen')
  assert.equal(liste[1].text, 'Überfällig seit 12.10.2026 – 19,00 € Steuer.')
  assert.equal(liste.find((a) => a.schluessel === 'p13b-2026-10').text, 'Abgeben und zahlen bis 10.11.2026 – 2,50 € Steuer (Euro-Betrag fehlt noch).')
  assert.equal(liste.find((a) => a.schluessel === 'angaben').text, '2 Umsatzbeleg(e) warten darauf. Ohne Pflichtangaben erzeugt Vendo keine neuen Umsatzbelege.')
  assert.match(liste.find((a) => a.schluessel === 'euer-2025').text, /^Frist 31\.07\.2026 abgelaufen/)

  const ruhig = aufgaben({ heute: '2026-03-01', archiv: archiv({ usb: { letzteSicherung: '2026-02-27T10:00:00Z', tageSeit: 2 } }), erledigt: { 'konto-2025': '2026-01-10', 'regelcheck-2026': '2026-01-12' } })
  assert.deepEqual(ruhig.map((a) => [a.schluessel, a.stufe, a.frist]), [['euer-2025', 'info', '2026-07-31']], 'nur noch die EÜR-Frist (mehr als 60 Tage hin)')
  assert.equal(aufgaben({ heute: '2026-06-01', erledigt: { 'konto-2025': 'x' } })[0].stufe, 'gelb', 'ab 60 Tagen vor der Frist gelb')
  assert.deepEqual(aufgaben({ heute: '2026-06-01', erledigt: { 'euer-2025': '2026-05-01', 'konto-2025': '2026-01-10', 'regelcheck-2026': '2026-01-12' } }), [], 'alle Jahresaufgaben erledigt')
  assert.equal(aufgaben({ heute: '2027-08-01', erledigt: { 'konto-2026': 'x' } })[0].stufe, 'gelb', '31.07.2027 ist Samstag → Frist Montag 02.08.2027, am 01.08. noch nicht abgelaufen')

  const a2 = aufgaben({ heute: '2026-03-01', archiv: { pruefung: { ok: false }, usb: { letzteSicherung: null }, wiederherstellungstest: { faellig: true } }, erledigt: { 'euer-2025': 'x', 'konto-2025': 'x' } })
  assert.deepEqual(a2.map((a) => [a.schluessel, a.stufe, a.titel]), [['archivpruefung', 'rot', 'Archivprüfung meldet Fehler'], ['regelcheck-2026', 'gelb', 'Jährlicher Regel-Check 2026'], ['usb', 'gelb', 'Noch keine USB-Sicherung'], ['wiederherstellungstest', 'gelb', 'Wiederherstellungstest fällig']])
  assert.equal(aufgaben({ heute: '2026-03-01', archiv: archiv({ usb: { letzteSicherung: 'x', tageSeit: 30 } }), erledigt: { 'euer-2025': 'x', 'konto-2025': 'x' } })[0].stufe, 'rot', 'USB nach 30 Tagen rot')

  const st = aufgaben({ heute: '2026-03-01', waechter: { stufe: 'rot', meldungen: [{ text: 'Grenze überschritten' }] }, statusPasst: false, erledigt: { 'euer-2025': 'x', 'konto-2025': 'x', 'regelcheck-2026': 'x' } })
  assert.deepEqual(st.map((a) => [a.schluessel, a.stufe]), [['steuerstatus', 'rot']])
  const gw = aufgaben({ heute: '2026-03-01', waechter: { stufe: 'orange', meldungen: [{ text: 'Ab 01.01.2027 Regelbesteuerung' }] }, statusPasst: true, erledigt: { 'euer-2025': 'x', 'konto-2025': 'x', 'regelcheck-2026': 'x' } })
  assert.deepEqual(gw.map((a) => [a.schluessel, a.stufe, a.text]), [['grenzwerte', 'gelb', 'Ab 01.01.2027 Regelbesteuerung']])
})

test('EÜR: Gebühren stecken in den übrigen Ausgaben und werden als „davon“ ausgewiesen (Schritt 4.8)', () => {
  const jahre = euerJahre({ ausgaben: [
    { art: 'ausgabe', gebuehr: true, anbieter: 'shopify-payments', datum: '2024-04-01', wirksam: 1.02 },
    { art: 'ausgabe', anbieter: 'shopify', datum: '2024-05-07', wirksam: 28.5, gebuehren: 1.5 },
    { art: 'ausgabe', anbieter: 'shirtigo-api', datum: '2024-05-08', wirksam: 10 }
  ] })
  const j = jahre.find((x) => x.jahr === '2024')
  assert.deepEqual([j.sonstige, j.gebuehren, j.kz100, j.ausgaben], [29.52, 2.52, 10, 39.52])
})

test('Erinnerungen (Schritt 8.5): Archiv versiegeln, Verfahrensdokumentation bestätigen, jährlicher Regel-Check', () => {
  const basis = { pruefung: { ok: true }, usb: { letzteSicherung: '2026-11-19T10:00:00Z', tageSeit: 1 }, wiederherstellungstest: { faellig: false } }
  const fertig = { 'euer-2025': 'x', 'konto-2025': 'x' }
  const mitSiegel = (siegel) => aufgaben({ heute: '2026-11-20', archiv: { ...basis, pruefung: { ok: true, siegel } }, erledigt: { ...fertig, 'regelcheck-2026': 'x' } })
  const s = mitSiegel({ nochNichtVersiegelt: 12, zuletzt: '2026-11-01T02:00:00Z' })
  assert.deepEqual(s.map((a) => [a.schluessel, a.stufe, a.ziel]), [['siegel', 'gelb', 'archiv']])
  assert.match(s[0].text, /^12 Einträge seit dem letzten Siegel \(01\.11\.2026\) noch ohne Zeitstempel/)
  assert.deepEqual(mitSiegel({ nochNichtVersiegelt: 12, zuletzt: '2026-11-18T02:00:00Z' }), [], 'Siegel jünger als eine Woche: keine Erinnerung')
  assert.deepEqual(mitSiegel({ nochNichtVersiegelt: 0, zuletzt: '2026-01-01T02:00:00Z' }), [], 'alles versiegelt')
  assert.match(mitSiegel({ nochNichtVersiegelt: 3, zuletzt: null })[0].text, /^3 Einträge noch ohne Zeitstempel/)

  const v = (verfahren) => aufgaben({ heute: '2026-11-20', erledigt: { ...fertig, 'regelcheck-2026': 'x' }, verfahren })
  assert.deepEqual(v({ bestaetigt: false, gueltig: false, fehlend: 8 }).map((a) => [a.schluessel, a.stufe, a.ziel, a.text]), [['verfahren', 'info', 'verfahren', '8 Angabe(n) fehlen noch. Durchsehen und „Durchgesehen – bestätigen“.']])
  assert.match(v({ bestaetigt: true, gueltig: false, fehlend: 0 })[0].text, /^Seit der letzten Bestätigung geändert/)
  assert.equal(v({ bestaetigt: true, gueltig: false, fehlend: 0 })[0].stufe, 'gelb')
  assert.deepEqual(v({ bestaetigt: true, gueltig: true, fehlend: 0 }), [])

  const januar = aufgaben({ heute: '2027-01-10', erledigt: { 'euer-2026': 'x', 'konto-2026': 'x' } })
  assert.deepEqual(januar.map((a) => [a.schluessel, a.stufe, a.frist, a.erledigbar]), [['regelcheck-2027', 'info', '2027-01-31', true]])
  assert.match(januar[0].text, /§ 19 UStG.*Aufbewahrungsfristen.*E-Rechnung.*§ 13b.*Datenschutz.*Protokoll im Archiv/)
  assert.equal(aufgaben({ heute: '2027-02-01', erledigt: { 'euer-2026': 'x', 'konto-2026': 'x' } })[0].stufe, 'gelb', 'nach Januar gelb')
})
