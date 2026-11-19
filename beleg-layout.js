'use strict'
// Aussehen der Beleg-PDFs: Schrift, Farben und Abstände. Die Firmenangaben kommen seit Schritt 2.3 aus „Meine Angaben“
// (profil.firma(tag)) und werden als firma übergeben. WAS auf dem Beleg steht (Positionen, Summen, Hinweise), steht in beleg.js.

const PDFDocument = require('pdfkit')
const fs = require('node:fs')
const path = require('node:path')
const { loadImage, createCanvas } = require('@napi-rs/canvas')

const LOGO = path.join(__dirname, 'LOGO.png')
const SEITE = { links: 32, rechts: 563, breite: 531 }

const DESIGN = {
  rand: 50,
  rechts: 545, // rechte Kante des Textbereichs (A4 = 595 pt breit)
  seitenende: 700, // darunter beginnt eine neue Seite
  schrift: { normal: 'Helvetica', fett: 'Helvetica-Bold' },
  farben: { text: '#000000', leise: '#444444', grau: '#888888', linie: '#999999', fuss: '#666666', hinweis: '#555555' },
  groessen: { firma: 16, titel: 14, untertitel: 9, ueberschrift: 9, text: 9.5, summe: 9.5, summeFett: 11, klein: 8, fuss: 7 },
  // Tabellenspalten: Position | Menge | Einzelpreis | Gesamt
  spalten: [{ x: 50, w: 250, a: 'left' }, { x: 305, w: 45, a: 'right' }, { x: 355, w: 85, a: 'right' }, { x: 445, w: 100, a: 'right' }],
  summen: { labelX: 300, labelW: 150, wertX: 450, wertW: 95 }
}

const euro = (n) => Number(n || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }).replace(/\u00a0/g, ' ')
const datum = (iso) => (iso ? String(iso).split('-').reverse().join('.') : '–')
const uhr = (iso) => new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' })

// Neues Dokument. beenden(fussFn) schreibt auf jede Seite den Fuß und liefert das PDF als Buffer.
// fussFn(seite, anzahl) gibt zwei Textzeilen zurück.
function neuesDokument(info = {}, firma = {}) {
  const doc = new PDFDocument({
    size: 'A4', margin: DESIGN.rand, bufferPages: true,
    info: { Author: firma.name || '', Creator: 'Vendo', ...info }
  })
  const teile = []
  const fertig = new Promise((resolve, reject) => {
    doc.on('data', (c) => teile.push(c))
    doc.on('end', () => resolve(Buffer.concat(teile)))
    doc.on('error', reject)
  })
  const beenden = (fussFn) => {
    const n = doc.bufferedPageRange().count
    for (let i = 0; i < n; i++) {
      doc.switchToPage(i)
      doc.page.margins.bottom = 0 // sonst bricht pdfkit beim Schreiben im Fußbereich eine neue Seite um
      const [z1, z2] = fussFn(i + 1, n)
      doc.font(DESIGN.schrift.normal).fontSize(DESIGN.groessen.fuss).fillColor(DESIGN.farben.fuss)
      doc.text(z1, DESIGN.rand, 800, { width: DESIGN.rechts - DESIGN.rand, lineBreak: false })
      if (z2) doc.text(z2, DESIGN.rand, 810, { width: DESIGN.rechts - DESIGN.rand, lineBreak: false })
    }
    doc.end()
    return fertig
  }
  return { doc, beenden }
}

const S = DESIGN.schrift
const G = DESIGN.groessen
const F = DESIGN.farben

// Kopf: Firma, Titel, Untertitel
function kopf(doc, { titel, untertitel, firma }) {
  doc.font(S.fett).fontSize(G.firma).fillColor(F.text).text(firma.name)
  doc.font(S.normal).fontSize(G.untertitel).fillColor(F.leise)
  for (const z of firma.zeilen) doc.text(z)
  doc.moveDown(1.2)
  doc.font(S.fett).fontSize(G.titel).fillColor(F.text).text(titel)
  if (untertitel) doc.font(S.normal).fontSize(G.untertitel).fillColor(F.leise).text(untertitel)
  doc.moveDown(0.8)
}

