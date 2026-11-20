import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

// Tests für die Steuer-Übersicht (plugins/buchhaltung/steuer.js), Schritt 4.2: Umsatz je Jahr nach Zahlungseingang.
// Nur synthetische rechnung-Objekte im Testcode (Bestellnummern 1–20), keine echten Daten.

const require = createRequire(import.meta.url)
const { umsatzJahre, grenzwerte, p13bFall, p13bMonate, faelligAm } = require('../steuer.js')
const { parseRechnung } = require('../parser.js')

// Shopify-Bestellung wie aus bestellungen.zuRechnung: brutto = Zahlungseingang nach Erstattungen, mwst nur in der Regelbesteuerung
function shop(nr, datum, brutto, { eingaenge = [[datum, brutto]], erstattungen = [], mwst = 0, regel = false, bekannt = true, storniert = false, land = 'DE' } = {}) {
  return {
    anbieter: 'shopify-api', art: 'einnahme', referenz: String(nr), datum, storniert, empfaenger: { land },
    wirksam: brutto - mwst, regelbesteuerung: regel ? 19 : undefined, summen: { brutto, mwst, netto: brutto - mwst },
    zahlung: { bekannt, datum: bekannt ? eingaenge[0]?.[0] || null : null, eingaenge: eingaenge.map(([d, b]) => ({ datum: d, betrag: b })), erstattungen: erstattungen.map(([d, b]) => ({ datum: d, betrag: b })) }
  }
}
const nach = (jahre, j) => jahre.find((x) => x.jahr === j)

test('Umsatz je Jahr: Zahlung im Jahr des Eingangs, Erstattung im Jahr der Erstattung, Vergleich nach Bestelldatum (Schritt 4.2)', () => {
  const jahre = umsatzJahre([
    shop(1, '2025-03-01', 50),
    shop(2, '2025-12-31', 30, { eingaenge: [['2026-01-02', 30]] }), // bestellt 2025, bezahlt 2026
    shop(3, '2025-11-20', 40, { eingaenge: [['2025-11-20', 50]], erstattungen: [['2026-01-10', 10]] }), // Teilerstattung im Folgejahr
    shop(4, '2025-06-01', 0, { eingaenge: [['2025-06-01', 20]], erstattungen: [['2025-06-05', 20]] }), // komplett erstattet
    shop(5, '2025-07-01', 0, { eingaenge: [], storniert: true }), // storniert, nie bezahlt
    shop(6, '2025-08-01', 25, { eingaenge: [['2025-08-01', 10], ['2025-09-01', 15]] }), // zwei Teilzahlungen
    { anbieter: 'shirtigo-api', art: 'ausgabe', datum: '2025-03-02', wirksam: 99, summen: { brutto: 99 } } // Ausgabe zählt nicht
  ])
  assert.deepEqual(jahre.map((j) => j.jahr), ['2026', '2025'], 'neuestes Jahr zuerst')
  assert.deepEqual(nach(jahre, '2025'), { jahr: '2025', umsatz: 125, ust: 0, eingaenge: 145, erstattungen: 20, nachBestelldatum: 145, bestellungen: 4, geschaetzt: 0, sonstige: 0 })
  assert.deepEqual(nach(jahre, '2026'), { jahr: '2026', umsatz: 20, ust: 0, eingaenge: 30, erstattungen: 10, nachBestelldatum: 0, bestellungen: 2, geschaetzt: 0, sonstige: 0 })
  assert.equal(nach(jahre, '2025').umsatz + nach(jahre, '2026').umsatz, 145, 'Summe über die Jahre = Summe der Nettozahlungen der Bestellungen (50 + 30 + 40 + 0 + 0 + 25)')
})

