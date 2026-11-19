'use strict'
// Rechnungs-Parser: macht aus dem ausgelesenen Text (PDF-Textlayer oder OCR) strukturierte Daten.
// Aufbau: Anbieter-Profile (genau) + allgemeiner Fallback (grob, wird als "unsicher" markiert).
// Neuer Anbieter = neue Funktion unten + Eintrag in PROFILE.

// Wer bist du? Seit Schritt 2.3 aus „Meine Angaben“ (profil.js): Rechnungen VON den eigenen Namen sind Einnahmen,
// alle anderen Ausgaben; die eigenen Shop-Profile unten sind immer Einnahmen.
// Ausgaben zählen brutto, solange keine Vorsteuer abgezogen wird (Kleinunternehmer, und laut Nutzer auch nie in der
// Regelbesteuerung – profil.vorsteuerAbziehbarAm). Sonst netto.
const eigene = require('./profil') // „eigene“, weil profil unten schon das Anbieter-Profil heißt
const VERSION = 6 // erhöhen, wenn sich die Auswertung ändert: Vendo wertet gespeicherte Texte dann automatisch neu aus

const G = '(\\d{1,3}(?:\\.\\d{3})*,\\d{2}|\\d+,\\d{2})' // 1.234,56 oder 36,00
const GN = '(-?\\d{1,3}(?:\\.\\d{3})*,\\d{2}|-?\\d+,\\d{2})' // mit optionalem Minus
const MONATE = { jan: 1, feb: 2, mar: 3, mär: 3, apr: 4, mai: 5, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, dez: 12, dec: 12 }

const zahl = (s) => Math.round(parseFloat(String(s).replace(/\./g, '').replace(',', '.')) * 100) / 100
const rund = (n) => Math.round(n * 100) / 100
const re = (teil, flags = '') => new RegExp(teil.replaceAll('{G}', G).replaceAll('{GN}', GN), flags)
const iso = (j, m, t) => `${j}-${String(m).padStart(2, '0')}-${String(t).padStart(2, '0')}`
const deDatum = (s) => { const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s || ''); return m ? iso(m[3], m[2], m[1]) : null }
const monat = (name) => MONATE[String(name).toLowerCase().slice(0, 3)] || null

function vorbereiten(rohtext) {
  const mitMarken = String(rohtext).replace(/\r/g, '').replace(/\u00a0/g, ' ').replace(/^--- Seite \d+ ---$/gm, '')
  // ~~Text~~ markiert durchgestrichenen Text (siehe textlayer.js); für alle normalen Profile entfernen
  const text = mitMarken.replace(/~~/g, '')
  const zeilen = text.split('\n').map((z) => z.replace(/[ \t]+/g, ' ').trim()).filter(Boolean)
  return { text, mitMarken, zeilen, flach: zeilen.join(' ') }
}

// Wörter mit Durchstreich-Flag (für Profile, die entfernte Artikel erkennen müssen)
function tokenisieren(mitMarken) {
  const tok = []
  mitMarken.split('~~').forEach((teil, i) => { for (const w of teil.split(/\s+/)) if (w) tok.push({ w, d: i % 2 === 1 }) })
  return tok
}

