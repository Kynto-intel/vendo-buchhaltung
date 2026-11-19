import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// Tests für den Shopify-Abgleich (bestellungen.js): zuRechnung seit Plan-Schritt 0.2, Ablage im Belegarchiv seit 1.5.
// Nur synthetische Bestellungen in einem Temp-Ordner. Shopify-API und Beleg-PDF sind Stubs:
// kein Netz, keine echten Daten, kein Zugriff auf den echten Belegordner.

const require = createRequire(import.meta.url)
const pluginFolder = path.resolve('.')
const parser = require('../parser.js')
const { archiv } = require('../archiv.js')

const profil = require('../profil.js')
const MEINE_ANGABEN = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/meine-angaben.json'), 'utf8'))
const geld = (amount) => ({ shopMoney: { amount: String(amount), currencyCode: 'EUR' } })

function bestellung(nr, overrides = {}) {
  return {
    id: `gid://synthetic/Order/${nr}`,
    name: `#${nr}`,
    createdAt: '2026-03-31T23:30:00Z', // in Berlin bereits der 01.04.2026
    updatedAt: '2026-04-01T08:00:00Z',
    cancelledAt: null,
    test: false,
    displayFinancialStatus: 'PAID',
    email: 'testkunde@example.test',
    paymentGatewayNames: ['synthetic_gateway'],
    currentTotalPriceSet: geld(44.9),
    totalPriceSet: geld(64.9),
    totalShippingPriceSet: geld(4.9),
    totalDiscountsSet: geld(5),
    totalRefundedSet: geld(0),
    netPaymentSet: geld(44.9),
    currentTotalTaxSet: geld(0),
    transactions: [{ kind: 'SALE', status: 'SUCCESS', test: false, processedAt: '2026-04-01T07:00:00Z', createdAt: '2026-04-01T07:00:00Z', gateway: 'synthetic_gateway', manualPaymentGateway: false, amountSet: geld(44.9) }],
    shippingAddress: { name: 'Test Kunde', address1: 'Teststraße 1', address2: null, zip: '10115', city: 'Berlin', countryCodeV2: 'DE' },
    billingAddress: null,
    refunds: [],
    shippingLines: { nodes: [{ originalPriceSet: geld(4.9), discountedPriceSet: geld(4.9) }] },
    lineItems: {
      pageInfo: { hasNextPage: false },
      nodes: [
        { title: 'Test-Shirt', variantTitle: 'Schwarz / M', variant: { sku: 'TST-1', image: null }, quantity: 2, currentQuantity: 2, originalUnitPriceSet: geld(22.5), discountedUnitPriceAfterAllDiscountsSet: geld(20) },
        { title: 'Test-Hoodie', variantTitle: 'Default Title', variant: { sku: 'TST-2', image: null }, quantity: 1, currentQuantity: 0, originalUnitPriceSet: geld(20), discountedUnitPriceAfterAllDiscountsSet: geld(20) }
      ]
    },
    ...overrides
  }
}

