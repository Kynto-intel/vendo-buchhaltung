import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

// Tests für Schritt 2.3: Die früher fest im Code stehenden Angaben (FIRMA, EIGENE_NAMEN, EIGENER_SHOP, KLEINUNTERNEHMER)
// kommen aus „Meine Angaben“ (profil.js). Nur synthetische Angaben aus tests/fixtures/meine-angaben.json
// (Regelbesteuerung 19 % vom 04.03.2024 bis 12.04.2024, sonst Kleinunternehmer) und synthetische Bestellungen.

const require = createRequire(import.meta.url)
const pluginFolder = path.resolve('.')
const profil = require('../profil.js')
const { parseRechnung } = require('../parser.js')
const ANGABEN = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/meine-angaben.json'), 'utf8'))

function modulLaden(datei, abhaengig) {
  const modul = { exports: {} }
  new Function('require', 'module', 'exports', '__dirname', fs.readFileSync(path.join(pluginFolder, datei), 'utf8'))((name) => {
    if (abhaengig.has(name)) return abhaengig.get(name)
    if (name.startsWith('node:')) return require(name)
    throw new Error(`unerwartetes require in ${datei}: ${name}`)
  }, modul, modul.exports, pluginFolder)
  return modul.exports
}
const geld = (amount) => ({ shopMoney: { amount: String(amount), currencyCode: 'EUR' } })
function bestellung(nr, createdAt, { brutto = 23.8, steuer = 3.8 } = {}) {
  return {
    id: `gid://synthetic/Order/${nr}`, name: `#${nr}`, createdAt, updatedAt: createdAt, cancelledAt: null, test: false,
    displayFinancialStatus: 'PAID', email: 'testkunde@example.test', paymentGatewayNames: ['synthetic_gateway'],
    currentTotalPriceSet: geld(brutto), totalPriceSet: geld(brutto), totalShippingPriceSet: geld(0), totalDiscountsSet: geld(0),
    totalRefundedSet: geld(0), netPaymentSet: geld(brutto), currentTotalTaxSet: geld(steuer),
    shippingAddress: { name: 'Test Kunde', address1: 'Teststraße 1', address2: null, zip: '10115', city: 'Berlin', countryCodeV2: 'DE' },
    billingAddress: null, refunds: [], shippingLines: { nodes: [] },
    lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ title: 'Test-Shirt', variantTitle: 'Default Title', variant: { sku: 'TST-1', image: null }, quantity: 1, currentQuantity: 1, originalUnitPriceSet: geld(brutto), discountedUnitPriceAfterAllDiscountsSet: geld(brutto) }] }
  }
}
const bestellungenLaden = () => modulLaden('bestellungen.js', new Map([
  ['./shopify', {}], ['./beleg', {}], ['./geo', { finde: () => null }], ['./profil', profil], ['./parser', require('../parser.js')]
]))

test('Profil: Steuerstatus je Tag, eigene Namen, Shopname, Firmenangaben mit § 19-Hinweis nur bei Kleinunternehmer (Schritt 2.3)', () => {
  profil.setzen(null)
  assert.deepEqual(profil.steuerAm('2024-04-20'), { art: 'klein', satz: 0, unbekannt: true }, 'ohne Angaben wie bisher Kleinunternehmer')
  assert.deepEqual([profil.eigenerShop(), profil.istEigen('Synthetik-Shop'), profil.vollstaendig()], ['Eigener Shop', false, false])
  const leer = profil.stand()

  profil.setzen(ANGABEN)
  assert.notEqual(profil.stand(), leer, 'Stand ändert sich mit den Angaben')
  assert.deepEqual(['2024-03-03', '2024-03-04', '2024-04-12', '2024-04-13'].map((t) => profil.kleinunternehmerAm(t)), [true, false, false, true])
  assert.deepEqual(profil.steuerAm('2024-04-01'), { art: 'regel', satz: 19, unbekannt: false })
  assert.deepEqual(['2024-05-01', '2026-01-05'].map((t) => profil.vorsteuerAbziehbarAm(t)), [false, false], 'Vorsteuer nie abziehbar')
  assert.deepEqual([profil.istEigen('SYNTHETIK GmbH'), profil.istEigen('Frau Erika Muster'), profil.istEigen('Shirtigo GmbH'), profil.istEigen('')], [true, true, false, false])
  assert.deepEqual([profil.eigenerShop(), profil.vollstaendig()], ['Synthetik-Shop', true])

  const klein = profil.firma('2026-01-05')
  assert.deepEqual([klein.name, klein.zeilen], ['Synthetik-Shop', ['Teststraße 1', '12345 Musterstadt', 'test@example.test', 'example.test']])
  assert.equal(klein.schluss.join(' '), 'Steuerfrei als Kleinunternehmer gemäß § 19 Abs. 1 UStG. Empfänger: Erika Muster, IBAN: DE89 3704 0044 0532 0130 00, Bank: Testbank, W-IdNr.: DE123456789')
  assert.ok(klein.schluss.every((z) => z.length <= 95), 'Fußzeilen passen auf die Seite')
  const regel = profil.firma('2024-04-01')
  assert.equal(regel.schluss.join(' ').includes('§ 19'), false, 'kein § 19-Hinweis in der Regelbesteuerung')
  profil.setzen({ ...ANGABEN, land: 'AT', plz: '1010', ustId: 'ATU12345678', telefon: '+43 1 234' })
  assert.deepEqual(profil.firma('2026-01-05').zeilen.slice(1, 3), ['1010 Musterstadt', 'AT'], 'Ausland: Ländercode als eigene Zeile')
  assert.ok(profil.firma('2026-01-05').schluss.join(' ').endsWith('USt-IdNr.: ATU12345678'), 'USt-IdNr. vor W-IdNr.')
})