// ---------- Shirtigo (Druck-/Produktionsrechnung, Preise netto) ----------
function shirtigo({ text, flach }) {
  const r = { anbieter: 'shirtigo', lieferant: 'Shirtigo GmbH', waehrung: 'EUR', preisart: 'netto', positionen: [] }
  r.rechnungsnummer = /Rechnungs-Nr\.\s*([\d-]+)/.exec(flach)?.[1] || null
  r.datum = deDatum(/Datum:\s*(\d{2}\.\d{2}\.\d{4})/.exec(flach)?.[1])
  r.bestellnummer = /Bestell-Nr:\s*([A-Z0-9]+)/.exec(flach)?.[1] || /\*O-([A-Z0-9]+)\*/.exec(flach)?.[1] || null // alt: "Bestell-Nr:", neu: nur im Barcode
  r.referenz = /(?:Ihre\s+)?Referenz:\s*(\S+)/.exec(flach)?.[1] || null // = deine Shopify-Bestellnummer (alt: "Ihre Referenz:", neu: "Referenz:")
  // Lieferadresse: optional Firmenzeile, dann Name, Straße, "PLZ Ort"
  const adr = /Lieferadresse:\s*\n((?:[^\n]+\n){2,4}?)(\d{5})\s+([^\n]+)/.exec(text.replace(/\r/g, ''))
  if (adr) {
    const z = adr[1].trim().split('\n').map((x) => x.trim())
    r.empfaenger = { name: z.length > 1 ? z[z.length - 2] : z[0], firma: z.length > 2 ? z[0] : undefined, strasse: z.at(-1), plz: adr[2], ort: adr[3].trim() }
  }

  // Seitenfuss (Firmendaten) mitten im Positionsbereich entfernen
  const sauber = flach.replace(/Rechnung \d{4}-\d+, Seite \d+ von \d+ Shirtigo GmbH.*?DEUTDEDBKOE/g, ' ')
  const start = sauber.search(/Menge \(\d+\)\s*Einzelpreis\s*Gesamtpreis/)
  let bereich = start >= 0 ? sauber.slice(start).replace(/^.*?Gesamtpreis/, '') : sauber
  const ende = bereich.search(/Die Preise der einzelnen Posten/)
  if (ende >= 0) bereich = bereich.slice(0, ende)

  for (const stueck of bereich.split(/(?=Projekt:|Sticker:|Versandkosten)/)) {
    const s = stueck.trim()
    let m
    if ((m = re('^Projekt:\\s*(.*?)\\s*-?\\s*(CP[A-Z0-9]{8,})\\s+(.*?)\\s+Farbe:\\s*(.*?)\\s+Größe:\\s*(\\S+)\\s+(\\d+)\\s+{G}\\s*€\\s+{G}\\s*€').exec(s))) {
      r.positionen.push({ typ: 'artikel', bezeichnung: m[3].trim(), projekt: m[1].trim(), projektCode: m[2], farbe: m[4].trim(), groesse: m[5], menge: +m[6], einzelpreis: zahl(m[7]), gesamt: zahl(m[8]) })
    } else if ((m = re('^Sticker:\\s*(.+?)\\s+(\\d+)\\s+{G}\\s*€\\s+{G}\\s*€').exec(s))) {
      r.positionen.push({ typ: 'zusatz', bezeichnung: m[1].trim(), menge: +m[2], einzelpreis: zahl(m[3]), gesamt: zahl(m[4]) })
    } else if ((m = re('^Versandkosten(?:\\s+Tracking:\\s*\\S+(?:\\s*\\([^)]*\\))?)?\\s+(\\d+)\\s+{G}\\s*€\\s+{G}\\s*€').exec(s))) {
      r.positionen.push({ typ: 'versand', bezeichnung: 'Versandkosten', menge: +m[1], einzelpreis: zahl(m[2]), gesamt: zahl(m[3]) })
    } else if (s) {
      r.unerkannt = [...(r.unerkannt || []), s.slice(0, 120)]
    }
  }

  // Summen: Beschriftungen stehen vor den drei Betraegen (Netto, MwSt, Brutto)
  const sum = re('Brutto-Summe\\s+{G}\\s*€\\s+{G}\\s*€\\s+{G}\\s*€').exec(sauber)
  if (sum) r.summen = { netto: zahl(sum[1]), mwst: zahl(sum[2]), brutto: zahl(sum[3]) }
  const satz = /zzgl\.\s*MwSt\.\s*\((\d+(?:,\d+)?)\s*%\)/.exec(sauber)
  if (r.summen && satz) r.summen.mwstSatz = zahl(satz[1] + (satz[1].includes(',') ? '' : ',00'))
  r.zahlung = { art: /Zahlung erfolgte durch:\s*(\S+)/.exec(flach)?.[1] || null, bezahlt: /Rechnung bereits bezahlt/i.test(flach) }
  return r
}