// Lädt bestellungen.js frisch mit Stubs. Temp-Aufbau je Test: <wurzel>/Rechnungen = Arbeitsordner mit Monatsordnern,
// <wurzel>/Vendo-Archiv = Belegarchiv (echtes archiv.js). optionen.schutz: Stub für den Windows-Schutz;
// optionen.belegFehler: Anzahl der ersten Beleg-PDF-Erzeugungen, die fehlschlagen (Abbruch simulieren).
function laden(seiten = [], { schutz = null, belegFehler = 0, einrichten = true, angaben = MEINE_ANGABEN, zahlungsDaten = {} } = {}) {
  profil.setzen(angaben) // Schritt 2.3: Belege nur mit vollständigen „Meine Angaben“
  const wurzel = fs.mkdtempSync(path.join(os.tmpdir(), 'vendo-rechnungen-test-'))
  const arbeit = path.join(wurzel, 'Rechnungen')
  const archivOrdner = path.join(wurzel, 'Vendo-Archiv')
  const abfragen = []
  const abfrageTexte = []
  const zahlungsAbfragen = [] // Schritt 4.1: Nachholen der Transaktionen älterer Originale (nodes(ids))
  const shopify = {
    API_VERSION: 'synthetic',
    async graphql(query, variablen) {
      abfrageTexte.push(query)
      if (variablen?.ids) { zahlungsAbfragen.push(variablen.ids); return { nodes: variablen.ids.map((id) => zahlungsDaten[id] ?? null) } }
      abfragen.push(variablen)
      const nodes = seiten.shift() || []
      return { orders: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } }
    }
  }
  let fehlschlaege = belegFehler
  const beleg = {
    async belegPdf({ o, version, jsonSha, neufassung }) {
      if (fehlschlaege-- > 0) throw new Error('synthetischer PDF-Fehler')
      return Buffer.from(`%PDF synthetic ${o.name} v${version} ${jsonSha}${neufassung ? ` Neufassung ersetzt ${neufassung.ersetzt}` : ''}`)
    }
  }
  const abhaengig = new Map([
    ['node:fs', fs], ['node:os', os], ['node:path', path], ['node:crypto', require('node:crypto')],
    ['./shopify', shopify], ['./beleg', beleg], ['./parser', parser], ['./geo', { finde: () => null }], ['./profil', profil]
  ])
  const vorher = process.env.VENDO_BELEGE
  process.env.VENDO_BELEGE = arbeit
  const modul = { exports: {} }
  try {
    const quelle = fs.readFileSync(path.join(pluginFolder, 'bestellungen.js'), 'utf8')
    new Function('require', 'module', 'exports', '__dirname', quelle)((name) => {
      if (!abhaengig.has(name)) throw new Error(`unerwartetes require: ${name}`)
      return abhaengig.get(name)
    }, modul, modul.exports, pluginFolder)
  } finally {
    if (vorher === undefined) delete process.env.VENDO_BELEGE
    else process.env.VENDO_BELEGE = vorher
  }
  let gespeichert = {}
  const stand = { lesen: () => structuredClone(gespeichert), schreiben: (s) => { gespeichert = structuredClone(s) } }
  const a = archiv(archivOrdner, { schutz })
  if (einrichten) modul.exports.einrichten({ archiv: a, stand })
  return { b: modul.exports, wurzel, arbeit, archivOrdner, a, abfragen, abfrageTexte, zahlungsAbfragen, seiten, stand }
}

function aufraeumen(wurzel) {
  const alle = (o) => fs.readdirSync(o, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? alle(path.join(o, d.name)) : [path.join(o, d.name)])
  if (!fs.existsSync(wurzel)) return
  for (const datei of alle(wurzel)) fs.chmodSync(datei, 0o666)
  fs.rmSync(wurzel, { recursive: true, force: true })
}


test('zuRechnung: Positionen, Rabatt, entfernte Artikel, Versand, Datum in Berlin, Kleinunternehmer', (t) => {
  const { b, wurzel } = laden()
  t.after(() => aufraeumen(wurzel))
  const r = b.zuRechnung(bestellung(9001), 1)

  assert.equal(r.rechnungsnummer, '#9001')
  assert.equal(r.datum, '2026-04-01', 'Datum muss in Europe/Berlin gerechnet werden')
  assert.equal(r.art, 'einnahme')
  const [shirt, hoodie, versand] = r.positionen
  assert.deepEqual([shirt.menge, shirt.einzelpreis, shirt.gesamt, shirt.ursprungspreis, shirt.farbe, shirt.groesse], [2, 20, 40, 22.5, 'Schwarz', 'M'])
  assert.equal(hoodie.entfernt, true)
  assert.equal(hoodie.farbe, undefined, '"Default Title" ist keine Variante')
  assert.deepEqual([versand.typ, versand.gesamt], ['versand', 4.9])
  assert.equal(r.anzahlPositionen, 2)
  assert.equal(r.anzahlEntfernt, 1)
  assert.equal(r.anzahlArtikel, 2)
  assert.equal(r.rabatt, 5)
  assert.equal(r.wirksam, 44.9)
  assert.equal(r.summen.mwst, 0, 'Kleinunternehmer: keine MwSt')
  assert.equal(r.pruefung.ok, true, r.pruefung.hinweise.join('; '))
})

test('zuRechnung: Erstattung, Teilzahlung, Fremdwährung, Gratisversand und Positionslimit erzeugen Hinweise bzw. Werte', (t) => {
  const { b, wurzel } = laden()
  t.after(() => aufraeumen(wurzel))

  const erstattet = b.zuRechnung(bestellung(9002, { displayFinancialStatus: 'PARTIALLY_REFUNDED', netPaymentSet: geld(34.9) }), 1)
  assert.equal(erstattet.wirksam, 34.9)
  assert.equal(erstattet.zusatzErstattung, 10)

  const teil = b.zuRechnung(bestellung(9003, { displayFinancialStatus: 'PARTIALLY_PAID', netPaymentSet: geld(20) }), 1)
  assert.equal(teil.offen, 24.9)

  const offen = b.zuRechnung(bestellung(9004, { displayFinancialStatus: 'PENDING' }), 1)
  assert.equal(offen.wirksam, 0, 'Nicht bezahlte Bestellung zählt nicht als Einnahme')

  const usd = b.zuRechnung(bestellung(9005, { netPaymentSet: { shopMoney: { amount: '44.90', currencyCode: 'USD' } } }), 1)
  assert.ok(usd.pruefung.hinweise.some((h) => /Währung USD/.test(h)))

  const gratis = b.zuRechnung(bestellung(9006, {
    currentTotalPriceSet: geld(40), netPaymentSet: geld(40),
    shippingLines: { nodes: [{ originalPriceSet: geld(4.9), discountedPriceSet: geld(0) }] }
  }), 1)
  const versand = gratis.positionen.find((p) => p.typ === 'versand')
  assert.deepEqual([versand.bezeichnung, versand.gesamt, versand.ursprungspreis], ['Versand (rabattiert)', 0, 4.9])

  const viele = bestellung(9007)
  viele.lineItems.pageInfo.hasNextPage = true
  assert.ok(b.zuRechnung(viele, 1).pruefung.hinweise.some((h) => /Mehr als 25 Positionen/.test(h)))
})