test('Regelbesteuerung: nur der Nettoanteil zählt, USt getrennt – auch bei Teilerstattung (Schritt 4.2)', () => {
  const jahre = umsatzJahre([
    shop(10, '2024-05-02', 23.8, { mwst: 3.8, regel: true }),
    shop(11, '2024-05-03', 11.9, { mwst: 1.9, regel: true, eingaenge: [['2024-05-03', 23.8]], erstattungen: [['2024-05-20', 11.9]] }),
    shop(12, '2024-06-01', 20) // danach Kleinunternehmer: alles zählt
  ])
  assert.deepEqual(jahre, [{ jahr: '2024', umsatz: 50, ust: 5.7, eingaenge: 67.6, erstattungen: 11.9, nachBestelldatum: 50, bestellungen: 3, geschaetzt: 0, sonstige: 0 }])
})

test('Ohne Zahlungsdatum: Bestelldatum als Schätzung, eingelesene Einnahmen nach Rechnungsdatum (Schritt 4.2)', () => {
  const jahre = umsatzJahre([
    shop(20, '2023-12-30', 44.9, { bekannt: false, eingaenge: [] }),
    { anbieter: 'shop-rechnung', art: 'einnahme', referenz: 'X1', datum: '2023-05-05', wirksam: 100, summen: { brutto: 100 } },
    { anbieter: 'allgemein', art: 'einnahme', datum: null, wirksam: 5, summen: { brutto: 5 } } // ohne Datum: nicht zuzuordnen
  ])
  assert.deepEqual(jahre, [{ jahr: '2023', umsatz: 144.9, ust: 0, eingaenge: 0, erstattungen: 0, nachBestelldatum: 144.9, bestellungen: 1, geschaetzt: 1, sonstige: 1 }])
  assert.deepEqual(umsatzJahre([]), [])
})

// ---------- Grenzwert-Wächter (Schritt 4.3) ----------
const w = (rechnungen, jahr = '2026') => grenzwerte(rechnungen, { jahr })
const stufen = (x) => x.meldungen.map((m) => m.stufe)
const alt = shop(900, '2020-06-01', 1) // frühere Tätigkeit: 2026 ist kein Gründungsjahr

test('Grenze Vorjahr 25.000 €: genau 25.000,00 € ist noch in Ordnung, 25.000,01 € beendet § 19 im laufenden Jahr (Schritt 4.3)', () => {
  const genau = w([alt, shop(1, '2025-05-01', 25000)])
  assert.deepEqual([genau.vorjahr.umsatz, genau.stufe, genau.kleinunternehmer, genau.gruendungsjahr], [25000, 'gruen', true, false])
  const drueber = w([alt, shop(1, '2025-05-01', 25000.01)])
  assert.deepEqual([drueber.stufe, drueber.kleinunternehmer], ['rot', false])
  assert.ok(drueber.meldungen[0].text.startsWith('Der Umsatz 2025 lag mit 25.000,01 € über 25.000 €: Die Kleinunternehmerregelung gilt 2026 nicht'), drueber.meldungen[0].text)
})

test('Laufendes Jahr gegen 25.000 €: grün bis 19.999,99 €, gelb ab 20.000 € bis genau 25.000 €, orange darüber (Schritt 4.3)', () => {
  const fall = (betrag) => w([alt, shop(2, '2026-03-01', betrag)])
  assert.deepEqual([19999.99, 20000, 24999.99, 25000, 25000.01].map((b) => fall(b).stufe), ['gruen', 'gelb', 'gelb', 'gelb', 'orange'])
  assert.ok(fall(25000.01).meldungen[0].text.includes('Ab 01.01.2027 gilt die Regelbesteuerung'), fall(25000.01).meldungen[0].text)
  assert.equal(fall(25000.01).kleinunternehmer, true, 'dieses Jahr gilt § 19 noch')
  // Erstattung im selben Jahr mindert: 25.010 € bezahlt, 20 € erstattet → 24.990 €
  assert.equal(w([alt, shop(3, '2026-03-01', 24990, { eingaenge: [['2026-03-01', 25010]], erstattungen: [['2026-03-05', 20]] })]).stufe, 'gelb')
  // Regelbesteuerung zählt netto: 29.750 € brutto mit 4.750 € USt → 25.000 € netto
  assert.equal(w([alt, shop(4, '2026-04-01', 29750, { mwst: 4750, regel: true })]).laufend.umsatz, 25000)
})