// ---------- Shopify (Abo-Rechnung) ----------
function shopify({ zeilen, flach }) {
  const r = { anbieter: 'shopify', lieferant: 'Shopify International Limited', waehrung: 'EUR', preisart: 'netto', positionen: [] }
  r.rechnungsnummer = /Rechnung\s*#\s*(\d+)/.exec(flach)?.[1] || null
  const en = /\b([A-Z][a-z]{2}) (\d{1,2}), (\d{4})\b/.exec(flach)
  if (en && monat(en[1])) r.datum = iso(en[3], monat(en[1]), en[2])
  const bez = /Bezahlt am (\d{1,2})\.\s*(\p{L}+)\.?\s*(\d{4})/u.exec(flach)
  if (bez && monat(bez[2])) r.bezahltAm = iso(bez[3], monat(bez[2]), bez[1])
  r.ustId = /USt\.\s*(IE\w+)/.exec(flach)?.[1] || null

  const von = zeilen.findIndex((z) => /^DETAILANSICHT/i.test(z))
  const bis = zeilen.findIndex((z, i) => i > von && /^Zwischensumme/i.test(z))
  const bereich = von >= 0 ? zeilen.slice(von + 1, bis > von ? bis : undefined) : []
  const zeile = re('^(.*?)\\s+{GN}\\s*€\\s*EUR$')
  let gruppe = null
  let letzte = null
  const abschliessen = () => { if (gruppe && !gruppe.kinder) r.positionen.push({ typ: 'abo', bezeichnung: gruppe.name, menge: 1, einzelpreis: gruppe.betrag, gesamt: gruppe.betrag }); gruppe = null }

  for (const z of bereich) {
    const m = zeile.exec(z)
    if (!m) { if (letzte) letzte.zeitraum = [letzte.zeitraum, z].filter(Boolean).join(' '); continue } // z.B. "Alle 30 tage"
    const name = m[1].trim()
    const betrag = zahl(m[2])
    if (/\(\d+ Artikel\)/i.test(name)) {
      abschliessen()
      gruppe = { name: name.replace(/\s*\(\d+ Artikel\)/i, '').replace(/^.*? (?=Abonnement|Apps?|Themes?)/i, ''), betrag, kinder: 0 }
      letzte = null
    } else if (/^Guthaben/i.test(name)) {
      r.guthaben = betrag
      letzte = null
    } else {
      if (gruppe) gruppe.kinder++
      letzte = { typ: 'abo', bezeichnung: name, gruppe: gruppe?.name || null, menge: 1, einzelpreis: betrag, gesamt: betrag }
      r.positionen.push(letzte)
    }
  }
  abschliessen()

  const zw = re('Zwischensumme\\s+{GN}\\s*€').exec(flach)
  const ust = re('USt\\.\\s*(\\d+(?:,\\d+)?)\\s*%\\*?\\s+{GN}\\s*€').exec(flach)
  const ges = re('Gesamtsumme\\s+{GN}\\s*€').exec(flach)
  if (zw && ges) r.summen = { netto: zahl(zw[1]), mwst: ust ? zahl(ust[2]) : 0, mwstSatz: ust ? zahl(ust[1].includes(',') ? ust[1] : ust[1] + ',0') : 0, brutto: zahl(ges[1]) }
  r.reverseCharge = /Reverse-Charge/i.test(flach)
  const zahlung = /Rechnung bezahlt:\s*(.+?)\s+\d{1,2}\.\s*\p{L}{3}/u.exec(flach)
  r.zahlung = { art: zahlung?.[1] || null, bezahlt: /Rechnung bezahlt/i.test(flach) }
  return r
}


// ---------- Deine eigene Rechnung aus dem Shop (Vorlage "RECHNUNG / BESTELLNUMMER / BESTELLDATUM") ----------
// Besonderheiten: entfernte Artikel sind durchgestrichen (zählen nicht), der Rabatt steckt schon in den Preisen,
// "Erstattet" kann entfernte Artikel enthalten, Beträge im Format "€ 21.21", Kleinunternehmer-Hinweis.
const EN = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)\\.\\d{2}'
const istGeld = (w) => new RegExp(`^-?${EN}$`).test(w)
const geldEN = (w) => parseFloat(String(w).replace(/,/g, ''))
function betragEN(flach, label) {
  const m = new RegExp(`\\b${label}\\s*(-)?\\s*€\\s*(-)?\\s*(${EN})`).exec(flach)
  return m ? (m[1] || m[2] ? -1 : 1) * geldEN(m[3]) : null
}

function bestellPositionen(tok) {
  const items = []
  let i = 0
  while (i < tok.length) {
    const h = tok.findIndex((t, k) => k >= i && t.w === 'TITEL')
    if (h < 0) break
    let g = tok.findIndex((t, k) => k > h && t.w === 'GESAMT' && tok[k + 1]?.w !== '€')
    if (g < 0) break
    i = g + 1
    for (;;) {
      if (i >= tok.length || tok[i].w === 'BEZAHLVERFAHREN' || tok[i].w === 'TITEL') break
      const k = tok.findIndex((t, n) => n >= i && /^x\d+$/.test(t.w) && /^\d+(?:[.,]\d+)?%$/.test(tok[n + 1]?.w || ''))
      const stop = tok.findIndex((t, n) => n >= i && (t.w === 'BEZAHLVERFAHREN' || t.w === 'TITEL'))
      if (k < 0 || (stop >= 0 && stop < k)) break
      const kopf = tok.slice(i, k)
      let n = k + 2
      const betraege = []
      while (tok[n]?.w === '€' && tok[n + 1] && istGeld(tok[n + 1].w) && betraege.length < 3) { betraege.push({ v: geldEN(tok[n + 1].w), d: tok[n + 1].d }); n += 2 }
      if (!betraege.length) break
      // Titel | Varianten (● ...) | Artikelnummer (kann umbrochen sein)
      const nrStart = kopf.findIndex((t, x) => /^[a-z]\d{5,}/i.test(t.w) && (x > 0))
      const bullet = kopf.findIndex((t) => t.w === '●')
      const titelEnde = bullet >= 0 ? bullet : (nrStart >= 0 ? nrStart : kopf.length)
      const variantenTeil = bullet >= 0 ? kopf.slice(bullet, nrStart >= 0 ? nrStart : kopf.length) : []
      const varianten = []
      for (const t of variantenTeil) t.w === '●' ? varianten.push([]) : varianten.at(-1)?.push(t.w)
      const titel = kopf.slice(0, titelEnde).map((t) => t.w).join(' ').replace(/(\p{L})- (\p{L})/gu, '$1-$2')
      const gesamt = betraege.at(-1)
      const einzel = betraege.length >= 2 ? betraege.at(-2).v : gesamt.v
      const menge = +tok[k].w.slice(1)
      items.push({
        typ: 'artikel', bezeichnung: titel, farbe: varianten[0]?.join(' ') || undefined, groesse: varianten[1]?.join(' ') || undefined,
        varianten: varianten.map((v) => v.join(' ')), artikelnummer: nrStart >= 0 ? kopf.slice(nrStart).map((t) => t.w).join('') : undefined,
        menge, einzelpreis: einzel, ursprungspreis: betraege.length === 3 ? betraege[0].v : undefined, gesamt: gesamt.v,
        mwstSatz: parseFloat(tok[k + 1].w), entfernt: !!gesamt.d
      })
      i = n
    }
  }
  return items
}