// ---------- Ab Schritt 1.5: Ablage im zentralen Belegarchiv ----------
const ohneHash = (datei) => datei.replace(/__[0-9a-f]{12}(\.[a-z]+)$/, '$1')
const alleDateien = (o) => fs.existsSync(o) ? fs.readdirSync(o, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? alleDateien(path.join(o, d.name)) : [path.join(o, d.name)]) : []

test('Abgleich legt Original und Beleg im Archiv ab, Ansichtskopie im Monatsordner, versioniert Änderungen (Schritt 1.5)', async (t) => {
  const geaendert = bestellung(9010, { updatedAt: '2026-04-02T09:00:00Z', netPaymentSet: geld(40) })
  const { b, wurzel, arbeit, a, abfragen, stand } = laden([
    [bestellung(9010), bestellung(9011, { test: true })],
    [bestellung(9010)], // unverändert
    [geaendert]
  ])
  t.after(() => aufraeumen(wurzel))

  const erst = await b.abgleichen()
  assert.deepEqual([erst.neu, erst.geaendert, erst.gesehen, erst.hinweise], [1, 0, 1, undefined])
  assert.equal(abfragen[0].q, null, 'Erster Lauf holt alles')
  const e = a.eintraege()
  assert.deepEqual(e.map((x) => [x.art, ohneHash(x.datei), x.meta]), [
    ['shopify-original', '2026/shopify-original/Shopify Bestellung 9010 v1.json', { quelle: 'shopify-api', bestellung: '9010', version: 1 }],
    ['umsatzbeleg', '2026/umsatzbeleg/Umsatzbeleg Bestellung 9010.pdf', { quelle: 'shopify-api', bestellung: '9010', version: 1 }]
  ])
  const original = JSON.parse(fs.readFileSync(a.pfad(e[0]), 'utf8'))
  assert.equal(original.bestellung.name, '#9010')
  assert.equal(fs.readFileSync(a.pfad(e[1]), 'utf8').includes(e[0].sha256), true, 'Beleg nennt den Hash des Originals')
  const kopie = path.join(arbeit, '2026', '04 - April', 'Shopify Rechnungen', 'Umsatzbeleg Bestellung 9010.pdf')
  assert.deepEqual(fs.readFileSync(kopie), fs.readFileSync(a.pfad(e[1])), 'Ansichtskopie = Archivbeleg')
  assert.deepEqual(alleDateien(arbeit), [kopie], 'im Arbeitsordner nur die Ansichtskopie, kein altes _Vendo-Archiv mehr')
  assert.equal(stand.lesen().seit, '2026-04-01T08:00:00Z', 'Abgleichstand im Plugin-Speicher')

  const zweit = await b.abgleichen()
  assert.deepEqual([zweit.neu, zweit.geaendert], [0, 0])
  assert.equal(abfragen[1].q, "updated_at:>='2026-04-01T08:00:00Z'", 'Folgelauf holt nur Neues/Geändertes')
  assert.equal(a.eintraege().length, 2)

  const dritt = await b.abgleichen()
  assert.equal(dritt.geaendert, 1)
  assert.deepEqual(a.eintraege().slice(2).map((x) => [ohneHash(x.datei), x.meta.version]), [
    ['2026/shopify-original/Shopify Bestellung 9010 v2.json', 2], ['2026/umsatzbeleg/Umsatzbeleg Bestellung 9010 (Version 2).pdf', 2]])
  assert.ok(fs.existsSync(path.join(arbeit, '2026', '04 - April', 'Shopify Rechnungen', 'Umsatzbeleg Bestellung 9010 (Version 2).pdf')))
  assert.ok(fs.existsSync(a.pfad(e[0])), 'Version 1 bleibt erhalten')

  const liste = b.eintraege()
  assert.equal(liste.length, 1)
  assert.deepEqual([liste[0].id, liste[0].beleg.version, liste[0].rechnung.wirksam], ['s9010', 2, 40])
  assert.equal(b.pdfPfad('s9010'), a.pfad(a.eintraege()[3]), 'Öffnen zeigt den Archivbeleg')
  assert.throws(() => b.pdfPfad('s9999'), /nicht gefunden/)
  assert.throws(() => b.pdfPfad('../x'), /nicht gefunden/)

  const pruefung = a.integritaet()
  assert.deepEqual([pruefung.ok, pruefung.geprueft], [true, 4], pruefung.fehler.join('; '))
})