// Block mit fetter Überschrift und Textzeilen (z. B. Kunde)
function block(doc, ueberschrift, zeilen) {
  const text = zeilen.filter(Boolean)
  if (!text.length) return
  doc.font(S.fett).fontSize(G.ueberschrift).fillColor(F.text).text(ueberschrift)
  doc.font(S.normal).fontSize(10).fillColor(F.text)
  for (const z of text) doc.text(z)
  doc.moveDown(0.8)
}

// Tabelle: kopf = ['Position', 'Menge', ...], zeilen = [{ zellen: [...], strike, grau }]
function tabelle(doc, kopfzeile, zeilen) {
  const sp = DESIGN.spalten
  const zeile = (zellen, { fett = false, strike = false, grau = false } = {}) => {
    doc.font(fett ? S.fett : S.normal).fontSize(G.text).fillColor(grau ? F.grau : F.text)
    const h = Math.max(...zellen.map((t, i) => doc.heightOfString(String(t), { width: sp[i].w })))
    if (doc.y + h > DESIGN.seitenende) doc.addPage()
    const y = doc.y
    zellen.forEach((t, i) => doc.text(String(t), sp[i].x, y, { width: sp[i].w, align: sp[i].a, strike }))
    doc.y = y + h + 4
    doc.x = DESIGN.rand
  }
  const linie = () => { doc.moveTo(DESIGN.rand, doc.y).lineTo(DESIGN.rechts, doc.y).strokeColor(F.linie).lineWidth(0.5).stroke() }
  zeile(kopfzeile, { fett: true })
  linie()
  doc.y += 4
  for (const z of zeilen) zeile(z.zellen, z)
  linie()
  doc.y += 8
}

// Summenzeilen rechts: [[Beschriftung, Betrag, fett?], ...]
function summen(doc, zeilen) {
  const s = DESIGN.summen
  for (const [label, wert, fett] of zeilen) {
    if (doc.y > DESIGN.seitenende + 20) doc.addPage()
    const y = doc.y
    doc.font(fett ? S.fett : S.normal).fontSize(fett ? G.summeFett : G.summe).fillColor(F.text)
    doc.text(label, s.labelX, y, { width: s.labelW })
    doc.text(euro(wert), s.wertX, y, { width: s.wertW, align: 'right' })
    doc.y = y + (fett ? 17 : 14)
    doc.x = DESIGN.rand
  }
  doc.moveDown(1)
}

// Fließtext: normal oder klein/grau (Hinweise)
function absatz(doc, text, { klein = false } = {}) {
  doc.font(S.normal).fontSize(klein ? G.klein : G.untertitel).fillColor(klein ? F.hinweis : F.text)
  doc.text(text, DESIGN.rand, doc.y, { width: DESIGN.rechts - DESIGN.rand })
  doc.moveDown(0.8)
}