function eigeneShopBestellung({ zeilen, flach, mitMarken }) {
  const r = { anbieter: 'shop-rechnung', lieferant: eigene.eigenerShop(), eigen: true, waehrung: 'EUR', preisart: 'brutto', positionen: [] }
  const kopf = /#(\d{3,})\s+(\d{2}\.\d{2}\.\d{4})(?:\s+(\d{2}:\d{2}))?/.exec(flach)
  r.referenz = kopf?.[1] || null
  r.bestellnummer = r.referenz
  r.rechnungsnummer = r.referenz ? `#${r.referenz}` : null
  r.datum = deDatum(kopf?.[2])
  r.uhrzeit = kopf?.[3] || null

  const von = zeilen.findIndex((z) => /^VERSANDDETAILS/.test(z))
  if (von >= 0) {
    let bis = zeilen.findIndex((z, i) => i > von && /^(RECHNUNGSDETAILS|KUNDENDETAILS)/.test(z))
    if (bis < 0) bis = von + 7
    const b = zeilen.slice(von + 1, bis)
    const email = b.find((z) => /@/.test(z))
    const plz = b.findIndex((z) => /^\d{5}\s+\S/.test(z))
    r.empfaenger = { name: b[0], email, strasse: plz > 1 ? b[plz - 1] : undefined, plz: plz >= 0 ? b[plz].split(' ')[0] : undefined, ort: plz >= 0 ? b[plz].replace(/^\d{5}\s+/, '') : undefined }
  }

  r.positionen = bestellPositionen(tokenisieren(mitMarken))
  const zw = betragEN(flach, 'ZWISCHENSUMME')
  const versand = betragEN(flach, 'VERSAND')
  const rabatt = betragEN(flach, 'RABATT')
  const erst = betragEN(flach, 'ERSTATTET')
  const gesamt = betragEN(flach, 'GESAMT')
  const bezahlt = betragEN(flach, 'BEZAHLT')
  const offen = betragEN(flach, 'OFFENER BETRAG')
  r.rabatt = rabatt != null ? Math.abs(rabatt) : 0
  r.erstattet = erst != null ? Math.abs(erst) : 0
  r.offen = offen || 0
  r.bezahltBetrag = bezahlt

  // Entfernte Artikel: normalerweise durchgestrichen (Markierung aus dem PDF). Ohne Markierung (z. B. OCR) aus den Summen schätzen.
  const alle = r.positionen
  const summeAlle = rund(alle.reduce((a, p) => a + p.gesamt, 0))
  if (zw != null && r.erstattet && !alle.some((p) => p.entfernt) && Math.abs(summeAlle - (zw + r.erstattet)) <= 0.011) {
    let acc = 0
    const kandidaten = []
    for (const p of alle) { if (rund(acc + p.gesamt) <= r.erstattet + 0.001) { acc = rund(acc + p.gesamt); kandidaten.push(p) } else break }
    if (Math.abs(acc - r.erstattet) <= 0.011) { kandidaten.forEach((p) => { p.entfernt = true; p.geraten = true }); r.entferntGeraten = true }
  }
  const aktiv = alle.filter((p) => !p.entfernt)
  const summeAktiv = rund(aktiv.reduce((a, p) => a + p.gesamt, 0))
  const summeEntfernt = rund(alle.filter((p) => p.entfernt).reduce((a, p) => a + p.gesamt, 0))
  if (zw != null && rabatt && Math.abs(summeAktiv - rabatt * -1 - zw) <= 0.011 && Math.abs(summeAktiv - zw) > 0.011) {
    aktiv.length && r.positionen.push({ typ: 'rabatt', bezeichnung: 'Rabatt', menge: 1, einzelpreis: -Math.abs(rabatt), gesamt: -Math.abs(rabatt) })
  } else if (zw != null) r.rabattEingerechnet = Math.abs(summeAktiv - zw) <= 0.011 && r.rabatt > 0
  if (versand) r.positionen.push({ typ: 'versand', bezeichnung: 'Versand', menge: 1, einzelpreis: versand, gesamt: versand })

  r.kleinunternehmer = /§\s*19\s*UStG|kleinunternehmer/i.test(flach)
  if (gesamt != null) {
    // Rückerstattungen, die NICHT durch entfernte Artikel erklärt sind, mindern den Umsatz
    const zusatz = Math.max(0, rund(r.erstattet - summeEntfernt))
    r.umsatz = rund(gesamt - zusatz)
    r.summen = { brutto: gesamt, mwst: r.kleinunternehmer ? 0 : null, netto: gesamt, zwischensumme: zw, mwstSatz: aktiv[0]?.mwstSatz ?? 0 }
    if (zusatz) r.zusatzErstattung = zusatz
    if (!r.kleinunternehmer && !aktiv.some((p) => p.mwstSatz > 0)) r.mwstFehlt = true
  }
  r.zahlung = { art: /BEZAHLVERFAHREN\s+(.+?)\s+(?:RABATT|ZWISCHENSUMME)/.exec(flach)?.[1] || null, bezahlt: bezahlt != null && bezahlt > 0 && !r.offen }
  return r
}

