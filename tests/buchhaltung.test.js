import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import {
  bestellungenFiltern,
  bestellungenListe,
  bestellungenSortieren,
  duplikate,
  filtern,
  jahreListe,
  kennzahlen,
  kennzahlenBestellungen,
  sortieren,
  verknuepfungen
} from '../ansicht.js'

const require = createRequire(import.meta.url)
const { parseRechnung, auswerten } = require('../parser.js')

const syntheticInvoiceText = `
  Beispiel Anbieter GmbH
  Rechnungsnummer: TEST-9001
  03.10.2026
  Versand 2 5,00 € 10,00 €
  Service 1 20,00 € 20,00 €
  Netto: 30,00 €
  USt. 5,70 €
  Rechnungsbetrag: 35,70 €
  USD
  Paid
`

function createReceipt(id, invoice, timestamp = 1) {
  return { id, name: `${id}.pdf`, zeit: timestamp, rechnung: invoice }
}

test('Manifest and parser handle synthetic invoice data and uncertain fallbacks', async () => {
  const manifest = JSON.parse(await readFile(new URL('../plugin.json', import.meta.url), 'utf8'))
  assert.equal(manifest.id, 'buchhaltung')

  const parsed = parseRechnung(syntheticInvoiceText)
  assert.equal(parsed.anbieter, 'allgemein')
  assert.equal(parsed.lieferant, 'Beispiel Anbieter GmbH')
  assert.equal(parsed.rechnungsnummer, 'TEST-9001')
  assert.equal(parsed.datum, '2026-10-03')
  assert.equal(parsed.waehrung, 'USD')
  assert.deepEqual(parsed.positionen.map((p) => p.typ), ['versand', 'artikel'])
  assert.equal(parsed.summen.brutto, 35.7)
  assert.equal(parsed.pruefung.ok, false)
  assert.equal(parseRechnung('Kein Rechnungsinhalt').unsicher, true)

  const totals = auswerten([parsed, { art: 'einnahme', datum: '2026-10-10', wirksam: 50, summen: { mwst: 0 } }])
  assert.equal(totals.gesamt.einnahmen, 50)
  assert.equal(totals.gesamt.ausgaben, parsed.wirksam)
})

test('Invoice view filters and sorts receipts, detects duplicates, and calculates metrics', () => {
  const first = createReceipt('a', {
    lieferant: 'Beispielanbieter', rechnungsnummer: 'TEST-1', art: 'ausgabe', datum: '2026-10-01', wirksam: 40, versand: 5,
    summen: { netto: 40, brutto: 47.6, mwst: 7.6 }, positionen: [{ typ: 'artikel', bezeichnung: 'Testprodukt', einzelpreis: 40 }]
  })
  const duplicate = createReceipt('b', { ...first.rechnung }, 2)
  const income = createReceipt('c', {
    lieferant: 'Testshop', rechnungsnummer: 'TEST-2', art: 'einnahme', datum: '2026-11-02', wirksam: 100,
    summen: { netto: 100, brutto: 100, mwst: 0 }, positionen: [{ typ: 'artikel', bezeichnung: 'Testprodukt', einzelpreis: 100 }]
  }, 3)
  const documents = [first, duplicate, income]
  const duplicates = duplikate(documents)

  assert.deepEqual([...duplicates], ['b'])
  assert.deepEqual(filtern(documents, { lieferant: 'Beispielanbieter', art: 'ausgabe', jahr: '2026', monat: '10', suche: 'testprodukt' }, duplicates), [first])
  assert.deepEqual(sortieren([first, income], 'betrag'), [income, first])
  assert.deepEqual(kennzahlen([first, income]), {
    einnahmen: 100, ausgaben: 40, versand: 5, gewinn: 60, anzahl: 2, monate: {
      '2026-10': { einnahmen: 0, ausgaben: 40, gewinn: -40, anzahl: 1 },
      '2026-11': { einnahmen: 100, ausgaben: 0, gewinn: 100, anzahl: 1 }
    }
  })
  assert.deepEqual(jahreListe(documents, 2026), ['2026'])
  assert.equal(verknuepfungen(documents).size, 0)
})