// Kopf: Titel „UMSATZBELEG“ (interner Beleg, keine Rechnung an Kunden, Plan B3/8.7), rechts Bestellnummer, Bestelldatum
// und Ausstellungsdatum (B4). Vorbild „haben“: Nummer und Daten rechts im Kopf.
function rechnungsKopf(doc, { nummer, bestelldatum, erstellt, firma, titel = 'UMSATZBELEG' }) {
  if (fs.existsSync(LOGO)) doc.image(LOGO, SEITE.links, 24, { fit: [190, 46] })
  doc.font(S.fett).fontSize(9).fillColor(F.text).text(firma.name, 346, 24, { width: 217, align: 'right' })
  doc.font(S.normal).fontSize(8.5).fillColor(F.text)
  firma.zeilen.forEach((zeile) => doc.text(zeile, 346, doc.y, { width: 217, align: 'right', lineBreak: false }))

  doc.font(S.fett).fontSize(23).fillColor(F.text).text(titel, SEITE.links, 100, { width: 230 })
  const feld = (x, breite, titel, wert) => {
    doc.lineWidth(0.7).strokeColor(F.text).rect(x, 98, breite, 25).stroke()
    doc.font(S.fett).fontSize(8.5).fillColor(F.text).text(titel, x + 3, 106, { width: breite - 6, align: 'center', lineBreak: false })
    doc.font(S.normal).fontSize(9).text(wert || '–', x + 3, 130, { width: breite - 6, align: 'center', lineBreak: false })
  }
  feld(270, 94, 'BESTELLNUMMER', `#${nummer}`)
  feld(369, 94, 'BESTELLDATUM', bestelldatum)
  feld(468, 95, 'ERSTELLT AM', erstellt)
  doc.y = 174
}

function adressen(doc, bloecke) {
  const abstand = 16
  const breite = (SEITE.breite - abstand * 2) / 3
  const kopfY = doc.y
  for (let i = 0; i < bloecke.length; i++) {
    const x = SEITE.links + i * (breite + abstand)
    doc.lineWidth(0.7).strokeColor(F.text).rect(x, kopfY, breite, 24).stroke()
    doc.font(S.fett).fontSize(8.5).fillColor(F.text).text(bloecke[i].titel, x + 3, kopfY + 7, { width: breite - 6, align: 'center', lineBreak: false })
    doc.font(S.normal).fontSize(8.5).fillColor(F.text)
    let y = kopfY + 31
    for (const zeile of bloecke[i].zeilen.filter(Boolean).slice(0, 6)) {
      doc.text(zeile, x, y, { width: breite, lineBreak: false, ellipsis: true })
      y += 11
    }
  }
  doc.y = kopfY + 108
}

// Lokaler Bildspeicher (Phase 5.2): ein einmal geholtes Produktbild liegt als fertiges PNG auf dem PC. So entsteht ein Beleg
// auch ohne Netz und immer gleich (reproduzierbar). Schlüssel ist die Bild-URL ohne Größenangaben.
let bildspeicher = null
function bildspeicherSetzen(ordner) { bildspeicher = ordner || null }
const bildDatei = (url) => {
  const u = new URL(url)
  u.search = ''
  return path.join(bildspeicher, `${require('node:crypto').createHash('sha256').update(u.toString()).digest('hex').slice(0, 32)}.png`)
}
async function bildHolen(url) {
  if (!url) return null
  try {
    const adresse = new URL(url)
    if (adresse.protocol !== 'https:' || adresse.hostname !== 'cdn.shopify.com') return null
    if (bildspeicher) { try { return fs.readFileSync(bildDatei(url)) } catch { /* noch nicht im Speicher */ } }
    const png = await bildLaden(adresse)
    if (png && bildspeicher) { try { fs.mkdirSync(bildspeicher, { recursive: true }); fs.writeFileSync(bildDatei(url), png) } catch { /* Speicher nicht beschreibbar: Bild trotzdem nutzen */ } }
    return png
  } catch {
    return null
  }
}
// Ersatzbild, wenn es kein Produktbild gibt: neutrales Feld, damit alle Zeilen gleich aussehen
function ersatzbild(doc, x, y) {
  doc.save().lineWidth(0.5).strokeColor(F.linie).fillColor('#f2f2f2').roundedRect(x, y, 46, 46, 3).fillAndStroke().restore()
  doc.font(S.normal).fontSize(6).fillColor(F.grau).text('kein Bild', x, y + 20, { width: 46, align: 'center', lineBreak: false })
}
async function bildLaden(adresse) {
  try {
    adresse.searchParams.set('width', '120')
    const antwort = await fetch(adresse, { signal: AbortSignal.timeout(3500) })
    if (!antwort.ok || !(antwort.headers.get('content-type') || '').startsWith('image/')) return null
    const daten = Buffer.from(await antwort.arrayBuffer())
    if (daten.length > 2_000_000) return null
    const bild = await loadImage(daten)
    const canvas = createCanvas(96, 96)
    const kontext = canvas.getContext('2d')
    const skalierung = Math.min(88 / bild.width, 88 / bild.height)
    const breite = bild.width * skalierung
    const hoehe = bild.height * skalierung
    kontext.drawImage(bild, (96 - breite) / 2, (96 - hoehe) / 2, breite, hoehe)
    return canvas.toBuffer('image/png')
  } catch {
    return null
  }
}