test('Parser: Einnahme über eigene Namen bzw. eigenes Shop-Profil, Ausgaben immer brutto, auch in der Regelbesteuerung (Schritt 2.3, Entscheidung Nutzer)', () => {
  const text = (lieferant, datum) => `${lieferant}\nRechnungsnummer: TEST-1\n${datum}\nService 1 100,00 € 100,00 €\nNetto: 100,00 €\nUSt. 19,00 €\nRechnungsbetrag: 119,00 €\nPaid`
  profil.setzen(ANGABEN)
  const ausgabeKlein = parseRechnung(text('Beispiel Anbieter GmbH', '05.03.2026'))
  const ausgabeRegel = parseRechnung(text('Beispiel Anbieter GmbH', '05.05.2024'))
  assert.deepEqual([ausgabeKlein.art, ausgabeKlein.datum, ausgabeKlein.wirksam, ausgabeKlein.wirksamArt], ['ausgabe', '2026-03-05', 119, 'inkl. MwSt'])
  assert.deepEqual([ausgabeRegel.art, ausgabeRegel.datum, ausgabeRegel.wirksam, ausgabeRegel.wirksamArt], ['ausgabe', '2024-05-05', 119, 'inkl. MwSt'], 'auch in der Regelbesteuerung brutto: Vorsteuer wird nie geltend gemacht (Nutzer, 29.10.2026)')
  assert.equal(parseRechnung(text('Synthetik Handel GmbH', '05.03.2026')).art, 'einnahme', 'eigener Name → Einnahme')
  assert.equal(ausgabeKlein.profil, profil.stand(), 'Auswertung merkt sich den Stand der Angaben')
  const shop = parseRechnung('Bestellung #9901\n20. Oktober 2026\nT-Shirt 2 × 25,00 € 50,00 €\nZwischensumme 50,00 €\nGesamt 50,00 €\nBezahlt mit Visa')
  assert.deepEqual([shop.anbieter, shop.lieferant, shop.art, 'eigen' in shop], ['shopify-bestellung', 'Synthetik-Shop', 'einnahme', false])
  profil.setzen({ ...ANGABEN, eigeneNamen: [] })
  assert.equal(parseRechnung(text('Synthetik Handel GmbH', '05.03.2026')).art, 'ausgabe', 'ohne eigene Namen keine Einnahme-Erkennung')
  const quelle = fs.readFileSync(path.join(pluginFolder, 'parser.js'), 'utf8') + fs.readFileSync(path.join(pluginFolder, 'beleg-layout.js'), 'utf8')
  for (const alt of ['EIGENE_NAMEN', 'EIGENER_SHOP', 'KLEINUNTERNEHMER', 'FIRMA', 'IBAN: DE', 'W-IdNr: DE']) assert.equal(quelle.includes(alt), false, `${alt} steht nicht mehr fest im Code`)
})