test('Laufendes Jahr gegen 100.000 €: rot ab 90 %, genau 100.000 € noch steuerfrei, der überschreitende Umsatz mit Datum und Bestellung (Schritt 4.3)', () => {
  assert.deepEqual(stufen(w([alt, shop(5, '2026-01-10', 89999.99)])), ['orange'])
  assert.deepEqual(stufen(w([alt, shop(5, '2026-01-10', 90000)])), ['rot', 'orange'])
  const genau = w([alt, shop(6, '2026-01-10', 60000), shop(7, '2026-02-10', 40000)])
  assert.deepEqual([genau.laufend.ueberschritten, genau.kleinunternehmer], [null, true])
  const drueber = w([alt, shop(6, '2026-01-10', 60000), shop(7, '2026-02-10', 40000), shop(8, '2026-03-03', 0.01)])
  assert.deepEqual([drueber.stufe, drueber.kleinunternehmer, drueber.laufend.ueberschritten], ['rot', false, { datum: '2026-03-03', referenz: '8', summe: 100000.01 }])
  assert.ok(drueber.meldungen[0].text.startsWith('Grenze von 100.000,00 € am 03.03.2026 überschritten (Zahlung zu Bestellung #8): Bereits dieser Umsatz'), drueber.meldungen[0].text)
  // Reihenfolge nach Zahlungseingang, nicht nach Bestellung: bestellt früher, bezahlt später
  const spaet = w([alt, shop(9, '2026-01-01', 50000, { eingaenge: [['2026-06-01', 50000]] }), shop(10, '2026-02-01', 50000.01)])
  assert.deepEqual(spaet.laufend.ueberschritten, { datum: '2026-06-01', referenz: '9', summe: 100000.01 })
})

test('Gründungsjahr (keine früheren Umsätze): 25.000 € gilt schon im laufenden Jahr (BMF 18.03.2025, Abschnitt 19.1 Abs. 3) (Schritt 4.3)', () => {
  const gelb = w([shop(11, '2026-02-01', 20000)])
  assert.deepEqual([gelb.gruendungsjahr, gelb.laufend.grenze, gelb.stufe], [true, 25000, 'gelb'])
  const rot = w([shop(11, '2026-02-01', 20000), shop(12, '2026-05-05', 5000.01)])
  assert.deepEqual([rot.stufe, rot.kleinunternehmer, rot.laufend.ueberschritten.referenz], ['rot', false, '12'])
  assert.ok(rot.meldungen[0].text.startsWith('Im Jahr der Gründung gilt 25.000 €. Grenze von 25.000,00 € am 05.05.2026 überschritten'), rot.meldungen[0].text)
  assert.equal(w([alt, shop(11, '2026-02-01', 25000.01)]).kleinunternehmer, true, 'mit früheren Umsätzen gilt im laufenden Jahr 100.000 €')
})

test('EU-Fernverkauf 10.000 €: nur andere EU-Länder, netto nach Bestelldatum, Vorjahr und laufendes Jahr, Stornos zählen nicht (Schritt 4.3)', () => {
  const gelb = w([alt, shop(20, '2026-01-05', 8000, { land: 'AT' }), shop(21, '2026-01-06', 50000, { land: 'DE' }), shop(22, '2026-01-07', 5000, { land: 'CH' }), shop(23, '2026-01-08', 3000, { land: 'FR', storniert: true })])
  assert.deepEqual([gelb.eu.umsatz, gelb.eu.laender, stufen(gelb)], [8000, ['AT'], ['orange', 'gelb']])
  const rot = w([alt, shop(20, '2026-01-05', 8000, { land: 'AT' }), shop(24, '2026-02-01', 2000.01, { land: 'nl' })])
  assert.deepEqual([rot.eu.ueberschritten, rot.kleinunternehmer], [{ datum: '2026-02-01', referenz: '24', summe: 10000.01 }, true], '§ 19 gilt weiter, aber Lieferort im Bestimmungsland')
  assert.ok(rot.meldungen.at(-1).text.startsWith('EU-Fernverkäufe 2026 am 01.02.2026 über 10.000 € (Bestellung #24)'), rot.meldungen.at(-1).text)
  const vorjahr = w([alt, shop(25, '2025-12-30', 10000.01, { land: 'IT', eingaenge: [['2026-01-02', 10000.01]] })])
  assert.match(vorjahr.meldungen.find((m) => m.text.startsWith('EU-Fernverkäufe 2025')).text, /2026 im Bestimmungsland steuerpflichtig/, 'Lieferung zählt im Lieferjahr, nicht im Zahlungsjahr')
  assert.equal(w([alt, shop(26, '2026-01-05', 10000, { land: 'AT' })]).eu.ueberschritten, null, 'genau 10.000 € ist noch in Ordnung')
})