test('Migrierte Belege werden gelesen und fortgeführt: gleiche Fassung bleibt, Änderung wird Version 2 (Schritt 1.5)', async (t) => {
  const alt = bestellung(9050, { createdAt: '2025-06-01T10:00:00Z', updatedAt: '2025-06-02T10:00:00Z' })
  const { b, wurzel, a } = laden([[alt], [{ ...alt, updatedAt: '2026-01-05T10:00:00Z' }]])
  t.after(() => aufraeumen(wurzel))
  // so legt migration.umziehen den Altbestand ab (Schritt 1.4)
  const json = a.ablegen(Buffer.from(JSON.stringify({ meta: { quelle: 'Shopify Admin GraphQL API', abgerufen: '2025-06-03T00:00:00Z' }, bestellung: alt })), { art: 'shopify-original', jahr: 2025, name: 'Shopify Bestellung 9050 v1.json', meta: { quelle: 'migration', bestellung: '9050', version: 1 } })
  a.ablegen(Buffer.from('%PDF migrierter Beleg 9050'), { art: 'umsatzbeleg', jahr: 2025, name: 'Umsatzbeleg Bestellung 9050.pdf', meta: { quelle: 'migration', bestellung: '9050', version: 1 } })

  const liste = b.eintraege()
  assert.deepEqual([liste.length, liste[0].id, liste[0].beleg.version, liste[0].scanStand], [1, 's9050', 1, Date.parse('2025-06-03T00:00:00Z')])
  assert.equal(liste[0].beleg.sha256, json.sha256)
  const erst = await b.abgleichen()
  assert.deepEqual([erst.neu, erst.geaendert, a.eintraege().length], [0, 0, 2], 'unveränderte migrierte Bestellung wird nicht neu abgelegt')
  const zweit = await b.abgleichen()
  assert.equal(zweit.geaendert, 1)
  assert.deepEqual(a.eintraege().slice(2).map((x) => [x.art, x.meta.version, x.jahr]), [['shopify-original', 2, 2025], ['umsatzbeleg', 2, 2025]])
  assert.equal(a.integritaet().ok, true)
})

test('Abbruch zwischen Original und Beleg: nächster Abgleich erzeugt den Beleg aus dem archivierten Original (Schritt 1.5)', async (t) => {
  const { b, wurzel, a, stand } = laden([[bestellung(9030)], [bestellung(9030)]], { belegFehler: 1 })
  t.after(() => aufraeumen(wurzel))
  await assert.rejects(b.abgleichen(), /synthetischer PDF-Fehler/)
  assert.deepEqual(a.eintraege().map((x) => x.art), ['shopify-original'])
  assert.equal(stand.lesen().seit, undefined, 'Abgleichstand nicht weitergesetzt')
  assert.throws(() => b.pdfPfad('s9030'), /nicht gefunden/)

  const erg = await b.abgleichen()
  assert.deepEqual([erg.pdfNeu, erg.neu, erg.geaendert], [1, 0, 0])
  assert.deepEqual(a.eintraege().map((x) => [x.art, x.meta.version]), [['shopify-original', 1], ['umsatzbeleg', 1]])
  assert.equal(fs.readFileSync(b.pdfPfad('s9030'), 'utf8').includes(a.eintraege()[0].sha256), true)
  assert.equal(a.integritaet().ok, true)
})

