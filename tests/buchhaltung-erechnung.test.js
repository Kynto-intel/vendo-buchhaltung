'use strict'
// E-Rechnungen als XML (erechnung.js, Konformitätsprüfung K.3): erfundene Rechnungen in CII und UBL.
//   node --test tests/buchhaltung-erechnung.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const profil = require('../profil.js')
const er = require('../erechnung.js')

profil.setzen({ firmenname: 'Synthetik-Shop', steuerzeitraeume: [{ von: '', bis: '', art: 'klein' }], eigeneNamen: ['Synthetik-Shop'] })

const { CII, UBL } = require('./fixtures/erechnung.js')

test('CII (ZUGFeRD/XRechnung): Nummer, Datum, Lieferant, Summen, Positionen, Ausgabe brutto als Kleinunternehmer', () => {
  const r = er.lesen(CII)
  assert.deepEqual([r.format, r.rechnungsnummer, r.datum, r.lieferant, r.ustId, r.waehrung], ['CII', 'SYN-2026-001', '2026-03-15', 'Erfundene Druckerei GmbH & Co. KG', 'DE000000000', 'EUR'])
  assert.deepEqual(r.summen, { netto: 100, mwst: 19, brutto: 119, mwstSatz: 19 })
  assert.deepEqual([r.art, r.wirksam, r.wirksamArt, r.reverseCharge, r.positionen.length, r.pruefung.ok], ['ausgabe', 119, 'inkl. MwSt', false, 2, true])
  assert.match(r.pruefung.hinweise[0], /KoSIT/)
})

test('UBL (XRechnung): Kopf-ID statt Partei-ID, Reverse-Charge (AE), Positionen', () => {
  const r = er.lesen(UBL)
  assert.deepEqual([r.format, r.rechnungsnummer, r.datum, r.lieferant, r.reverseCharge, r.positionen.length], ['UBL', 'SYN-UBL-7', '2026-02-01', 'Erfundene Software Ltd', true, 1])
  assert.deepEqual([r.summen.netto, r.summen.mwst, r.summen.brutto], [50, 0, 50])
})

test('Gutschrift negativ, fremde Währung markiert, keine E-Rechnung abgelehnt', () => {
  const g = er.lesen(UBL.replace('<Invoice ', '<CreditNote ').replace('</Invoice>', '</CreditNote>').replace('<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>', ''))
  assert.equal(g.summen.brutto, -50)
  const usd = er.lesen(CII.replace('<ram:InvoiceCurrencyCode>EUR', '<ram:InvoiceCurrencyCode>USD'))
  assert.deepEqual([usd.waehrung, usd.pruefung.ok], ['USD', false])
  assert.throws(() => er.lesen('<?xml version="1.0"?><Bestellung/>'), /keine E-Rechnung/)
  assert.throws(() => er.lesen('%PDF-1.4'), /keine E-Rechnung/)
  assert.equal(er.format('﻿<?xml version="1.0"?>\n<!-- x --><ubl:Invoice xmlns:ubl="u"/>'), 'UBL')
})