test('Order overview links synthetic revenue and production costs', () => {
  const sale = createReceipt('shop', {
    art: 'einnahme', referenz: '999001', datum: '2026-10-12', wirksam: 50, anzahlArtikel: 1,
    empfaenger: { name: 'Testperson', ort: 'Beispielstadt' },
    positionen: [{ typ: 'artikel', bezeichnung: 'Test Hoodie', menge: 1, entfernt: true, groesse: 'L' }]
  })
  const cost = createReceipt('cost', {
    art: 'ausgabe', referenz: '999001', datum: '2026-10-13', wirksam: 20, wirksamArt: 'inkl. MwSt', anzahlArtikel: 1,
    summen: { netto: 20, brutto: 23.8 },
    positionen: [{ typ: 'artikel', bezeichnung: 'Test Hoodie', projekt: 'Test Hoodie', menge: 1, groesse: 'L', einzelpreis: 20 }]
  }, 2)
  const orders = bestellungenListe([sale, cost])
  const order = orders[0]

  assert.equal(order.komplett, true)
  assert.equal(order.erloes, 50)
  assert.equal(order.kosten, 20)
  assert.equal(order.gewinn, 30)
  assert.equal(order.umtausch.anzahl, 1)
  assert.equal(order.umtausch.kosten, 23.8)
  assert.equal(bestellungenFiltern(orders, { status: 'komplett', suche: 'testperson' }).length, 1)
  assert.deepEqual(bestellungenSortieren(orders, 'gewinn'), orders)
  assert.equal(kennzahlenBestellungen(orders).komplett, 1)
  assert.equal(verknuepfungen([sale, cost]).get('999001').gewinn, 30)
})