test('Ansichtskopien: Verschieben/Löschen stört das Archiv nicht, fremde gleichnamige Dateien werden nie überschrieben (Schritt 1.5)', async (t) => {
  const { b, wurzel, arbeit, a } = laden([[bestellung(9040, { createdAt: '2026-05-10T10:00:00Z' }), bestellung(9041, { createdAt: '2026-05-11T10:00:00Z' })]])
  t.after(() => aufraeumen(wurzel))
  const ordner = path.join(arbeit, '2026', '05- Mai', 'shopify rechnungen') // abweichende Schreibweise
  fs.mkdirSync(ordner, { recursive: true })
  fs.writeFileSync(path.join(ordner, 'Umsatzbeleg Bestellung 9041.pdf'), 'eigene Datei des Nutzers')
  const erg = await b.abgleichen()
  assert.ok(fs.existsSync(path.join(ordner, 'Umsatzbeleg Bestellung 9040.pdf')), 'vorhandener Ordner wird wiederverwendet')
  assert.equal(fs.readFileSync(path.join(ordner, 'Umsatzbeleg Bestellung 9041.pdf'), 'utf8'), 'eigene Datei des Nutzers')
  assert.deepEqual(erg.hinweise, ['Ansichtskopie Umsatzbeleg Bestellung 9041.pdf: Name im Monatsordner schon vergeben'])
  assert.equal(a.eintraege().length, 4, 'trotzdem vollständig archiviert')

  fs.rmSync(path.join(ordner, 'Umsatzbeleg Bestellung 9040.pdf'))
  assert.equal(a.integritaet().ok, true, 'Löschen der Ansichtskopie berührt das Archiv nicht')
  assert.ok(fs.existsSync(b.pdfPfad('s9040')))
  assert.equal(b.eintraege().length, 2)
})

test('Schutz wird je Abgleich einmal gesammelt gesetzt; ohne Archiv gibt es eine klare Fehlermeldung (Schritt 1.5)', async (t) => {
  const aufrufe = []
  const { b, wurzel, a } = laden([[bestellung(9060), bestellung(9061)], []], { schutz: { schuetzen(z) { aufrufe.push(z); return { erfolgreich: true } } } })
  t.after(() => aufraeumen(wurzel))
  await b.abgleichen()
  assert.equal(aufrufe.length, 1, 'ein Aufruf statt einer je Datei')
  assert.deepEqual(aufrufe[0].dateien, a.eintraege().map((x) => a.pfad(x)))
  assert.deepEqual(aufrufe[0].nurLoeschen, [a.INDEX])
  await b.abgleichen()
  assert.equal(aufrufe.length, 1, 'nichts Neues → kein Schutzaufruf')

  const { b: leer, wurzel: w2 } = laden([], { einrichten: false })
  t.after(() => aufraeumen(w2))
  assert.throws(() => leer.eintraege(), /Belegarchiv ist nicht eingerichtet/)
  await assert.rejects(leer.abgleichen(), /Belegarchiv ist nicht eingerichtet/)
  assert.throws(() => leer.einrichten({}), /Kein Belegarchiv/)
})

test('Alter Archivcode ist entfernt (Schritt 1.5)', () => {
  const quelle = fs.readFileSync(path.join(pluginFolder, 'bestellungen.js'), 'utf8')
  assert.equal(/_Vendo-Archiv|zuruecksetzen|index\.jsonl|sync\.json/.test(quelle.replace(/^\/\/.*$/gm, '')), false)
  const { b, wurzel } = laden()
  aufraeumen(wurzel)
  assert.deepEqual(Object.keys(b).sort(), ['WURZEL', 'abgleichen', 'ansichtsKopie', 'belegOrdner', 'beschaeftigt', 'einrichten', 'eintraege', 'neuBerechnen', 'neufassungErzeugen', 'neufassungPlanen', 'neufassungVorschau', 'orte', 'pdfPfad', 'steuerBefund', 'warten', 'zahlungAus', 'zuRechnung'])
})

test('steuerBefund: Shopify-Steuer je Bestellung aus der neuesten Archivfassung, Berliner Tag, ohne Kundendaten (Schritt 2.2)', async (t) => {
  const mitSteuer = bestellung(9070, { createdAt: '2024-04-02T22:30:00Z', updatedAt: '2024-04-03T08:00:00Z', currentTotalPriceSet: geld(23.8), netPaymentSet: geld(23.8), currentTotalTaxSet: geld(3.8) })
  const ohne = bestellung(9071, { createdAt: '2024-06-01T10:00:00Z', updatedAt: '2024-06-01T11:00:00Z' })
  const storniert = bestellung(9072, { createdAt: '2024-05-01T10:00:00Z', updatedAt: '2024-05-01T11:00:00Z', cancelledAt: '2024-05-02T10:00:00Z', currentTotalTaxSet: geld(1.9) })
  const { b, wurzel } = laden([[mitSteuer, ohne, storniert], [{ ...mitSteuer, updatedAt: '2024-04-10T08:00:00Z', currentTotalPriceSet: geld(11.9), currentTotalTaxSet: geld(1.9) }]])
  t.after(() => aufraeumen(wurzel))
  await b.abgleichen()
  const sortiert = () => b.steuerBefund().sort((x, y) => x.nr.localeCompare(y.nr))
  assert.deepEqual(sortiert(), [
    { nr: '9070', datum: '2024-04-03', steuer: 3.8, brutto: 23.8, storniert: false },
    { nr: '9071', datum: '2024-06-01', steuer: 0, brutto: 44.9, storniert: false },
    { nr: '9072', datum: '2024-05-01', steuer: 1.9, brutto: 44.9, storniert: true }
  ])
  assert.equal(JSON.stringify(b.steuerBefund()).includes('Test Kunde'), false, 'keine Namen/Adressen')
  await b.abgleichen() // Teilerstattung: neue Version mit weniger Steuer
  assert.deepEqual(sortiert()[0], { nr: '9070', datum: '2024-04-03', steuer: 1.9, brutto: 11.9, storniert: false }, 'neueste Version zählt')
  const frisch = laden([], { einrichten: false })
  t.after(() => aufraeumen(frisch.wurzel))
  frisch.b.einrichten({ archiv: archiv(path.join(wurzel, 'Vendo-Archiv')), stand: frisch.stand })
  assert.equal(frisch.b.steuerBefund().find((x) => x.nr === '9070').steuer, 1.9, 'auch nach Neustart aus den Archivdateien gelesen')
})