// ---------- § 13b (Schritt 4.4) ----------
const ausgabe = (lieferant, datum, netto, extra = {}) => ({ art: 'ausgabe', lieferant, datum, waehrung: 'EUR', summen: { netto, mwst: 0, brutto: netto }, wirksam: netto, ...extra })

test('§ 13b-Fall: erkannt oder manuell, 19 % vom Netto, Monat, Kennzahlen EU/Drittland, Zahlungsdienst vermutlich steuerfrei (Schritt 4.4)', () => {
  const meta = ausgabe('Meta Platforms Ireland Limited', '2026-09-30', 123.45, { reverseCharge: true, herkunft: 'eu' })
  assert.deepEqual(p13bFall(meta), { monat: '2026-09', herkunft: 'eu', satz: 19, bemessung: 123.45, steuer: 23.46, steuerfrei: false, vermutetFrei: false, waehrungFehlt: false, kz: ['46', '47'], quelle: 'erkannt' })
  assert.equal(p13bFall(meta, { aktiv: false }), null, 'manuell abgewählt')
  assert.equal(p13bFall(ausgabe('Druckerei GmbH', '2026-09-01', 50)), null, 'ohne Hinweis kein § 13b')
  assert.equal(p13bFall({ ...meta, art: 'einnahme' }), null, 'Einnahmen nie')
  const us = p13bFall(ausgabe('Acme Inc.', '2026-08-20', 50), { aktiv: true, monat: '2026-09' }, { herkunft: 'drittland' })
  assert.deepEqual([us.monat, us.kz, us.steuer, us.quelle], ['2026-09', ['84', '85'], 9.5, 'manuell'])
  const viva = p13bFall(ausgabe('Viva Wallet', '2026-09-15', 12), { aktiv: true })
  assert.deepEqual([viva.steuerfrei, viva.vermutetFrei, viva.steuer], [true, true, 0])
  assert.deepEqual([p13bFall(ausgabe('Viva Wallet', '2026-09-15', 12), { aktiv: true }, { einstufung: 'steuerpflichtig' }).steuer], [2.28], 'Einstufung schlägt Vermutung')
  assert.equal(p13bFall(meta, {}, { einstufung: 'steuerfrei' }).steuer, 0)
  const usd = p13bFall(ausgabe('Acme Inc.', '2026-08-20', 50, { waehrung: 'USD' }), { aktiv: true })
  assert.deepEqual([usd.bemessung, usd.steuer, usd.waehrungFehlt], [null, 0, true], 'Fremdwährung ohne Euro-Betrag')
  assert.deepEqual([p13bFall(ausgabe('Acme Inc.', '2026-08-20', 50, { waehrung: 'USD' }), { aktiv: true, betragEur: 46.1 }).steuer], [8.76])
  assert.equal(p13bFall(meta, { monat: '2026-13' }).monat, '2026-09', 'ungültiger Monat → Rechnungsmonat')
})