test('Payment-date switch groups filters and monthly views by payment day, with order date as fallback', () => {
  const bestellung = {
    art: 'einnahme', referenz: '9003', datum: '2025-12-31', wirksam: 80,
    zahlung: { datum: '2026-01-02', eingaenge: [{ datum: '2026-01-02', betrag: 80 }], erstattungen: [] },
    empfaenger: { name: 'Zahlungskunde', ort: 'Berlin' },
    positionen: [{ typ: 'artikel', bezeichnung: 'Test', menge: 1, einzelpreis: 80, gesamt: 80 }],
    summen: { netto: 80, brutto: 80, mwst: 0 }
  }
  const rechnung = {
    anbieter: 'shopify-api', art: 'einnahme', referenz: '9003', datum: '2025-12-31', wirksam: 80,
    zahlung: { datum: '2026-01-02', eingaenge: [{ datum: '2026-01-02', betrag: 80 }] },
    lieferant: 'Shop', rechnungsnummer: 'R-9003', bestellnummer: '9003', empfaenger: { name: 'Zahlungskunde' },
    positionen: [{ typ: 'artikel', bezeichnung: 'Test', menge: 1, einzelpreis: 80, gesamt: 80 }],
    summen: { netto: 80, brutto: 80, mwst: 0 }
  }

  const shirtigo = { ...bestellung, anbieter: 'shirtigo-api', art: 'ausgabe', datum: '2025-12-15', zahlung: undefined, wirksam: 20 }
  const fixkosten = { ...rechnung, anbieter: 'shop-rechnung', referenz: undefined, art: 'ausgabe', datum: '2024-12-30', zahlung: { datum: '2025-01-03' }, wirksam: 3 }
  const liste = [{ id: 'a', rechnung, zeit: 1 }, { id: 'b', rechnung: shirtigo, zeit: 2 }, { id: 'c', rechnung: fixkosten, zeit: 3 }]
  const orders = bestellungenListe([createReceipt('shop', bestellung), createReceipt('cost', shirtigo)])

  assert.equal(bestellungenFiltern(orders, { jahr: '2026', zahlungsbasis: 'zahlung', status: '' }).length, 1)
  assert.equal(bestellungenFiltern(orders, { jahr: '2025', zahlungsbasis: 'bestellung', status: '' }).length, 1)
  assert.deepEqual([orders[0].datumBestellung, orders[0].datumZahlung], ['2025-12-31', '2026-01-02'], 'Shirtigo-Rechnungsdatum überschreibt nicht den Shopify-Zahlungstag')
  assert.equal(filtern(liste, { jahr: '2026', monat: '01', zahlungsbasis: 'zahlung' }, new Set()).length, 1, 'Shirtigo-Kosten bleiben im eigenen Zahlungsmonat')
  assert.equal(filtern(liste, { jahr: '2025', monat: '12', zahlungsbasis: 'bestellung' }, new Set()).length, 2, 'verknüpfte Shirtigo-Kosten folgen dem Shopify-Bestelldatum')
  assert.equal(filtern(liste, { jahr: '2025', monat: '01', zahlungsbasis: 'zahlung' }, new Set()).length, 1, 'Fixkosten nutzen im Zahlungsmodus ihren Zahlungstag')
  assert.equal(filtern(liste, { jahr: '2024', monat: '12', zahlungsbasis: 'bestellung' }, new Set()).length, 1, 'Fixkosten nutzen im Bestelldatum-Modus ersatzweise ihr Rechnungsdatum')
  const zahlungsKennzahlen = kennzahlen(liste, 'zahlung', liste)
  const bestellKennzahlen = kennzahlen(liste, 'bestellung', liste)
  assert.deepEqual([zahlungsKennzahlen.einnahmen, zahlungsKennzahlen.ausgaben, zahlungsKennzahlen.gewinn], [80, 23, 57])
  assert.deepEqual([bestellKennzahlen.einnahmen, bestellKennzahlen.ausgaben, bestellKennzahlen.gewinn], [80, 23, 57], 'Gesamtsummen bleiben beim Wechsel der Basis gleich')
  assert.deepEqual(Object.keys(zahlungsKennzahlen.monate), ['2026-01', '2025-12', '2025-01'])
  assert.deepEqual(Object.keys(bestellKennzahlen.monate), ['2025-12', '2024-12'])
  assert.deepEqual(sortieren(liste, 'datum', 'zahlung', liste).map((d) => d.id), ['a', 'b', 'c'])
  assert.deepEqual(sortieren(liste, 'datum', 'bestellung', liste).map((d) => d.id), ['b', 'a', 'c'])
  assert.deepEqual(jahreListe(liste, 2025, 'zahlung'), ['2026', '2025'], 'Zahlungsjahr erscheint auch ohne Bestelldatum in diesem Jahr')
  assert.deepEqual(jahreListe(liste, 2025, 'bestellung'), ['2025', '2024'])
})

test('Gebühren zählen als Kosten der Bestellung, machen sie aber allein nicht vollständig (Schritt 4.8)', () => {
  const sale = createReceipt('shop', { art: 'einnahme', referenz: '999101', datum: '2024-04-01', wirksam: 50, anzahlArtikel: 1, positionen: [] })
  const fee = createReceipt('g999101', { art: 'ausgabe', gebuehr: true, referenz: '999101', datum: '2024-04-01', wirksam: 1.02, positionen: [{ typ: 'gebuehr', bezeichnung: 'payment_processing', menge: 1, gesamt: 0.92 }] })
  const cost = createReceipt('cost', { art: 'ausgabe', referenz: '999101', datum: '2024-04-02', wirksam: 20, positionen: [] })
  const nurGebuehr = bestellungenListe([sale, fee])[0]
  assert.equal(nurGebuehr.komplett, false)
  assert.equal(nurGebuehr.kosten, 1.02)
  const voll = bestellungenListe([sale, fee, cost])[0]
  assert.equal(voll.komplett, true)
  assert.equal(voll.gewinn, 28.98)
})