test('Shopify und Shirtigo: Steuer je Bestelltag – Einnahme netto mit eigener USt-Summe, Ausgaben immer brutto (Schritt 2.3)', () => {
  profil.setzen(ANGABEN)
  const b = bestellungenLaden()
  const regel = b.zuRechnung(bestellung(9101, '2024-04-12T21:30:00Z'), 1) // Berlin: 12.04.2024 23:30 → noch Regelbesteuerung
  assert.deepEqual([regel.datum, regel.kleinunternehmer, regel.regelbesteuerung, regel.wirksam, regel.wirksamArt, regel.summen], ['2024-04-12', false, 19, 20, 'netto', { brutto: 23.8, mwst: 3.8, netto: 20, zwischensumme: null, mwstSatz: 19 }])
  const danach = b.zuRechnung(bestellung(9102, '2024-04-12T22:30:00Z'), 1) // Berlin: 13.04.2024 00:30 → Kleinunternehmer
  assert.deepEqual([danach.datum, danach.kleinunternehmer, danach.regelbesteuerung, danach.wirksam, danach.summen.mwst, danach.summen.mwstSatz], ['2024-04-13', true, undefined, 23.8, 0, 0])
  assert.equal(danach.lieferant, 'Synthetik-Shop')
  const erstattet = b.zuRechnung({ ...bestellung(9103, '2024-05-01T10:00:00Z'), netPaymentSet: geld(0), displayFinancialStatus: 'REFUNDED' }, 1)
  assert.deepEqual([erstattet.wirksam, erstattet.summen.mwst], [0, 0], 'komplett erstattet: keine Steuer, kein Umsatz')

  const s = modulLaden('shirtigo-bestellungen.js', new Map([['./shirtigo', {}], ['./bestellungen', b], ['./profil', profil]]))
  const betrag = (cent) => ({ amount: cent, currency_factor: 100, currency_code: 'EUR' })
  const auftrag = (bezahltAm) => ({ reference: 'S1', invoice_reference: 'R-S1', created_at: `${bezahltAm} 10:00:00`, updated_at: `${bezahltAm} 11:00:00`, net_price: betrag(1000), gross_price: betrag(1190), vat_amount: betrag(190), vat_rate: 19, products: [{ name: 'Synthetisches Shirt', amount: 1, net_total_price: betrag(1000) }], payments: [{ status: 'paid', type: 'synthetic', updated_at: `${bezahltAm} 12:00:00` }], fulfillment: { type: 'shopify', reference: '9101' } })
  assert.deepEqual([s.zuRechnung(auftrag('2024-05-02'), 1).wirksam, s.zuRechnung(auftrag('2024-05-02'), 1).wirksamArt], [11.9, 'inkl. MwSt'], 'Shirtigo auch in der Regelbesteuerung brutto')
  assert.deepEqual([s.zuRechnung(auftrag('2026-03-02'), 1).wirksam, s.zuRechnung(auftrag('2026-03-02'), 1).wirksamArt], [11.9, 'inkl. MwSt'])
})

test('Echter Umsatzbeleg (pdfkit + pdfjs): Firmenangaben aus „Meine Angaben“, Satz und § 19-Hinweis nach Bestelltag (Schritt 2.3); Titel, Ausstellungsdatum, Steuerausweis (Phase 5.1)', async () => {
  const { belegPdf } = require('../beleg.js')
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const text = async (buffer) => {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), verbosity: 0 }).promise
    const seite = await doc.getPage(1)
    return (await seite.getTextContent()).items.map((i) => i.str).join(' ').replace(/\s+/g, ' ')
  }
  profil.setzen({ ...ANGABEN, dankestext: 'Danke für deinen Einkauf bei Synthetik' })
  const b = bestellungenLaden()
  const pdf = async (o) => text(await belegPdf({ o, rechnung: b.zuRechnung(o, 1), version: 1, jsonSha: 'a'.repeat(64), abgerufen: '2026-10-29T10:00:00Z' }))
  const klein = await pdf(bestellung(9201, '2026-03-02T10:00:00Z', { steuer: 0 }))
  for (const teil of ['Synthetik-Shop', 'Teststraße 1', '12345 Musterstadt', 'test@example.test', 'Steuerfrei als Kleinunternehmer', 'DE89 3704 0044 0532 0130 00', 'W-IdNr.: DE123456789', 'Danke für deinen Einkauf bei Synthetik', 'UMSATZBELEG', 'ERSTELLT AM', '29.10.2026', 'RECHNUNGSANSCHRIFT']) assert.ok(klein.includes(teil), `fehlt: ${teil}`)
  assert.equal(/RECHNUNG(?!SANSCHRIFT)/.test(klein), false, 'Titel ist „Umsatzbeleg“, nicht „Rechnung“ (Phase 5.1, B3)')
  assert.equal(/0 ?%|MWST|ENTHALTENE UST/.test(klein), false, 'Kleinunternehmer: keine Steuerangabe „0 %“ (wie „haben“)')
  const regel = await pdf(bestellung(9202, '2024-04-02T10:00:00Z'))
  assert.ok(regel.includes('19%'), 'Steuersatz 19 % in der Regelbesteuerung')
  assert.ok(regel.includes('NETTO') && regel.includes('ENTHALTENE UST 19 %'), 'Regelbesteuerung: Netto und enthaltene USt in den Summen')
  assert.equal(regel.includes('Kleinunternehmer'), false, 'kein § 19-Hinweis in der Regelbesteuerung')
})

