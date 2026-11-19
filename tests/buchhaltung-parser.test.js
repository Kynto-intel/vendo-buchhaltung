const assert = require('node:assert/strict')
const { describe, it } = require('node:test')
const { parseRechnung, auswerten } = require('../parser.js')
const normalizeLines = (text) => text.trim().split(/\r?\n/).map((line) => line.trim()).join('\n')

describe('Invoice parser', () => {
  it('parses Shirtigo line items and validates net, VAT, and gross totals', () => {
    const invoice = parseRechnung(`
      Shirtigo GmbH
      Rechnungs-Nr. 2026-17
      Datum: 20.10.2026
      Menge (1) Einzelpreis Gesamtpreis
      Projekt: Classic - CP12345678 Shirt Farbe: Schwarz Größe: L 2 10,00 € 20,00 €
      Versandkosten 1 4,90 € 4,90 €
      Brutto-Summe 24,90 € 4,73 € 29,63 €
      Die Preise der einzelnen Posten verstehen sich netto.
    `)

    assert.equal(invoice.anbieter, 'shirtigo')
    assert.equal(invoice.rechnungsnummer, '2026-17')
    assert.equal(invoice.datum, '2026-10-20')
    assert.equal(invoice.positionen.length, 2)
    assert.equal(invoice.positionen[0].gesamt, 20)
    assert.equal(invoice.positionen[1].typ, 'versand')
    assert.equal(invoice.summen.netto, 24.9)
    assert.equal(invoice.summen.mwst, 4.73)
    assert.equal(invoice.summen.brutto, 29.63)
    assert.equal(invoice.pruefung.ok, true)
  })

  it('explicitly marks unknown invoices as uncertain', () => {
    const parsedInvoice = parseRechnung(`
      Muster GmbH
      Rechnungsnummer: RG-2026-17
      01.10.2026
      Material 2 10,00 € 20,00 €
      Netto-Summe: 20,00 €
      MwSt. 3,80 €
      Brutto-Summe: 23,80 €
    `)

    assert.equal(parsedInvoice.anbieter, 'allgemein')
    assert.equal(parsedInvoice.unsicher, true)
    assert.equal(parsedInvoice.summen.brutto, 23.8)
    assert.equal(parsedInvoice.pruefung.ok, false)
  })

  it('parses Shopify order line items, shipping, and total amount', () => {
    const parsedInvoice = parseRechnung(`
      Bestellung #9901
      20. Oktober 2026
      Kunde: Testkunde Beispiel
      T-Shirt 2 × 25,00 € 50,00 €
      Versand 4,90 €
      MwSt. 8,76 €
      Zwischensumme 50,00 €
      Gesamt 54,90 €
      Bezahlt mit Visa
    `)

    assert.equal(parsedInvoice.anbieter, 'shopify-bestellung')
    assert.equal(parsedInvoice.art, 'einnahme')
    assert.equal(parsedInvoice.bestellnummer, '9901')
    assert.equal(parsedInvoice.datum, '2026-10-20')
    assert.equal(parsedInvoice.anzahlArtikel, 2)
    assert.equal(parsedInvoice.versand, 4.9)
    assert.equal(parsedInvoice.summen.brutto, 54.9)
    assert.equal(parsedInvoice.summen.netto, 46.14)
    assert.equal(parsedInvoice.zahlung.bezahlt, true)
  })

  it('parses Shirtigo extra items, tracking, address, and payment details', () => {
    const parsedInvoice = parseRechnung(normalizeLines(`
      Shirtigo GmbH
      Rechnungs-Nr. 2026-18
      Datum: 21.10.2026
      Bestell-Nr: A12345
      Referenz: 9902
      Lieferadresse:
      Beispiel GmbH
      Testkunde Beispiel
      Musterstraße 2
      12345 Berlin
      Menge (1) Einzelpreis Gesamtpreis
      Unbekannter Posten
      Projekt: Classic - CP12345678 Shirt Farbe: Schwarz Größe: L 1 20,00 € 20,00 €
      Sticker: Logo 1 2,00 € 2,00 €
      Versandkosten Tracking: DHL (Sendungsnummer) 1 4,90 € 4,90 €
      Rechnung 2026-18, Seite 1 von 2 Shirtigo GmbH Fußzeile DEUTDEDBKOE
      Brutto-Summe 26,90 € 5,11 € 32,01 €
      zzgl. MwSt. (19%)
      Zahlung erfolgte durch: PayPal
      Rechnung bereits bezahlt
    `))

    assert.equal(parsedInvoice.bestellnummer, 'A12345')
    assert.equal(parsedInvoice.referenz, '9902')
    assert.deepEqual(parsedInvoice.empfaenger, {
      name: 'Testkunde Beispiel', firma: 'Beispiel GmbH', strasse: 'Musterstraße 2', plz: '12345', ort: 'Berlin'
    })
    assert.deepEqual(parsedInvoice.positionen.map((p) => p.typ), ['artikel', 'zusatz', 'versand'])
    assert.equal(parsedInvoice.summen.mwstSatz, 19)
    assert.equal(parsedInvoice.zahlung.art, 'PayPal')
    assert.equal(parsedInvoice.zahlung.bezahlt, true)
    assert.equal(parsedInvoice.pruefung.hinweise.some((h) => h.includes('nicht zugeordnet')), true)
  })

  it('parses Shopify subscription invoices with groups, credits, periods, and reverse charge', () => {
    const parsedInvoice = parseRechnung(`
      Shopify International Limited
      Rechnung #77123
      Jan 7, 2026
      Bezahlt am 8. Januar. 2026
      USt. IE123456789
      DETAILANSICHT
      Einzelposten 1,00 € EUR
      Shopify Abonnement (1 Artikel) 15,00 € EUR
      Basic 10,00 € EUR
      Apps (1 Artikel) 5,00 € EUR
      Themes (1 Artikel) 2,00 € EUR
      Premium 3,00 € EUR
      Alle 30 Tage
      Guthaben 2,00 € EUR
      Zwischensumme 18,00 €
      USt. 19 % 3,42 €
      Gesamtsumme 21,42 €
      Reverse-Charge
      Rechnung bezahlt: Visa 7. Jan
    `)

    assert.equal(parsedInvoice.anbieter, 'shopify')
    assert.equal(parsedInvoice.rechnungsnummer, '77123')
    assert.equal(parsedInvoice.datum, '2026-01-07')
    assert.equal(parsedInvoice.bezahltAm, '2026-01-08')
    assert.equal(parsedInvoice.ustId, 'IE123456789')
    assert.deepEqual(parsedInvoice.positionen.map((p) => [p.bezeichnung, p.gruppe, p.gesamt]), [
      ['Einzelposten', null, 1], ['Basic', 'Abonnement', 10], ['Apps', undefined, 5], ['Premium', 'Themes', 3]
    ])
    assert.equal(parsedInvoice.positionen[3].zeitraum, 'Alle 30 Tage')
    assert.equal(parsedInvoice.guthaben, 2)
    assert.equal(parsedInvoice.summen.mwstSatz, 19)
    assert.equal(parsedInvoice.reverseCharge, true)
    assert.deepEqual(parsedInvoice.zahlung, { art: 'Visa', bezahlt: true })
  })

  it('handles missing Shopify subscription details and invalid month names', () => {
    const parsedInvoice = parseRechnung(`
      Shopify International Limited
      Rechnung #77124
      Bezahlt am 8. Foobar 2026
      USt. IE123456789
      Zwischensumme -1,00 €
      Rechnung bezahlt: Visa 8. Jan
    `)

    assert.equal(parsedInvoice.datum, undefined)
    assert.equal(parsedInvoice.bezahltAm, undefined)
    assert.equal(parsedInvoice.positionen.length, 0)
    assert.equal(parsedInvoice.summen, undefined)
    assert.equal(parsedInvoice.reverseCharge, false)
    assert.deepEqual(parsedInvoice.zahlung, { art: 'Visa', bezahlt: true })
  })

  it('handles shop orders with removed items and product variants', () => {
    const parsedInvoice = parseRechnung(`
      RECHNUNG BESTELLNUMMER BESTELLDATUM
      #9903 22.10.2026 12:30
      VERSANDDETAILS
      Testkunde Beispiel
      testkunde@example.test
      Musterstraße 2
      12345 Berlin
      RECHNUNGSDETAILS
      TITEL GESAMT
      Canvas- Hoodie ● Midnight Blue ● XL A123456 x2 19% € 30.00 € 25.00 € 50.00
      ~~Shirt x1 19% € 10.00~~
      BEZAHLVERFAHREN Visa ZWISCHENSUMME
      ZWISCHENSUMME € 50.00
      VERSAND € 4.90
      ERSTATTET € 10.00
      GESAMT € 54.90
      BEZAHLT € 54.90
      § 19 UStG
    `)

    assert.equal(parsedInvoice.anbieter, 'shop-rechnung')
    assert.equal(parsedInvoice.rechnungsnummer, '#9903')
    assert.equal(parsedInvoice.uhrzeit, '12:30')
    assert.deepEqual(parsedInvoice.empfaenger, {
      name: 'Testkunde Beispiel', email: 'testkunde@example.test', strasse: 'Musterstraße 2', plz: '12345', ort: 'Berlin'
    })
    assert.deepEqual(parsedInvoice.positionen.slice(0, 2).map((p) => ({
      bezeichnung: p.bezeichnung, farbe: p.farbe, groesse: p.groesse, artikelnummer: p.artikelnummer,
      menge: p.menge, einzelpreis: p.einzelpreis, ursprungspreis: p.ursprungspreis, gesamt: p.gesamt, entfernt: p.entfernt
    })), [
      { bezeichnung: 'Canvas-Hoodie', farbe: 'Midnight Blue', groesse: 'XL', artikelnummer: 'A123456', menge: 2, einzelpreis: 25, ursprungspreis: 30, gesamt: 50, entfernt: false },
      { bezeichnung: 'Shirt', farbe: undefined, groesse: undefined, artikelnummer: undefined, menge: 1, einzelpreis: 10, ursprungspreis: undefined, gesamt: 10, entfernt: true }
    ])
    assert.equal(parsedInvoice.anzahlEntfernt, 1)
    assert.equal(parsedInvoice.anzahlArtikel, 2)
    assert.equal(parsedInvoice.versand, 4.9)
    assert.equal(parsedInvoice.umsatz, 54.9)
    assert.equal(parsedInvoice.wirksamArt, 'ohne MwSt (§ 19)')
    assert.deepEqual(parsedInvoice.zahlung, { art: 'Visa', bezahlt: true })
  })

  it('estimates removed line items and reports additional refunds', () => {
    const parsedInvoice = parseRechnung(`
      RECHNUNG BESTELLNUMMER BESTELLDATUM
      #9904 23.10.2026
      VERSANDDETAILS
      TITEL GESAMT
      ~~Kleinteil x1 0% € 10.00~~
      Hauptartikel x1 0% € 50.00
      ZWISCHENSUMME € 50.00
      ERSTATTET € 15.00
      GESAMT € 54.90
      BEZAHLT € 54.90
      VERSAND € 4.90
      BEZAHLVERFAHREN PayPal ZWISCHENSUMME
    `)

    assert.equal(parsedInvoice.entferntGeraten, undefined)
    assert.equal(parsedInvoice.positionen[0].entfernt, true)
    assert.equal(parsedInvoice.positionen[0].geraten, undefined)
    assert.equal(parsedInvoice.zusatzErstattung, 5)
    assert.equal(parsedInvoice.umsatz, 49.9)
    assert.equal(parsedInvoice.mwstFehlt, true)
    assert.equal(parsedInvoice.pruefung.hinweise.some((h) => h.includes('geschätzt')), false)
    assert.equal(parsedInvoice.pruefung.hinweise.some((h) => h.includes('mindert den Umsatz')), true)
  })

  it('estimates removed line items from a refund when OCR provides no marker', () => {
    const parsedInvoice = parseRechnung(`
      RECHNUNG BESTELLNUMMER BESTELLDATUM
      #9905 26.10.2026
      VERSANDDETAILS
      TITEL GESAMT
      Kleinteil x1 0% € 10.00
      Hauptartikel x1 0% € 50.00
      ZWISCHENSUMME € 50.00
      ERSTATTET € 10.00
      GESAMT € 54.90
      BEZAHLT € 54.90
    `)

    assert.equal(parsedInvoice.entferntGeraten, true)
    assert.equal(parsedInvoice.positionen[0].entfernt, true)
    assert.equal(parsedInvoice.positionen[0].geraten, true)
    assert.equal(parsedInvoice.zusatzErstattung, undefined)
  })

  it('assigns discounts as line items or detects discounts already included', () => {
    const discountLineItem = parseRechnung(`
      RECHNUNG BESTELLNUMMER BESTELLDATUM
      #9906 24.10.2026
      VERSANDDETAILS
      TITEL GESAMT
      Produkt x1 0% € 100.00
      RABATT - € 20.00
      ZWISCHENSUMME € 80.00
      GESAMT € 80.00
      BEZAHLT € 80.00
    `)
    const discountAlreadyIncluded = parseRechnung(`
      RECHNUNG BESTELLNUMMER BESTELLDATUM
      #9907 25.10.2026
      VERSANDDETAILS
      TITEL GESAMT
      Produkt x1 0% € 80.00
      RABATT - € 20.00
      ZWISCHENSUMME € 80.00
      GESAMT € 80.00
      BEZAHLT € 80.00
    `)

    assert.equal(discountLineItem.positionen.some((p) => p.typ === 'rabatt' && p.gesamt === -20), true)
    assert.equal(discountAlreadyIncluded.rabattEingerechnet, true)
  })

  it('calculates shop orders without the small-business VAT exemption and with an open balance', () => {
    const parsedInvoice = parseRechnung(`
      RECHNUNG BESTELLNUMMER BESTELLDATUM
      #9908 27.10.2026
      VERSANDDETAILS
      Testkunde Beispiel
      RECHNUNGSDETAILS
      TITEL GESAMT
      Artikel x1 19% € 10.00 € 10.00
      ZWISCHENSUMME € 10.00
      VERSAND € 5.00
      GESAMT € 15.00
      BEZAHLT € 0.00
      OFFENER BETRAG € 15.00
      BEZAHLVERFAHREN Klarna ZWISCHENSUMME
    `)

    assert.equal(parsedInvoice.kleinunternehmer, false)
    assert.equal(parsedInvoice.mwstFehlt, undefined)
    assert.equal(parsedInvoice.offen, 15)
    assert.equal(parsedInvoice.wirksamArt, 'netto')
    assert.deepEqual(parsedInvoice.zahlung, { art: 'Klarna', bezahlt: false })
  })

  it('parses Shopify order line items in multiple line formats', () => {
    const parsedInvoice = parseRechnung(`
      Shopify order 9909
      March 10, 2026
      Customer: Testkunde Beispiel
      Classic Tee 12,50 € × 2 25,00 €
      Socken 2 × 5,00 € 10,00 €
      Poster × 3 6,00 €
      Sticker 2 3,00 € 6,00 €
      Tasse
      × 2 8,00 €
      Shipping 4,90 €
      Kostenloser Versand 0,00 €
      Rabatt -2,00 €
      Tax 19% 9,29 €
      Subtotal 55,00 €
      Total 58,19 €
      Payment: Visa
    `)

    assert.deepEqual(parsedInvoice.positionen.map((p) => [p.typ, p.bezeichnung, p.menge, p.einzelpreis, p.gesamt]), [
      ['artikel', 'Classic Tee', 2, 12.5, 25], ['artikel', 'Socken', 2, 5, 10],
      ['artikel', 'Poster', 3, 2, 6], ['artikel', 'Sticker', 2, 3, 6],
      ['artikel', 'Tasse', 2, 4, 8], ['versand', 'Shipping', 1, 4.9, 4.9], ['rabatt', 'Rabatt', 1, -2, -2]
    ])
    assert.equal(parsedInvoice.empfaenger.name, 'Testkunde Beispiel')
    assert.equal(parsedInvoice.summen.mwst, 9.29)
    assert.equal(parsedInvoice.summen.mwstSatz, 19)
    assert.equal(parsedInvoice.summen.zwischensumme, 55)
    assert.equal(parsedInvoice.summen.brutto, 58.19)
    assert.equal(parsedInvoice.zahlung.art, 'Visa')
  })

  it('recognizes multiple Shopify date formats and order numbers', () => {
    const cases = [
      ['Bestellung Nr. 9910', '10.03.2026', '2026-03-10'],
      ['Bestellung Nr. 9911', '10. März 2026', '2026-03-10'],
      ['Order #9912', 'March 10, 2026', '2026-03-10'],
      ['Order #9913', '2026-03-10', '2026-03-10'],
      ['Order #9914', 'Datum nicht erkannt', null]
    ]

    for (const [heading, dateText, expectedDate] of cases) {
      const parsedInvoice = parseRechnung(`
        ${heading}
        ${dateText}
        Zwischensumme 1,00 €
        Gesamt 1,00 €
      `)
      assert.equal(parsedInvoice.datum, expectedDate)
    }
  })

  it('safely falls back for unknown invoices with USD and incomplete data', () => {
    const parsedInvoice = parseRechnung(`
      Acme Inc. | Billing
      Rechnungsnummer: AB-123
      03.10.2026
      Shipping 2 5,00 10,00
      Service 1 20,00 20,00
      Netto: 30,00
      USt. 5,70
      Rechnungsbetrag: 35,70
      USD
      Paid
    `)
    const emptyInvoice = parseRechnung('Kein Rechnungsinhalt')

    assert.equal(parsedInvoice.waehrung, 'USD')
    assert.equal(parsedInvoice.lieferant, 'Acme Inc.')
    assert.equal(parsedInvoice.rechnungsnummer, 'AB-123')
    assert.deepEqual(parsedInvoice.positionen.map((p) => p.typ), ['versand', 'artikel'])
    assert.equal(parsedInvoice.summen.netto, 30)
    assert.equal(parsedInvoice.zahlung.bezahlt, true)
    assert.equal(parsedInvoice.pruefung.ok, false)
    assert.equal(emptyInvoice.pruefung.hinweise.length >= 4, true)
  })

  it('handles incomplete Shopify orders and customer names on the following line', () => {
    const parsedInvoice = parseRechnung(`
      Bestellung #9915
      Kundin:
      Testkunde Beispiel
      Poster × 2 6,00 €
      Kostenloser Versand 0,00 €
      Zwischensumme 12,00 €
    `)

    assert.equal(parsedInvoice.empfaenger.name, 'Testkunde Beispiel')
    assert.equal(parsedInvoice.datum, null)
    assert.equal(parsedInvoice.positionen.length, 1)
    assert.equal(parsedInvoice.versand, 0)
    assert.equal(parsedInvoice.summen, undefined)
    assert.equal(parsedInvoice.mwstFehlt, undefined)
    assert.equal(parsedInvoice.zahlung.bezahlt, false)
  })
})