test('Ohne vollständige „Meine Angaben“ kein Umsatzbeleg: Original im Archiv, Hinweis, Beleg wird danach nachgeholt (Schritt 2.3)', async (t) => {
  const { b, wurzel, a } = laden([[bestellung(9080)], []], { angaben: { steuerzeitraeume: MEINE_ANGABEN.steuerzeitraeume } })
  t.after(() => aufraeumen(wurzel))
  const erst = await b.abgleichen()
  assert.deepEqual([erst.neu, erst.pdfNeu], [1, 0])
  assert.deepEqual(a.eintraege().map((x) => x.art), ['shopify-original'], 'nur das Original, kein Beleg')
  assert.match(erst.hinweise.join(' '), /1 Umsatzbeleg\(e\) warten auf „Meine Angaben“/)
  assert.equal(b.eintraege()[0].beleg, undefined)
  assert.throws(() => b.pdfPfad('s9080'), /nicht gefunden/)

  profil.setzen(MEINE_ANGABEN)
  b.neuBerechnen()
  const zweit = await b.abgleichen()
  assert.deepEqual([zweit.neu, zweit.pdfNeu, zweit.hinweise], [0, 1, undefined])
  assert.deepEqual(a.eintraege().map((x) => x.art), ['shopify-original', 'umsatzbeleg'])
  assert.ok(b.eintraege()[0].beleg, 'Beleg jetzt vorhanden')
})

test('zahlungAus: Geldeingang = erste erfolgreiche SALE/CAPTURE, Erstattungen, Berliner Tag, Test/Fehlschlag zählen nicht (Schritt 4.1)', () => {
  const { b, wurzel } = laden()
  try {
    const t = (kind, processedAt, betrag, extra = {}) => ({ kind, status: 'SUCCESS', test: false, processedAt, createdAt: processedAt, gateway: 'synthetic_gateway', manualPaymentGateway: false, amountSet: geld(betrag), ...extra })
    const z = b.zahlungAus([
      t('AUTHORIZATION', '2024-03-30T10:00:00Z', 50),
      t('CAPTURE', '2024-12-31T23:30:00Z', 30), // Berlin: 01.01.2025
      t('SALE', '2024-12-31T22:30:00Z', 20), // Berlin: 31.12.2024 23:30 → erster Eingang
      t('SALE', '2024-12-30T10:00:00Z', 99, { status: 'FAILURE' }),
      t('SALE', '2024-12-29T10:00:00Z', 99, { test: true }),
      t('REFUND', '2025-01-10T09:00:00Z', 5)
    ])
    assert.deepEqual([z.datum, z.eingaenge.map((e) => [e.datum, e.betrag]), z.erstattungen.map((e) => [e.datum, e.betrag]), z.manuell], ['2024-12-31', [['2024-12-31', 20], ['2025-01-01', 30]], [['2025-01-10', 5]], false])
    assert.equal(b.zahlungAus([t('SALE', '2024-05-02T08:00:00Z', 10, { gateway: 'Bank Deposit', manualPaymentGateway: true })]).manuell, true, 'Überweisung erkannt')
    assert.deepEqual(b.zahlungAus([]), { datum: null, eingaenge: [], erstattungen: [], manuell: false }, 'noch nicht bezahlt')
    assert.equal(b.zahlungAus(undefined), null, 'keine Transaktionen bekannt')
    const r = b.zuRechnung(bestellung(9090, { transactions: [t('SALE', '2026-04-02T09:00:00Z', 44.9, { gateway: 'viva' })] }), 1)
    assert.deepEqual([r.datum, r.zahlung.datum, r.zahlung.art, r.zahlung.bekannt, r.zahlung.bezahlt], ['2026-04-01', '2026-04-02', 'viva', true, true], 'Bestelldatum bleibt, Zahlungsdatum kommt dazu')
    const ohne = b.zuRechnung(bestellung(9091, { transactions: undefined }), 1)
    assert.deepEqual([ohne.zahlung.datum, ohne.zahlung.bekannt, ohne.zahlung.art], [null, false, 'synthetic_gateway'])
  } finally { aufraeumen(wurzel) }
})