// mwstText leer (Kleinunternehmer): keine Steuerspalte, wie bei „haben“ entfällt die Angabe „0 %“
async function artikelTabelle(doc, positionen, mwstText) {
  const bilder = await Promise.all(positionen.map((position) => bildHolen(position.bildUrl)))
  const spalten = [
    { x: 32, w: 230, a: 'left', titel: 'TITEL' },
    { x: 270, w: 70, a: 'left', titel: 'ART.-NR.' },
    { x: 345, w: 35, a: 'center', titel: 'MENGE' },
    { x: 383, w: 38, a: 'center', titel: mwstText ? 'MWST' : '' },
    { x: 426, w: 65, a: 'right', titel: 'EINZELPREIS' },
    { x: 496, w: 67, a: 'right', titel: 'GESAMT' }
  ]
  let y = doc.y
  doc.font(S.fett).fontSize(8).fillColor(F.text)
  for (const spalte of spalten) doc.text(spalte.titel, spalte.x, y, { width: spalte.w, align: spalte.a, height: 22 })
  y += 25
  const linie = (bei) => doc.moveTo(SEITE.links, bei).lineTo(SEITE.rechts, bei).lineWidth(0.55).strokeColor(F.linie).stroke()
  linie(y)
  y += 7

  for (const [index, position] of positionen.entries()) {
    const bild = bilder[index]
    const optionen = [position.farbe, position.groesse].filter(Boolean).map((wert) => `• ${wert}`).join('\n')
    const beschreibung = [position.bezeichnung, optionen].filter(Boolean).join('\n')
    doc.font(S.normal).fontSize(8.5).fillColor(F.text)
    const textX = spalten[0].x + 52 // Platz für Bild oder Ersatzbild in jeder Zeile
    const textBreite = spalten[0].w - 54
    const beschreibungHoehe = doc.heightOfString(beschreibung, { width: textBreite })
    const zeilenHoehe = Math.max(48, beschreibungHoehe, 20)
    if (y + zeilenHoehe > 680) { doc.addPage(); y = 48 }
    if (bild) doc.image(bild, spalten[0].x, y, { fit: [46, 46] })
    else ersatzbild(doc, spalten[0].x, y)
    doc.font(S.normal).fontSize(8.5).fillColor(F.text) // Ersatzbild nutzt kleine graue Schrift: für die Zeile zurücksetzen
    doc.text(beschreibung, textX, y, { width: textBreite })
    doc.text(position.artikelnummer || '', spalten[1].x, y, { width: spalten[1].w })
    doc.text(`x${position.menge}`, spalten[2].x, y, { width: spalten[2].w, align: spalten[2].a })
    doc.text(mwstText, spalten[3].x, y, { width: spalten[3].w, align: spalten[3].a })

    if (position.ursprungspreis && position.ursprungspreis > position.einzelpreis) {
      const alt = euro(position.ursprungspreis)
      doc.fontSize(7.5).fillColor(F.leise).text(alt, spalten[4].x, y, { width: spalten[4].w, align: 'right', lineBreak: false })
      const altBreite = doc.widthOfString(alt)
      doc.moveTo(spalten[4].x + spalten[4].w - altBreite, y + 4).lineTo(spalten[4].x + spalten[4].w, y + 4).lineWidth(0.5).strokeColor(F.leise).stroke()
      doc.font(S.normal).fontSize(8.5).fillColor(F.text).text(euro(position.einzelpreis), spalten[4].x, y + 10, { width: spalten[4].w, align: 'right' })
    } else {
      doc.font(S.normal).fontSize(8.5).fillColor(F.text).text(euro(position.einzelpreis), spalten[4].x, y, { width: spalten[4].w, align: 'right' })
    }
    doc.font(S.normal).fontSize(8.5).fillColor(F.text).text(euro(position.gesamt), spalten[5].x, y, { width: spalten[5].w, align: 'right' })
    y += zeilenHoehe + 10
    linie(y)
    y += 7
  }
  doc.y = y
}