describe('Invoice summaries', () => {
  it('totals income, expenses, and profit by month', () => {
    const summary = auswerten([
      { art: 'einnahme', datum: '2026-10-03', wirksam: 100, summen: { netto: 100, brutto: 100, mwst: 0 } },
      { art: 'ausgabe', datum: '2026-10-12', wirksam: 40, versand: 10, summen: { netto: 40, brutto: 47.6, mwst: 7.6 } },
      { art: 'ausgabe', datum: '2026-11-02', wirksam: 20, versand: 0, summen: { netto: 20, brutto: 23.8, mwst: 3.8 } },
      { art: 'ausgabe', datum: '2026-11-03' }
    ])

    assert.deepEqual(summary.gesamt, { einnahmen: 100, ausgaben: 60, versand: 10, mwst: -11.4, gewinn: 40 })
    assert.deepEqual(summary.monate['2026-10'], { einnahmen: 100, ausgaben: 40, gewinn: 60 })
    assert.deepEqual(summary.monate['2026-11'], { einnahmen: 0, ausgaben: 20, gewinn: -20 })
  })

  it('uses net/gross fallbacks and groups missing dates as unknown', () => {
    const summary = auswerten([
      null,
      { art: 'einnahme', summen: { netto: 3, brutto: 3, mwst: 0 } },
      { art: 'ausgabe', summen: { brutto: 1, mwst: 0 } }
    ])

    assert.deepEqual(summary.gesamt, { einnahmen: 3, ausgaben: 1, versand: 0, mwst: 0, gewinn: 2 })
    assert.deepEqual(summary.monate.unbekan, { einnahmen: 3, ausgaben: 1, gewinn: 2 })
  })
})