// ---------- Shopify-Bestellung (PDF deiner Verkäufe → Einnahme, Preise brutto) ----------
function findeDatum(flach) {
  let m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(flach)
  if (m) return iso(m[3], m[2], m[1])
  if ((m = /(\d{1,2})\.\s*(\p{L}{3,9})\.?,?\s*(\d{4})/u.exec(flach)) && monat(m[2])) return iso(m[3], monat(m[2]), m[1])
  if ((m = /\b(\p{L}{3,9})\.? (\d{1,2}), (\d{4})/u.exec(flach)) && monat(m[1])) return iso(m[3], monat(m[1]), m[2])
  if ((m = /(\d{4})-(\d{2})-(\d{2})/.exec(flach))) return iso(m[1], m[2], m[3])
  return null
}

function shopifyBestellung({ zeilen, flach }) {
  const r = { anbieter: 'shopify-bestellung', lieferant: eigene.eigenerShop(), eigen: true, waehrung: 'EUR', preisart: 'brutto', positionen: [] }
  const nr = /(?:Bestellung|Bestellnummer|Bestell-Nr\.?|Order)\s*(?:Nr\.?)?\s*[:#]?\s*#?\s*(\d{3,})/i.exec(flach)?.[1]
  r.referenz = nr || null
  r.bestellnummer = nr || null
  r.rechnungsnummer = nr ? `#${nr}` : null
  r.datum = findeDatum(flach)

  // Kundenname: Zeile nach Label (Kunde / Versandadresse / ...) oder direkt dahinter
  for (let i = 0; i < zeilen.length && !r.empfaenger; i++) {
    const l = /^(?:Kunde|Kundin|Versandadresse|Lieferadresse|Rechnungsadresse|Ship to|Bill to|Customer)\s*:?\s*(.*)$/i.exec(zeilen[i])
    if (!l) continue
    const name = (l[1] || zeilen[i + 1] || '').trim()
    if (name && !/\d/.test(name) && name.length < 60) r.empfaenger = { name }
  }

  const geld = (z) => [...z.matchAll(new RegExp(GN, 'g'))].map((x) => zahl(x[1]))
  let zw = null, steuer = null, satz = null, gesamt = null, rabatt = 0
  let vorher = null
  const P = [
    [re('^(.+?)\\s+{G}\\s*€?\\s*[×x]\\s*(\\d+)\\s+{G}\\s*€?$'), (x) => ({ b: x[1], e: zahl(x[2]), n: +x[3], g: zahl(x[4]) })],
    [re('^(.+?)\\s+(\\d+)\\s*[×x]\\s+{G}\\s*€?\\s+{G}\\s*€?$'), (x) => ({ b: x[1], n: +x[2], e: zahl(x[3]), g: zahl(x[4]) })],
    [re('^(.+?)\\s+[×x]\\s*(\\d+)\\s+{G}\\s*€?$'), (x) => ({ b: x[1], n: +x[2], g: zahl(x[3]), e: null })],
    [re('^(.+?)\\s+(\\d+)\\s+{G}\\s*€?\\s+{G}\\s*€?$'), (x) => ({ b: x[1], n: +x[2], e: zahl(x[3]), g: zahl(x[4]) })]
  ]
  const zweiZeilig = re('^[×x]\\s*(\\d+)\\s+{G}\\s*€?$')
  for (const z of zeilen) {
    const werte = geld(z)
    if (/^Zwischensumme|^Subtotal/i.test(z)) { zw = werte.at(-1) ?? zw; vorher = null; continue }
    if (/^(?:Kostenloser\s+)?(?:Versand|Shipping)\b/i.test(z) && werte.length) {
      const v = werte.at(-1)
      if (v > 0) r.positionen.push({ typ: 'versand', bezeichnung: z.replace(/\s*-?\d[\d.,]*\s*€?\s*$/, '').trim() || 'Versand', menge: 1, einzelpreis: v, gesamt: v })
      vorher = null; continue
    }
    if (/^(?:Rabatt|Discount|Gutschein)/i.test(z) && werte.length) {
      const v = -Math.abs(werte.at(-1)); rabatt += v
      r.positionen.push({ typ: 'rabatt', bezeichnung: z.replace(/\s*-?\d[\d.,]*\s*€?\s*$/, '').trim(), menge: 1, einzelpreis: v, gesamt: v })
      vorher = null; continue
    }
    if (/^(?:Steuern|MwSt|USt|inkl\.?\s*MwSt|Enthaltene Steuern|Tax)/i.test(z) && werte.length) {
      steuer = werte.at(-1); satz = /(\d+(?:,\d+)?)\s*%/.exec(z)?.[1] || satz; vorher = null; continue
    }
    if (/^(?:Gesamtsumme|Gesamtbetrag|Gesamt|Summe|Insgesamt|Total)\b/i.test(z) && werte.length) { gesamt = werte.at(-1); vorher = null; continue }
    let treffer = null
    for (const [rx, f] of P) { const x = rx.exec(z); if (x) { treffer = f(x); break } }
    if (!treffer && vorher && (zweiZeilig.exec(z))) {
      const x = zweiZeilig.exec(z); treffer = { b: vorher, n: +x[1], g: zahl(x[2]), e: null }
    }
    if (treffer) {
      r.positionen.push({ typ: 'artikel', bezeichnung: treffer.b.trim(), menge: treffer.n, einzelpreis: treffer.e ?? rund(treffer.g / treffer.n), gesamt: treffer.g })
      vorher = null
    } else vorher = werte.length ? null : z
  }

  if (gesamt != null) {
    const mwst = steuer
    r.summen = { brutto: gesamt, mwst, netto: mwst != null ? rund(gesamt - mwst) : gesamt, zwischensumme: zw }
    if (satz) r.summen.mwstSatz = zahl(satz.includes(',') ? satz : satz + ',00')
    if (mwst == null) r.mwstFehlt = true // Gewinn waere sonst zu hoch (brutto statt netto)
  }
  r.zahlung = { art: /(?:Zahlungsart|Bezahlt mit|Payment)[:\s]+(.+)/i.exec(zeilen.join('\n'))?.[1]?.trim() || null, bezahlt: /bezahlt|paid/i.test(flach) }
  return r
}

// ---------- Allgemeiner Fallback (unbekannte Anbieter) ----------
function allgemein({ zeilen, flach }) {
  const r = { anbieter: 'allgemein', lieferant: null, waehrung: /\$|USD/.test(flach) ? 'USD' : 'EUR', preisart: 'unbekannt', positionen: [], unsicher: true }
  r.lieferant = zeilen.find((z) => /\b(GmbH|UG|AG|KG|Ltd|Limited|Inc|e\.K\.)\b/.test(z))?.split('|')[0].trim() || null
  r.rechnungsnummer = /Rechnungs?-?\s*(?:Nr\.?|nummer)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-/]*)/i.exec(flach)?.[1] || /Rechnung\s*#\s*(\w+)/i.exec(flach)?.[1] || null
  r.datum = deDatum(flach)
  const pos = re('^(.+?)\\s+(\\d+)\\s+{G}\\s*(?:€|EUR)?\\s+{G}\\s*(?:€|EUR)?$')
  for (const z of zeilen) {
    const m = pos.exec(z)
    if (!m) continue
    const typ = /versand|porto|shipping/i.test(m[1]) ? 'versand' : 'artikel'
    r.positionen.push({ typ, bezeichnung: m[1].trim(), menge: +m[2], einzelpreis: zahl(m[3]), gesamt: zahl(m[4]) })
  }
  const netto = re('Netto[- ]?(?:summe|betrag)?\\s*:?\\s*{G}').exec(flach)
  const mwst = re('(?:MwSt|USt)\\.?[^\\d]{0,25}{G}').exec(flach)
  const brutto = re('(?:Brutto[- ]?(?:summe|betrag)?|Gesamt(?:summe|betrag)|Endbetrag|Rechnungsbetrag)\\s*:?\\s*{G}', 'i').exec(flach)
  if (brutto) r.summen = { netto: netto ? zahl(netto[1]) : null, mwst: mwst ? zahl(mwst[1]) : null, brutto: zahl(brutto[1]) }
  r.zahlung = { art: null, bezahlt: /bezahlt|paid/i.test(flach) }
  return r
}