test('§ 19-Hinweis folgt dem Steuerstatus des Belegs, nicht nur dem Tag (Phase 5.1)', () => {
  profil.setzen(ANGABEN)
  assert.ok(profil.firma('2026-03-02', true).schluss.join(' ').includes('§ 19'))
  assert.equal(profil.firma('2026-03-02', false).schluss.join(' ').includes('§ 19'), false)
})

test('Produktbild aus dem lokalen Bildspeicher ohne Netz, Ersatzbild ohne Bild (Phase 5.2)', async (t) => {
  const os = require('node:os')
  const crypto = require('node:crypto')
  const L = require('../beleg-layout.js')
  const { belegPdf } = require('../beleg.js')
  const { createCanvas } = require('@napi-rs/canvas')
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'vendo-bilder-'))
  const altFetch = globalThis.fetch
  let netz = 0
  globalThis.fetch = async () => { netz++; throw new Error('kein Netz im Test') }
  t.after(() => { globalThis.fetch = altFetch; L.bildspeicherSetzen(null); fs.rmSync(ordner, { recursive: true, force: true }) })
  L.bildspeicherSetzen(ordner)
  const url = 'https://cdn.shopify.com/synthetisch/shirt.png'
  const c = createCanvas(96, 96); const k = c.getContext('2d'); k.fillStyle = '#336699'; k.fillRect(0, 0, 96, 96)
  fs.writeFileSync(path.join(ordner, `${crypto.createHash('sha256').update(url).digest('hex').slice(0, 32)}.png`), c.toBuffer('image/png'))
  profil.setzen(ANGABEN)
  const r = (bildUrl) => ({ referenz: '9700', datum: '2026-03-02', kleinunternehmer: true, versand: 0, rabatt: 0, offen: 0, summen: { mwstSatz: 0 }, positionen: [{ typ: 'artikel', bezeichnung: 'Synthetisches Shirt', menge: 1, einzelpreis: 10, gesamt: 10, bildUrl }] })
  const o = { createdAt: '2026-03-02T10:00:00Z', currentTotalPriceSet: { shopMoney: { amount: '10' } } }
  const mit = await belegPdf({ o, rechnung: r(`${url}?v=123`), version: 1, jsonSha: 'a'.repeat(64), abgerufen: '2026-11-19T10:00:00Z' })
  const ohne = await belegPdf({ o, rechnung: r(''), version: 1, jsonSha: 'a'.repeat(64), abgerufen: '2026-11-19T10:00:00Z' })
  assert.equal(netz, 0, 'Bild kam aus dem Speicher, kein Netzzugriff (Größenangaben in der URL zählen nicht)')
  const bilder = (pdf) => pdf.toString('latin1').split('/Subtype /Image').length - 1 // Logo (nur lokal vorhanden) zählt bei beiden
  assert.ok(bilder(mit) > bilder(ohne), 'Produktbild im PDF (mit Alphamaske als eigenes Objekt)')
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const d = await pdfjs.getDocument({ data: new Uint8Array(ohne), verbosity: 0 }).promise
  const teile = (await (await d.getPage(1)).getTextContent()).items
  assert.ok(teile.some((i) => i.str === 'kein Bild'), 'Ersatzbild')
  assert.equal(Math.round(teile.find((i) => i.str === 'Synthetisches Shirt').height * 10) / 10, 8.5, 'Zeile nach dem Ersatzbild in normaler Schrift (Fehlerbild der Vorschau vom 19.11.2026)')
})

test('Neufassung (Phase 5.3): Vermerk mit Grund und ersetzter Fassung auf dem echten PDF', async () => {
  const { belegPdf } = require('../beleg.js')
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  profil.setzen(ANGABEN)
  const r = { referenz: '9800', datum: '2024-04-02', kleinunternehmer: false, versand: 0, rabatt: 0, offen: 0, summen: { mwstSatz: 19, netto: 8.4, mwst: 1.6 }, positionen: [{ typ: 'artikel', bezeichnung: 'Synthetisches Shirt', menge: 1, einzelpreis: 10, gesamt: 10 }] }
  const pdf = await belegPdf({ o: { createdAt: '2024-04-02T10:00:00Z' }, rechnung: r, version: 1, jsonSha: 'a'.repeat(64), abgerufen: '2026-11-19T10:00:00Z', neufassung: { grund: 'Steuerausweis berichtigt.', ersetzt: 'b'.repeat(64), ersetztVom: '2026-10-28T23:24:05Z' } })
  const d = await pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0 }).promise
  const text = (await (await d.getPage(1)).getTextContent()).items.map((i) => i.str).join(' ').replace(/\s+/g, ' ')
  for (const teil of ['Neufassung vom', 'Steuerausweis berichtigt.', 'b'.repeat(64), 'bleibt unverändert im Belegarchiv', 'Version 1 · Neufassung', 'ENTHALTENE UST 19 %']) assert.ok(text.includes(teil), `fehlt: ${teil}`)
})