// steuer: in der Regelbesteuerung [{ titel, wert }] (Netto und enthaltene USt je Satz, Bruttopreise wie im Shop)
function rechnungSummen(doc, { zahlungsart, rabatt, zwischensumme, versand, gesamt, bezahlt, offen, steuer = [] }) {
  const startY = Math.max(doc.y + 12, 430)
  if (startY > 675) doc.addPage()
  const y = startY > 675 ? 48 : startY
  doc.font(S.fett).fontSize(8.5).fillColor(F.text).text('BEZAHLVERFAHREN', SEITE.links, y + 4, { width: 220 })
  doc.font(S.normal).fontSize(8.5).text(zahlungsart || '–', SEITE.links, y + 23, { width: 220 })

  const zeilen = [
    ...(rabatt > 0 ? [['RABATT', -rabatt, false]] : []),
    ['ZWISCHENSUMME', zwischensumme, false],
    ['VERSAND', versand, false],
    ['GESAMT', gesamt, true],
    ...steuer.map((s) => [s.titel, s.wert, false]),
    ['BEZAHLT', bezahlt, false],
    ['OFFENER BETRAG', offen, false]
  ]
  const x = 340
  const breite = 223
  const hoehe = 22
  zeilen.forEach(([titel, wert, fett], i) => {
    const rowY = y + i * hoehe
    doc.lineWidth(fett ? 0.9 : 0.55).strokeColor(F.linie).rect(x, rowY, breite, hoehe).stroke()
    doc.font(fett ? S.fett : S.normal).fontSize(8.5).fillColor(F.text).text(titel, x + 7, rowY + 7, { width: 125, lineBreak: false })
    doc.text(`${wert < 0 ? '- ' : ''}${euro(Math.abs(wert || 0))}`, x + 132, rowY + 7, { width: 84, align: 'right', lineBreak: false })
  })
  doc.y = y + zeilen.length * hoehe + 18
}

function rechnungAbschluss(doc, firma) {
  const startY = Math.max(doc.y + 14, 590)
  doc.font(S.fett).fontSize(9).fillColor(F.text).text(firma.dankestext || 'Vielen Dank für deine Bestellung', SEITE.links, startY, { width: SEITE.breite, align: 'center' })
  doc.font(S.normal).fontSize(7.5).fillColor(F.text)
  const schlussY = Math.max(startY + 18, doc.y + 6) // mehrzeiliger Dankestext schiebt den Schluss nach unten
  firma.schluss.forEach((zeile, i) => doc.text(zeile, SEITE.links, schlussY + i * 10, { width: SEITE.breite, align: 'center', lineBreak: false }))
  doc.y = schlussY + 10 + Math.max(3, firma.schluss.length) * 10 // bei 3 Zeilen wie früher startY + 58
}

module.exports = { bildspeicherSetzen, DESIGN, euro, datum, uhr, neuesDokument, kopf, block, tabelle, summen, absatz, rechnungsKopf, adressen, artikelTabelle, rechnungSummen, rechnungAbschluss }