test('§ 13b-Monate: Summen je Kennzahl, steuerfreie und Fremdwährung getrennt, Fälligkeit mit Wochenende, überfällig, angemeldet (Schritt 4.4)', () => {
  assert.deepEqual(['2026-01', '2026-09', '2026-04', '2025-12'].map(faelligAm), ['2026-02-10', '2026-10-12', '2026-05-11', '2026-01-12'], '10.10.2026 ist ein Samstag → Montag 12.10.; 10.01.2026 Samstag → 12.01.')
  const f = (lieferant, datum, netto, eintrag = { aktiv: true }, anbieter = {}, extra = {}) => ({ fall: p13bFall(ausgabe(lieferant, datum, netto, extra), eintrag, anbieter) })
  const monate = p13bMonate([
    f('Meta Platforms Ireland Limited', '2026-09-30', 100), f('Google Ireland Ltd.', '2026-09-03', 50.5),
    f('Acme Inc.', '2026-09-10', 20, { aktiv: true }, { herkunft: 'drittland' }), f('Viva Wallet', '2026-09-15', 12),
    f('Acme Inc.', '2026-08-20', 50, { aktiv: true }, {}, { waehrung: 'USD' }), f('Viva Wallet', '2026-07-15', 9)
  ], { '2026-08': { am: '2026-09-08' } }, { heute: '2026-10-13' })
  assert.deepEqual(monate.map((x) => [x.monat, x.rechnungen, x.steuerfrei, x.eu, x.drittland, x.steuer, x.faellig, x.angemeldet, x.pflicht, x.ueberfaellig, x.offenWaehrung]), [
    ['2026-09', 4, 1, { bemessung: 150.5, steuer: 28.6 }, { bemessung: 20, steuer: 3.8 }, 32.4, '2026-10-12', null, true, true, 0],
    ['2026-08', 1, 0, { bemessung: 0, steuer: 0 }, { bemessung: 0, steuer: 0 }, 0, '2026-09-10', '2026-09-08', true, false, 1],
    ['2026-07', 1, 1, { bemessung: 0, steuer: 0 }, { bemessung: 0, steuer: 0 }, 0, '2026-08-10', null, false, false, 0]
  ])
  assert.equal(p13bMonate([f('Meta Platforms Ireland Limited', '2026-09-30', 100)], {}, { heute: '2026-10-12' })[0].ueberfaellig, false, 'am Fälligkeitstag noch nicht überfällig')
})

test('§ 13b-Erkennung im Parser: Reverse-Charge-Begriffe, ausländische USt-IdNr. → EU, deutsche IdNr. zählt nicht (Schritt 4.4)', () => {
  const text = (zeilen) => ['Beispiel Werbung Ltd.', 'Rechnungsnummer: RC-1', '05.09.2026', 'Werbung 1 100,00 € 100,00 €', 'Netto: 100,00 €', 'Rechnungsbetrag: 100,00 €', ...zeilen].join(String.fromCharCode(10))
  const a = parseRechnung(text(['VAT reverse charge – Art. 196 Council Directive 2006/112/EC', 'VAT ID: IE 9692928F']))
  assert.deepEqual([a.art, a.reverseCharge, a.lieferantUstId, a.herkunft], ['ausgabe', true, 'IE9692928F', 'eu'])
  const b = parseRechnung(text(['Steuerschuldnerschaft des Leistungsempfängers', 'USt-IdNr. Kunde: DE123456789']))
  assert.deepEqual([b.reverseCharge, b.lieferantUstId, b.herkunft], [true, undefined, undefined], 'Hinweis erkannt, Sitz offen (deutsche IdNr. ist die eigene)')
  const c = parseRechnung(text(['Lieferant: NL123456789B01']))
  assert.deepEqual([c.reverseCharge, c.lieferantUstId], [undefined, 'NL123456789B01'], 'IdNr. allein ist noch kein § 13b')
  const d = parseRechnung(text(['Autoliquidation']))
  assert.equal(d.reverseCharge, true)
})

// ---------- Plan-Abschnitt 5 (20.11.2026): Voranmeldungszeitraum, Dauerfristverlängerung, Jahreserklärung, Gebühren ----------
const st = require('../steuer.js')