const PROFILE = [
  { erkennen: /Shirtigo GmbH/, lesen: shirtigo },
  { erkennen: /Shopify International Limited/, lesen: shopify },
  // Bestell-PDF aus deinem Shop: "Bestellung #1057" + Zwischensumme, aber keine Rechnung von Shopify/Shirtigo
  { erkennen: (t) => /RECHNUNG\s+BESTELLNUMMER\s+BESTELLDATUM/.test(t) && /VERSANDDETAILS/.test(t), lesen: eigeneShopBestellung },
  { erkennen: (t) => /(?:Bestellung|Bestellnummer|Order)\s*(?:Nr\.?)?\s*[:#]?\s*#?\s*\d{3,}/i.test(t) && /Zwischensumme|Subtotal/i.test(t), lesen: shopifyBestellung }
]

// Plausibilitaetspruefung: Summe der Positionen muss zu den Rechnungssummen passen
function pruefen(r) {
  const hinweise = []
  if (!r.rechnungsnummer) hinweise.push('Keine Rechnungsnummer erkannt.')
  if (!r.datum) hinweise.push('Kein Datum erkannt.')
  if (!r.positionen.length) hinweise.push('Keine Positionen erkannt.')
  if (!r.summen) hinweise.push('Keine Summen erkannt.')
  if (r.unerkannt?.length) hinweise.push(`${r.unerkannt.length} Textabschnitt(e) nicht zugeordnet.`)
  const aktiv = r.positionen.filter((p) => !p.entfernt)
  if (r.entferntGeraten) hinweise.push('Entfernte (durchgestrichene) Artikel wurden aus den Summen geschätzt – bitte mit dem PDF vergleichen.')
  if (r.zusatzErstattung) hinweise.push(`Erstattung von ${r.zusatzErstattung.toFixed(2)} € über entfernte Artikel hinaus – mindert den Umsatz.`)
  for (const p of aktiv) {
    if (Math.abs(rund(p.menge * p.einzelpreis) - p.gesamt) > 0.011 * Math.max(1, p.menge)) hinweise.push(`"${p.bezeichnung}": Menge x Einzelpreis passt nicht zum Gesamtpreis.`)
  }
  if (r.summen && aktiv.length) {
    const posSumme = rund(aktiv.reduce((s, p) => s + p.gesamt, 0))
    const vergleich = r.preisart === 'brutto' ? r.summen.brutto : (r.summen.netto ?? r.summen.brutto)
    if (vergleich != null && Math.abs(posSumme - vergleich) > 0.011) hinweise.push(`Positionen ergeben ${posSumme.toFixed(2)}, Rechnung nennt ${vergleich.toFixed(2)}.`)
    if (r.mwstFehlt) hinweise.push('MwSt nicht erkannt – es wird mit dem Bruttobetrag gerechnet, der Gewinn ist dann zu hoch.')
    if (r.summen.netto != null && r.summen.mwst != null && Math.abs(rund(r.summen.netto + r.summen.mwst) - r.summen.brutto) > 0.011) hinweise.push('Netto + MwSt ergibt nicht Brutto.')
  }
  return { ok: hinweise.length === 0 && !r.unsicher, hinweise }
}

// § 13b (Schritt 4.4, Plan 7.4): Reverse-Charge-Hinweis auf der Rechnung und ausländische USt-IdNr. des Lieferanten.
// Herkunft „eu“ bei USt-IdNr. eines anderen EU-Staats bzw. Hinweis auf Art. 196 MwStSystRL, sonst unbekannt (später je
// Anbieter einstellbar). Deutsche USt-IdNr. (meist die eigene) zählt nicht.
const RC_TEXT = /reverse[\s-]*charge|steuerschuldnerschaft\s+des\s+leistungsempf(ä|ae)ngers|umkehrung\s+der\s+steuerschuld|art(\.|ikel)?\s*196|autoliquidation|btw\s+verlegd|inversione\s+contabile|inversión\s+del\s+sujeto\s+pasivo/i
const EU_UST_ID = /\b(AT\s?U\d{8}|BE\s?[01]\d{9}|BG\d{9,10}|CY\d{8}[A-Z]|CZ\d{8,10}|DK\d{8}|EE\d{9}|EL\d{9}|ES[A-Z0-9]\d{7}[A-Z0-9]|FI\d{8}|FR[A-HJ-NP-Z0-9]{2}\d{9}|HR\d{11}|HU\d{8}|IE\d{7}[A-W][A-I]?|IE\d[A-Z+*]\d{5}[A-W]|IT\d{11}|LT(\d{9}|\d{12})|LU\d{8}|LV\d{11}|MT\d{8}|NL\d{9}B\d{2}|PL\d{10}|PT\d{9}|RO\d{2,10}|SE\d{12}|SI\d{8}|SK\d{10})\b/
function reverseChargeErkennen(r, flach) {
  // „IE 9692928F“: ein Leerzeichen nach dem Ländercode ist auf Rechnungen üblich → für die Suche entfernen
  const ohneLuecke = flach.replace(/\b(AT|BE|BG|CY|CZ|DK|EE|EL|ES|FI|FR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK) (?=[0-9A-Z])/g, '$1')
  const id = r.ustId && !/^DE/i.test(r.ustId) ? r.ustId : EU_UST_ID.exec(ohneLuecke)?.[0]?.replace(/\s/g, '') || null
  if (RC_TEXT.test(flach)) r.reverseCharge = true
  if (id) r.lieferantUstId = id
  if (r.reverseCharge && (id || /art(\.|ikel)?\s*196/i.test(flach))) r.herkunft = 'eu'
}

function parseRechnung(rohtext) {
  const v = vorbereiten(rohtext)
  const profil = PROFILE.find((p) => (typeof p.erkennen === 'function' ? p.erkennen(v.flach) : p.erkennen.test(v.flach)))
  const r = (profil ? profil.lesen : allgemein)(v)
  const aktiv = r.positionen.filter((p) => !p.entfernt)
  r.versand = rund(aktiv.filter((p) => p.typ === 'versand').reduce((s, p) => s + p.gesamt, 0))
  r.anzahlPositionen = aktiv.length
  r.anzahlEntfernt = r.positionen.length - aktiv.length
  r.anzahlArtikel = aktiv.filter((p) => p.typ === 'artikel').reduce((s, p) => s + p.menge, 0)
  r.art = r.eigen || eigene.istEigen(r.lieferant) ? 'einnahme' : 'ausgabe'
  delete r.eigen
  if (r.art === 'ausgabe') reverseChargeErkennen(r, v.flach)
  // "wirksam" = der Betrag, der in Einnahmen/Ausgaben/Gewinn zählt
  if (r.summen) {
    if (r.art === 'einnahme') { r.wirksam = r.umsatz ?? (r.summen.netto ?? r.summen.brutto); r.wirksamArt = r.kleinunternehmer ? 'ohne MwSt (§ 19)' : 'netto' } else {
      const brutto = !eigene.vorsteuerAbziehbarAm(r.datum)
      r.wirksam = brutto ? r.summen.brutto : (r.summen.netto ?? r.summen.brutto)
      r.wirksamArt = brutto ? 'inkl. MwSt' : 'netto'
    }
  }
  r.version = VERSION
  r.profil = eigene.stand() // ändern sich „Meine Angaben“, wertet haupt.js den gespeicherten Text neu aus
  r.pruefung = pruefen(r)
  return r
}

// Auswertung ueber mehrere Rechnungen: Einnahmen, Ausgaben, Gewinn (netto), pro Monat
function auswerten(rechnungen) {
  const gesamt = { einnahmen: 0, ausgaben: 0, versand: 0, mwst: 0, gewinn: 0 }
  const monate = {}
  for (const r of rechnungen) {
    if (!r?.summen) continue
    const netto = r.wirksam ?? r.summen.netto ?? r.summen.brutto
    const key = (r.datum || 'unbekannt').slice(0, 7)
    const m = (monate[key] ||= { einnahmen: 0, ausgaben: 0, gewinn: 0 })
    if (r.art === 'einnahme') { gesamt.einnahmen += netto; m.einnahmen += netto } else { gesamt.ausgaben += netto; m.ausgaben += netto; gesamt.versand += r.versand || 0 }
    gesamt.mwst += r.art === 'einnahme' ? (r.summen.mwst || 0) : -(r.summen.mwst || 0)
  }
  for (const m of Object.values(monate)) { m.einnahmen = rund(m.einnahmen); m.ausgaben = rund(m.ausgaben); m.gewinn = rund(m.einnahmen - m.ausgaben) }
  for (const k of Object.keys(gesamt)) gesamt[k] = rund(gesamt[k])
  gesamt.gewinn = rund(gesamt.einnahmen - gesamt.ausgaben)
  return { gesamt, monate }
}

module.exports = { parseRechnung, auswerten, VERSION }