test('Ältere Originale ohne Transaktionen: Zahlungen werden einmal nachgeholt und eigenständig archiviert, Original und Beleg bleiben (Schritt 4.1)', async (t) => {
  const alt = bestellung(9095, { createdAt: '2024-05-10T10:00:00Z', updatedAt: '2024-05-11T10:00:00Z', transactions: undefined })
  const fehlt = bestellung(9096, { createdAt: '2024-06-10T10:00:00Z', updatedAt: '2024-06-11T10:00:00Z', transactions: undefined })
  const zahlung = { kind: 'SALE', status: 'SUCCESS', test: false, processedAt: '2024-05-12T08:00:00Z', createdAt: '2024-05-12T08:00:00Z', gateway: 'Bank Deposit', manualPaymentGateway: true, amountSet: geld(44.9) }
  const { b, wurzel, a, zahlungsAbfragen, abfrageTexte } = laden([[alt, fehlt], [], []], { zahlungsDaten: { [alt.id]: { id: alt.id, name: alt.name, transactions: [zahlung] } } })
  t.after(() => aufraeumen(wurzel))
  // so liegen die 413 vorhandenen Bestellungen im Archiv: Original + Beleg ohne Transaktionen
  for (const o of [alt, fehlt]) {
    const nr = o.name.slice(1)
    a.ablegen(Buffer.from(JSON.stringify({ meta: { quelle: 'Shopify Admin GraphQL API', abgerufen: '2024-06-12T00:00:00Z' }, bestellung: o })), { art: 'shopify-original', jahr: 2024, name: `Shopify Bestellung ${nr} v1.json`, meta: { quelle: 'migration', bestellung: nr, version: 1 } })
    a.ablegen(Buffer.from(`%PDF migrierter Beleg ${nr}`), { art: 'umsatzbeleg', jahr: 2024, name: `Umsatzbeleg Bestellung ${nr}.pdf`, meta: { quelle: 'migration', bestellung: nr, version: 1 } })
  }
  assert.equal(b.eintraege().find((e) => e.id === 's9095').rechnung.zahlung.bekannt, false)

  const erst = await b.abgleichen()
  assert.deepEqual([erst.neu, erst.geaendert, erst.pdfNeu, erst.zahlungenNeu], [0, 0, 0, 1])
  assert.deepEqual(zahlungsAbfragen, [[alt.id, fehlt.id]], 'eine gebündelte Abfrage mit den Shopify-IDs')
  const transaktionen = 'transactions(first: 30) { kind status test processedAt createdAt gateway manualPaymentGateway amountSet'
  assert.ok(abfrageTexte[0].includes('orders(') && abfrageTexte[0].includes(transaktionen), 'Bestellabfrage holt die Transaktionen mit')
  assert.ok(abfrageTexte[1].includes('nodes(ids: $ids)') && abfrageTexte[1].includes('... on Order') && abfrageTexte[1].includes(transaktionen), 'Nachholabfrage')
  assert.deepEqual(a.eintraege().slice(4).map((x) => [x.art, x.jahr, x.meta]), [['shopify-zahlungen', 2024, { quelle: 'shopify-api', bestellung: '9095', version: 1 }]], 'nur eine Zahlungsdatei, keine neue Version, kein neuer Beleg')
  assert.match(erst.hinweise.join(' '), /Zahlungsdatum für 1 Bestellung\(en\) nicht gefunden/)
  const z = b.eintraege().find((e) => e.id === 's9095').rechnung.zahlung
  assert.deepEqual([z.datum, z.manuell, z.art, z.bekannt], ['2024-05-12', true, 'Bank Deposit', true])

  const zweit = await b.abgleichen()
  assert.deepEqual(zahlungsAbfragen.at(-1), [fehlt.id], 'bekannte Zahlungen werden nicht erneut geholt')
  assert.equal(zweit.zahlungenNeu, 0)

  const neu = laden([], { einrichten: false }) // Neustart: aus den Archivdateien gelesen
  t.after(() => aufraeumen(neu.wurzel))
  neu.b.einrichten({ archiv: archiv(path.join(wurzel, 'Vendo-Archiv')), stand: neu.stand })
  assert.equal(neu.b.eintraege().find((e) => e.id === 's9095').rechnung.zahlung.datum, '2024-05-12')
  assert.equal(a.integritaet().ok, true)
})