test('Voranmeldungszeitraum: Quartal ab Jahr, Fälligkeit nach Quartalsende, Dauerfristverlängerung (§ 18 Abs. 2 UStG, § 46 UStDV)', () => {
  assert.deepEqual(['2026-Q1', '2026-Q3', '2026-Q4'].map((p) => faelligAm(p)), ['2026-04-10', '2026-10-12', '2027-01-11'])
  assert.equal(faelligAm('2026-09', { dauerfrist: true }), '2026-11-10', 'Monat + Dauerfrist: einen Monat später')
  assert.equal(faelligAm('2026-Q4', { dauerfrist: true }), '2027-02-10')
  assert.deepEqual(['2025-11', '2026-02', '2026-12'].map((m) => st.periodeVon(m, 2026)), ['2025-11', '2026-Q1', '2026-Q4'], 'vor dem Umstellungsjahr bleibt der Monat')
  const fall = (datum, netto) => ({ fall: p13bFall(ausgabe('Meta Platforms Ireland Limited', datum, netto), { aktiv: true }) })
  const z = p13bMonate([fall('2025-12-05', 10), fall('2026-01-10', 100), fall('2026-03-02', 50)], { '2025-12': { am: '2026-01-09' } }, { heute: '2026-04-20', quartalAb: 2026 })
  assert.deepEqual(z.map((x) => [x.monat, x.art, x.steuer, x.faellig, x.ueberfaellig, x.angemeldet]), [['2026-Q1', 'quartal', 28.5, '2026-04-10', true, null], ['2025-12', 'monat', 1.9, '2026-01-12', false, '2026-01-09']])
})

test('Vorschlag zum Voranmeldungszeitraum: Gründungsjahr und Folgejahr monatlich, über 9.000 € monatlich, sonst Quartal', () => {
  assert.equal(st.zeitraumVorschlag({ jahr: 2024, gruendungsjahr: 2023 }).zeitraum, 'monat')
  assert.equal(st.zeitraumVorschlag({ jahr: 2025, gruendungsjahr: 2023 }).zeitraum, 'quartal')
  assert.equal(st.zeitraumVorschlag({ jahr: 2026, vorjahrSteuer: 9000.01 }).zeitraum, 'monat')
  const q = st.zeitraumVorschlag({ jahr: 2026, vorjahrSteuer: 150 })
  assert.deepEqual([q.zeitraum, q.befreiungMoeglich], ['quartal', true])
  assert.match(q.grund, /§ 18 Abs\. 2 Satz 1 UStG/)
  assert.equal(st.zeitraumVorschlag({ jahr: 2026, vorjahrSteuer: 2500 }).befreiungMoeglich, false)
})

test('Umsatzsteuer-Jahreserklärung: Pflicht bei § 13b-Steuer oder Regelbesteuerung im Jahr (§ 18 Abs. 4a UStG)', () => {
  const fall = (lieferant, datum, netto, anbieter = {}) => ({ fall: p13bFall(ausgabe(lieferant, datum, netto), { aktiv: true }, anbieter) })
  const monate = p13bMonate([fall('Meta Platforms Ireland Limited', '2025-03-01', 100), fall('Acme Inc.', '2025-04-01', 10, { herkunft: 'drittland' }), fall('Viva Wallet', '2026-02-01', 5)], {}, { heute: '2026-05-01' })
  const j = st.ustJahre(monate, [2024])
  assert.deepEqual(j.map((x) => [x.jahr, x.pflicht, x.steuer, x.eu.bemessung, x.drittland.steuer, x.regel]), [['2026', false, 0, 0, 0, false], ['2025', true, 20.9, 100, 1.9, false], ['2024', true, 0, 0, 0, true]])
})

test('Gebühren: ausdrücklicher Reverse-Charge-Hinweis hebt die Vermutung „steuerfrei“ für Zahlungsdienste auf', () => {
  const mitHinweis = p13bFall(ausgabe('Viva Wallet', '2026-09-15', 12, { reverseCharge: true }), {})
  assert.deepEqual([mitHinweis.vermutetFrei, mitHinweis.steuerfrei, mitHinweis.steuer], [false, false, 2.28])
  const ohne = p13bFall(ausgabe('Viva Wallet', '2026-09-15', 12), { aktiv: true })
  assert.deepEqual([ohne.vermutetFrei, ohne.steuer], [true, 0])
})