test('Produktbild (Phase 5.2): Variante vor Artikel vor Produkt; ohne Bild leer; Abfrage fragt Ersatzbilder mit ab', (t) => {
  const { b, wurzel, abfrageTexte } = laden()
  t.after(() => aufraeumen(wurzel))
  const url = (n) => `https://cdn.shopify.com/synthetisch/${n}.png`
  const li = (extra) => ({ title: 'Probe', variantTitle: 'Default Title', quantity: 1, currentQuantity: 1, originalUnitPriceSet: geld(10), discountedUnitPriceAfterAllDiscountsSet: geld(10), variant: { sku: 'P-1', image: null }, ...extra })
  const pos = (x) => b.zuRechnung(bestellung(9500, { lineItems: { pageInfo: { hasNextPage: false }, nodes: [li(x)] } }), 1).positionen[0]
  assert.equal(pos({ variant: { sku: 'P-1', image: { url: url('v') } }, image: { url: url('a') } }).bildUrl, url('v'))
  assert.equal(pos({ image: { url: url('a') }, product: { featuredMedia: { preview: { image: { url: url('p') } } } } }).bildUrl, url('a'))
  assert.equal(pos({ product: { featuredMedia: { preview: { image: { url: url('p') } } } } }).bildUrl, url('p'))
  assert.equal(pos({}).bildUrl, '') // ohne Bild: Ersatzbild auf dem Beleg
  void abfrageTexte
})

test('Neufassung (Phase 5.3): nur Belege mit falschem Steuerausweis, alte Fassung bleibt, Protokoll im Archiv, danach nichts mehr offen', async (t) => {
  const regel = bestellung(9601, { createdAt: '2024-04-02T10:00:00Z', updatedAt: '2024-04-02T11:00:00Z', currentTotalTaxSet: geld(7.17) })
  const { b, wurzel, a } = laden([[bestellung(9600), regel]])
  t.after(() => aufraeumen(wurzel))
  await b.abgleichen()
  assert.deepEqual(b.neufassungPlanen(), { steuer: [], steuerSumme: 0 }, 'frisch erzeugte Belege haben schon den richtigen Steuerausweis')
  await new Promise((r) => setTimeout(r, 5))
  const grenze = { steuerstatusSeit: Date.now() } // so tun, als wären die Belege vor dem Steuerstatus erzeugt worden
  await new Promise((r) => setTimeout(r, 5))
  const plan = b.neufassungPlanen(grenze)
  assert.deepEqual([plan.steuer.map((x) => x.nr), plan.steuerSumme], [['9601'], 7.17])
  const vorher = a.eintraege()
  const altPdf = vorher.find((e) => e.art === 'umsatzbeleg' && e.meta.bestellung === '9601')
  const v = await b.neufassungVorschau(grenze)
  assert.deepEqual([v.nr, v.anzahl, a.eintraege().length], ['9601', 1, vorher.length], 'Vorschau legt nichts ab')
  assert.match(v.pdf.toString(), new RegExp(`Neufassung ersetzt ${altPdf.sha256}`))
  const erg = await b.neufassungErzeugen(grenze)
  assert.equal(erg.anzahl, 1)
  const nachher = a.eintraege()
  assert.equal(nachher.length, vorher.length + 2, 'Neufassung + Protokoll')
  assert.ok(nachher.some((e) => e.sha256 === altPdf.sha256), 'alte Fassung bleibt im Archiv')
  const neu = nachher.find((e) => e.meta?.quelle === 'neufassung')
  assert.deepEqual([neu.art, neu.meta.bestellung, neu.meta.ersetzt], ['umsatzbeleg', '9601', altPdf.sha256])
  const pr = JSON.parse(fs.readFileSync(a.pfad(nachher.find((e) => e.art === 'protokoll')), 'utf8'))
  assert.deepEqual([pr.anzahl, pr.belege[0].bestellung, pr.belege[0].alt.sha256, pr.belege[0].neu.sha256], [1, '9601', altPdf.sha256, neu.sha256])
  assert.equal(b.eintraege().find((e) => e.id === 's9601').beleg.pdf, neu.datei, 'Anzeige nutzt die Neufassung')
  assert.deepEqual(b.neufassungPlanen(grenze).steuer, [], 'danach nichts mehr offen')
  assert.ok(a.integritaet().ok, 'Hash-Kette intakt')
})
