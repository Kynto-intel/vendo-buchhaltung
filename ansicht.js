import { angabenBereicheErstellen } from './angaben-bereiche.js'

const euro = (n) => (n == null ? '–' : Number(n).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }))
const datumText = (iso) => (iso ? new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '–')
const monatText = (key) => (/^\d{4}-\d{2}$/.test(key) ? new Date(`${key}-01`).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }) : 'Ohne Datum')
const groesseText = (bytes) => bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`
const TYP = { artikel: 'Artikel', zusatz: 'Zusatz', versand: 'Versand', abo: 'Abo', rabatt: 'Rabatt' }
const MONATSNAMEN = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']
const rund = (n) => Math.round(n * 100) / 100
const RUECKGABE = { RETURN: 'Retoure', LEGACY_RESTOCK: 'Retoure', CANCEL: 'storniert', NO_RESTOCK: 'erstattet, nicht zurück ins Lager' }
const istRetoure = (x) => x.art === 'RETURN' || x.art === 'LEGACY_RESTOCK'
const METHODE = { text: 'PDF-Text', ocr: 'OCR', 'text+ocr': 'PDF-Text + OCR', api: 'Shopify-API', 'shirtigo-api': 'Shirtigo-Daten', 'shopify-gebuehr': 'Shopify-Gebühren' }
const DATENBASIS = {
  zahlung: { label: 'nach Zahlungstag', datum: (r) => r?.datumZahlung ?? r?.zahlung?.datum ?? r?.datum ?? '' },
  bestellung: { label: 'nach Bestelldatum', datum: (r, bestellDaten) => r?.datumBestellung ?? bestellDaten?.get(String(r?.referenz)) ?? r?.datum ?? r?.zahlung?.datum ?? '' }
}
const bestelldatenMap = (dateien) => new Map(dateien
  .filter((d) => d.rechnung?.anbieter === 'shopify-api' && d.rechnung.art === 'einnahme' && d.rechnung.referenz && d.rechnung.datum)
  .map((d) => [String(d.rechnung.referenz), d.rechnung.datum]))
const datumNachBasis = (r, basis = 'zahlung', bestellDaten) => DATENBASIS[basis === 'bestellung' ? 'bestellung' : 'zahlung'].datum(r, bestellDaten)

// ---------- Filter, Sortierung, Kennzahlen (reine Funktionen) ----------
const istArtikel = (p) => p.typ === 'artikel' || p.typ === 'abo' || p.typ === 'gebuehr'
// "wirksam" = Betrag, der in Einnahmen/Ausgaben/Gewinn zählt (setzt der Parser; Ausgaben brutto bei Kleinunternehmer)
const betragVon = (r) => (r?.wirksam ?? (r?.summen ? (r.summen.netto ?? r.summen.brutto) : null))
const artikelNamen = (r) => (r?.positionen || []).filter((p) => istArtikel(p) && !p.entfernt).map((p) => p.bezeichnung)
const artikelPreis = (r) => { const w = (r?.positionen || []).filter((p) => istArtikel(p) && !p.entfernt).map((p) => p.einzelpreis); return w.length ? Math.max(...w) : null }
const SORTIERUNG = {
  datum: { label: 'Datum', wert: (r, basis = 'zahlung', bestellDaten) => datumNachBasis(r, basis, bestellDaten) || null, standard: 'desc', text: false },
  betrag: { label: 'Rechnungsbetrag', wert: betragVon, standard: 'desc', text: false },
  lieferant: { label: 'Lieferant', wert: (r) => r.lieferant?.toLowerCase() || null, standard: 'asc', text: true },
  kunde: { label: 'Kundenname', wert: (r) => r.empfaenger?.name?.toLowerCase() || null, standard: 'asc', text: true },
  artikel: { label: 'Artikelname', wert: (r) => artikelNamen(r).sort()[0]?.toLowerCase() || null, standard: 'asc', text: true },
  preis: { label: 'Artikelpreis (teuerster)', wert: artikelPreis, standard: 'desc', text: false }
}
// gleiche Rechnung (Lieferant + Nummer) mehrfach abgelegt: nur die erste zählt
export function duplikate(dateien) {
  const gesehen = new Set()
  const doppelt = new Set()
  // Welche Fassung zählt: 0 = Eintrag aus der Schnittstelle MIT Original-PDF (exakte Daten), 1 = selbst eingelesene PDF, 2 = Shirtigo-Daten ohne PDF
  const rang = (d) => (d.beleg ? 0 : d.quelle === 'shirtigo-api' ? 2 : 1)
  for (const d of [...dateien].sort((a, b) => rang(a) - rang(b) || a.zeit - b.zeit)) {
    const r = d.rechnung
    if (!r?.rechnungsnummer) continue
    const key = `${r.lieferant}|${r.rechnungsnummer}`
    gesehen.has(key) ? doppelt.add(d.id) : gesehen.add(key)
  }
  return doppelt
}

export function filtern(dateien, f, doppelt = new Set()) {
  const q = (f.suche || '').trim().toLowerCase()
  const bestellDaten = f.zahlungsbasis === 'bestellung' ? bestelldatenMap(dateien) : null
  return dateien.filter((d) => {
    const r = d.rechnung
    if (!r || doppelt.has(d.id)) return false
    if (f.lieferant && r.lieferant !== f.lieferant) return false
    if (f.art && r.art !== f.art) return false
    const dt = datumNachBasis(r, f.zahlungsbasis, bestellDaten)
    if (f.jahr && !dt.startsWith(f.jahr)) return false
    if (f.monat && dt.slice(5, 7) !== f.monat) return false
    if (q) {
      const heu = [r.lieferant, r.rechnungsnummer, r.bestellnummer, r.referenz, r.empfaenger?.name, r.empfaenger?.ort, d.name,
        ...r.positionen.flatMap((p) => [p.bezeichnung, p.projekt, p.farbe])].filter(Boolean).join(' ').toLowerCase()
      if (!q.split(/\s+/).every((w) => heu.includes(w))) return false
    }
    return true
  })
}

// Richtung ist pro Feld fest (Datum: neueste oben, Betrag/Preis: höchste oben, Namen: A–Z). Bei Gleichstand immer neueste zuerst.
export function sortieren(liste, feld, basis = 'zahlung', alleDateien = liste) {
  const { wert, standard } = SORTIERUNG[feld]
  const bestellDaten = basis === 'bestellung' ? bestelldatenMap(alleDateien) : null
  const faktor = standard === 'asc' ? 1 : -1
  const neuer = (a, b) => (datumNachBasis(b.rechnung, basis, bestellDaten) || '').localeCompare(datumNachBasis(a.rechnung, basis, bestellDaten) || '') || (b.zeit - a.zeit)
  return [...liste].sort((a, b) => {
    const x = wert(a.rechnung, basis, bestellDaten)
    const y = wert(b.rechnung, basis, bestellDaten)
    if (x == null && y == null) return neuer(a, b)
    if (x == null) return 1 // fehlende Werte immer ans Ende
    if (y == null) return -1
    return ((typeof x === 'string' ? x.localeCompare(y, 'de') : x - y) * faktor) || neuer(a, b)
  })
}

export function kennzahlen(liste, basis = 'zahlung', alleDateien = liste) {
  const k = { einnahmen: 0, ausgaben: 0, versand: 0, gewinn: 0, anzahl: liste.length, monate: {} }
  const bestellDaten = basis === 'bestellung' ? bestelldatenMap(alleDateien) : null
  for (const d of liste) {
    const r = d.rechnung
    const b = betragVon(r)
    if (b == null) continue
    const key = (datumNachBasis(r, basis, bestellDaten) || 'ohne').slice(0, 7)
    const mo = (k.monate[key] ||= { einnahmen: 0, ausgaben: 0, gewinn: 0, anzahl: 0 })
    mo.anzahl++
    if (r.art === 'einnahme') { k.einnahmen += b; mo.einnahmen += b } else { k.ausgaben += b; mo.ausgaben += b; k.versand += r.versand || 0 }
  }
  const rd = (n) => Math.round(n * 100) / 100
  k.gewinn = rd(k.einnahmen - k.ausgaben)
  for (const key of ['einnahmen', 'ausgaben', 'versand']) k[key] = rd(k[key])
  for (const mo of Object.values(k.monate)) { mo.einnahmen = rd(mo.einnahmen); mo.ausgaben = rd(mo.ausgaben); mo.gewinn = rd(mo.einnahmen - mo.ausgaben) }
  return k
}

// Umtausch: im Shop entfernte Artikel (z. B. Größe getauscht), die bei Shirtigo trotzdem produziert wurden = Kosten ohne Erlös.
// Zuordnung über Größe + Ähnlichkeit zwischen Shirtigo-Designname und Shop-Titel (Wortanteil, da die Namen nicht identisch sind).
const woerter = (s) => String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3)
const aehnlichkeit = (design, titel) => { const d = woerter(design); const t = new Set(woerter(titel)); return d.length ? d.filter((w) => t.has(w)).length / d.length : 0 }
const groesseNorm = (s) => String(s || '').trim().toLowerCase()
export function umtauschVon(g) {
  const frei = []
  for (const d of g.shop) for (const p of d.rechnung.positionen) if (p.typ === 'artikel' && p.entfernt) frei.push({ titel: p.bezeichnung, groesse: groesseNorm(p.groesse), rest: p.menge })
  if (!frei.length) return null
  const zeilen = new Set()
  let anzahl = 0
  let kosten = 0
  for (const d of g.kosten) {
    const s = d.rechnung.summen
    const faktor = d.rechnung.wirksamArt === 'inkl. MwSt' && s?.netto ? s.brutto / s.netto : 1 // Kosten so zählen, wie sie im Gewinn zählen
    for (const p of d.rechnung.positionen) {
      if (p.typ !== 'artikel') continue
      const treffer = frei.filter((x) => x.rest > 0 && x.groesse === groesseNorm(p.groesse))
        .map((x) => ({ x, wert: aehnlichkeit(p.projekt || p.bezeichnung, x.titel) })).filter((t) => t.wert >= 0.6).sort((a, b) => b.wert - a.wert)[0]
      if (!treffer) continue
      const n = Math.min(treffer.x.rest, p.menge)
      treffer.x.rest -= n
      anzahl += n
      kosten += p.einzelpreis * n * faktor
      zeilen.add(p)
    }
  }
  return anzahl ? { anzahl, kosten: rund(kosten), zeilen } : null
}

// ---------- Bestellungen: Shopify-Rechnung (Erlös) + Shirtigo-Rechnung(en) (Kosten) über die Bestellnummer ----------
export function bestellungenListe(dateien, doppelt = new Set()) {
  const map = new Map()
  for (const d of dateien) {
    const r = d.rechnung
    if (!r?.referenz || doppelt.has(d.id)) continue
    const g = map.get(r.referenz) || { referenz: r.referenz, shop: [], kosten: [] }
    ;(r.art === 'einnahme' ? g.shop : g.kosten).push(d)
    map.set(r.referenz, g)
  }
  const summe = (l) => rund(l.reduce((a, d) => a + (betragVon(d.rechnung) || 0), 0))
  const anzahl = (l) => l.reduce((a, d) => a + (d.rechnung.anzahlArtikel || 0), 0)
  return [...map.values()].map((g) => {
    const alle = [...g.shop, ...g.kosten]
    const datumBestellung = g.shop[0]?.rechnung.datum || alle.map((d) => d.rechnung.datum).filter(Boolean).sort()[0] || null
    const datumZahlung = g.shop.map((d) => d.rechnung.zahlung?.datum || d.rechnung.datum).filter(Boolean).sort()[0] || datumBestellung
    const datum = datumBestellung
    const empf = (g.shop[0] || g.kosten[0]).rechnung.empfaenger
    const erloes = g.shop.length ? summe(g.shop) : null
    const kosten = g.kosten.length ? summe(g.kosten) : null
    const komplett = erloes != null && g.kosten.some((d) => !d.rechnung.gebuehr) // Gebühren allein machen eine Bestellung nicht vollständig
    const gewinn = komplett ? rund(erloes - kosten) : null
    const umtausch = komplett ? umtauschVon(g) : null
    return {
      ...g, kostenDocs: g.kosten, datum, datumBestellung, datumZahlung, kunde: empf?.name || '', ort: empf?.ort || '', erloes, kosten, komplett, gewinn,
      storniert: g.shop.some((d) => d.rechnung.storniert),
      umtausch, gewinnOhneUmtausch: umtausch ? rund(gewinn + umtausch.kosten) : null, retouren: g.shop.flatMap((d) => d.rechnung.retouren || []),
      marge: komplett && erloes > 0 ? gewinn / erloes : null,
      status: komplett ? 'komplett' : g.shop.length ? 'kosten-fehlen' : 'shop-fehlt',
      artikelShop: anzahl(g.shop), artikelKosten: anzahl(g.kosten),
      zeit: Math.max(...alle.map((d) => d.zeit || 0)),
      suchtext: [g.referenz, empf?.name, empf?.ort, empf?.email, ...alle.flatMap((d) => d.rechnung.positionen.flatMap((p) => [p.bezeichnung, p.projekt, p.farbe]))].filter(Boolean).join(' ').toLowerCase()
    }
  })
}

export function bestellungenFiltern(liste, f) {
  const q = (f.suche || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  const basis = (f.zahlungsbasis === 'bestellung' ? 'bestellung' : 'zahlung')
  return liste.filter((b) => {
    const dt = datumNachBasis(b, basis)
    if (f.jahr && !dt.startsWith(f.jahr)) return false
    if (f.monat && dt.slice(5, 7) !== f.monat) return false
    if (f.status === 'komplett' && (!b.komplett || b.storniert)) return false
    if (f.status === 'offen' && (b.komplett || b.storniert)) return false
    if (f.status === 'storniert' && !b.storniert) return false
    return q.every((w) => b.suchtext.includes(w))
  })
}

export const SORT_BESTELLUNG = {
  datum: { label: 'Datum (neueste zuerst)', wert: (b, basis = 'zahlung') => datumNachBasis(b, basis), faktor: -1, text: true },
  gewinn: { label: 'Gewinn (höchster zuerst)', wert: (b) => b.gewinn, faktor: -1 },
  verlust: { label: 'Gewinn (niedrigster zuerst)', wert: (b) => b.gewinn, faktor: 1 },
  erloes: { label: 'Erlös (höchster zuerst)', wert: (b) => b.erloes, faktor: -1 },
  kosten: { label: 'Kosten (höchste zuerst)', wert: (b) => b.kosten, faktor: -1 },
  marge: { label: 'Marge (höchste zuerst)', wert: (b) => b.marge, faktor: -1 },
  kunde: { label: 'Kundenname (A–Z)', wert: (b) => b.kunde?.toLowerCase() || null, faktor: 1, text: true }
}

// Bei Gleichstand immer die neueste Bestellung zuerst
export function bestellungenSortieren(liste, feld, basis = 'zahlung') {
  const { wert, faktor, text } = SORT_BESTELLUNG[feld]
  const neuer = (a, b) => (datumNachBasis(b, basis) || '').localeCompare(datumNachBasis(a, basis) || '') || (+b.referenz - +a.referenz)
  return [...liste].sort((a, b) => {
    const x = wert(a, basis)
    const y = wert(b, basis)
    if (x == null && y == null) return neuer(a, b)
    if (x == null) return 1
    if (y == null) return -1
    return ((text ? String(x).localeCompare(String(y), 'de') : x - y) * faktor) || neuer(a, b)
  })
}

export function kennzahlenBestellungen(liste) {
  const k = { umtauschKosten: 0, umtauschAnzahl: 0, umtauschBestellungen: 0, erloes: 0, kosten: 0, gewinn: 0, komplett: 0, schnitt: null, marge: null, ohneKosten: 0, erloesOhneKosten: 0, ohneShop: 0, kostenOhneShop: 0, erloesAlle: 0, kostenAlle: 0, anzahl: liste.length }
  for (const b of liste) {
    if (b.erloes != null) k.erloesAlle += b.erloes
    if (b.kosten != null) k.kostenAlle += b.kosten
    if (b.komplett) { k.erloes += b.erloes; k.kosten += b.kosten; k.komplett++; if (b.umtausch) { k.umtauschKosten += b.umtausch.kosten; k.umtauschAnzahl += b.umtausch.anzahl; k.umtauschBestellungen++ } } else if (b.status === 'kosten-fehlen') { k.ohneKosten++; k.erloesOhneKosten += b.erloes } else { k.ohneShop++; k.kostenOhneShop += b.kosten }
  }
  for (const key of ['umtauschKosten', 'erloes', 'kosten', 'erloesOhneKosten', 'kostenOhneShop', 'erloesAlle', 'kostenAlle']) k[key] = rund(k[key])
  k.gewinn = rund(k.erloes - k.kosten)
  if (k.komplett) k.schnitt = rund(k.gewinn / k.komplett)
  if (k.erloes > 0) k.marge = k.gewinn / k.erloes
  return k
}

// Jahre aus den Daten + aktuelles Jahr (Monate gibt es immer alle zwölf)
export function jahreListe(dateien, aktuell = new Date().getFullYear(), basis = 'zahlung') {
  const jahre = new Set([String(aktuell)])
  const bestellDaten = basis === 'bestellung' ? bestelldatenMap(dateien) : null
  for (const d of dateien) {
    const datum = datumNachBasis(d.rechnung, basis, bestellDaten)
    if (datum) jahre.add(datum.slice(0, 4))
  }
  return [...jahre].sort().reverse()
}

// Bestellung (Einnahme) und Produktionsrechnung (Ausgabe) mit derselben Referenznummer gehören zusammen
export function verknuepfungen(dateien, doppelt = new Set()) {
  const map = new Map()
  for (const d of dateien) {
    const r = d.rechnung
    if (!r?.referenz || doppelt.has(d.id)) continue
    const e = map.get(r.referenz) || { erloes: 0, kosten: 0, bestellungen: 0, rechnungen: 0 }
    const b = betragVon(r) || 0
    if (r.art === 'einnahme') { e.erloes += b; e.bestellungen++ } else { e.kosten += b; e.rechnungen++ }
    map.set(r.referenz, e)
  }
  for (const e of map.values()) { e.erloes = rund(e.erloes); e.kosten = rund(e.kosten); e.gewinn = rund(e.erloes - e.kosten) }
  return map
}

export async function starten(ctx) {
  const m = ctx.maskieren
  // Umfeld (host.js): Vendo oder eigenständig im Browser, Windows ja/nein. Ältere Hauptteile kennen 'umgebung' nicht.
  const umgebung = { art: 'vendo', windows: true, zugaengeEinstellbar: false, ...((await (async () => ctx.aufrufen('umgebung'))().catch(() => null)) || {}) }
  let dateien = []
  let doppelt = new Set()
  let verkn = new Map()
  let menueAus = new Set() // ausgeblendete Tabs (Meine Angaben → Bereiche im Menü)
  let ansicht = 'uebersicht' // 'uebersicht' (Start, Schritt 4.5) | 'bestellungen' | 'rechnungen' | 'angaben' | 'steuer'
  const filter = { suche: '', lieferant: '', art: '', jahr: '', monat: '', feld: 'datum', feldB: 'datum', status: '' }
  filter.zahlungsbasis = 'zahlung'
  let abgleichLaeuft = null
  let anzeige = 50 // so viele Karten zeigen, den Rest per "Mehr anzeigen"
  let beschaeftigt = false
  const offen = new Set() // aufgeklappte Karten
  const texte = new Map() // geladene Originaltexte

  ctx.kopfKnoepfe.classList.add('rn-kopf-reihe')
  ctx.kopfKnoepfe.innerHTML = `
    <button class="knopf-gold" data-pdf-hinzufuegen type="button">PDF hinzufügen</button>
    <button class="knopf-mini" data-sync type="button">↻ Synchronisieren</button>
    <div class="rn-menue" data-menue="shirtigo">
      <button class="knopf-mini rn-menue-knopf" data-menue-knopf type="button" aria-haspopup="true" aria-expanded="false"><span class="rn-punkt-klein" aria-hidden="true"></span><span data-shirtigo-label>Shirtigo verbinden</span> <span aria-hidden="true">▾</span></button>
      <div class="rn-menue-korb" data-menue-korb hidden>
        <p class="rn-menue-titel leise" data-shirtigo-hinweis>API-Token aus dem Shirtigo-Cockpit einfügen.</p>
        <input data-shirtigo-token type="password" placeholder="API-Token aus dem Shirtigo-Cockpit" autocomplete="off" />
        <div class="rn-menue-zeile">
          <button class="knopf-mini" data-shirtigo-knopf type="button">Verbinden</button>
          <button class="knopf-mini" data-shirtigo-probe type="button">Shirtigo testen</button>
        </div>
      </div>
    </div>
    ${umgebung.zugaengeEinstellbar ? `<div class="rn-menue" data-menue="shopify">
      <button class="knopf-mini rn-menue-knopf" data-menue-knopf type="button" aria-haspopup="true" aria-expanded="false"><span class="rn-punkt-klein" aria-hidden="true"></span><span data-shopify-label>Shopify verbinden</span> <span aria-hidden="true">▾</span></button>
      <div class="rn-menue-korb" data-menue-korb hidden>
        <p class="rn-menue-titel leise" data-shopify-hinweis>Shop-Adresse und Admin-API-Zugriffstoken (shpat_…) einer eigenen App eintragen.</p>
        <input data-shopify-shop type="text" placeholder="mein-shop.myshopify.com" autocomplete="off" spellcheck="false" />
        <input data-shopify-token type="password" placeholder="Admin-API-Zugriffstoken" autocomplete="off" />
        <div class="rn-menue-zeile"><button class="knopf-mini" data-shopify-speichern type="button">Speichern</button></div>
      </div>
    </div>` : ''}
    <div class="rn-menue" data-menue="wartung">
      <button class="knopf-mini rn-menue-knopf" data-menue-knopf type="button" aria-haspopup="true" aria-expanded="false">⚙ Wartung <span aria-hidden="true">▾</span></button>
      <div class="rn-menue-korb" data-menue-korb hidden>
        <button class="knopf-mini" data-archiv-oeffnen type="button">Archiv-Ordner öffnen</button>
        <button class="knopf-mini" data-versiegeln type="button" title="Sendet nur einen Prüfwert (Hash), keine Belegdaten">Archiv versiegeln (Zeitstempel)</button>
        <button class="knopf-mini" data-siegel-pruefen type="button">Siegel prüfen</button>
        <button class="knopf-mini" data-usb-einrichten type="button">USB-Sicherung einrichten (Schlüssel)</button>
        <button class="knopf-mini" data-status-oeffnen type="button">Archiv-Status</button>
        <button class="knopf-mini" data-neufassung-planen type="button" title="Zeigt, welche Belege eine Neufassung bräuchten, öffnet eine Vorschau und erzeugt sie erst nach Rückfrage">Belege neu fassen …</button>
      </div>
    </div>`
  ctx.element.innerHTML = `
    <input class="rn-dateiauswahl" data-dateiauswahl type="file" accept=".pdf,application/pdf" multiple />
    <div class="rn-tabs" role="tablist" aria-label="Ansicht">
      <button type="button" role="tab" data-tab="uebersicht">Übersicht</button>
      <button type="button" role="tab" data-tab="bestellungen">Bestellungen</button>
      <button type="button" role="tab" data-tab="rechnungen">Rechnungen</button>
      <button type="button" role="tab" data-tab="angaben">Meine Angaben</button>
      <button type="button" role="tab" data-tab="steuer">Steuer</button>
    </div>
    <div class="rn-zahlungsbasis" data-zahlungsbasis data-listenteil ${['bestellungen', 'rechnungen'].includes(ansicht) ? '' : 'hidden'}>
      <span class="leise">Zählung:</span>
      <button type="button" class="knopf-mini${filter.zahlungsbasis === 'zahlung' ? ' rn-tab-an' : ''}" data-zahlungsbasis-button="zahlung" aria-pressed="${String(filter.zahlungsbasis === 'zahlung')}" ${filter.zahlungsbasis === 'zahlung' ? 'disabled' : ''}>nach Zahlungstag</button>
      <button type="button" class="knopf-mini${filter.zahlungsbasis === 'bestellung' ? ' rn-tab-an' : ''}" data-zahlungsbasis-button="bestellung" aria-pressed="${String(filter.zahlungsbasis === 'bestellung')}" ${filter.zahlungsbasis === 'bestellung' ? 'disabled' : ''}>nach Bestelldatum</button>
    </div>
    <div class="rn-kpis" data-kpis data-listenteil></div>
    <div class="rn-fix" data-fix data-listenteil></div>
    <div class="rn-monate" data-monate data-listenteil></div>
    <p class="rn-status leise" data-status aria-live="polite"></p>
    <section class="rn-karte rn-usb" data-usb hidden aria-label="USB-Sicherung einrichten"></section>
    <section class="rn-karte rn-usb" data-archivstatus hidden aria-label="Archiv-Status"></section>
    <section class="rn-karte rn-usb rn-dashboard" data-uebersicht hidden aria-label="Übersicht"></section>
    <section class="rn-karte rn-usb rn-angaben" data-angaben hidden aria-label="Meine Angaben"></section>
    <section class="rn-karte rn-usb rn-steuer" data-steuer hidden aria-label="Steuer"></section>
    <div class="rn-leiste" data-listenteil>
      <div class="rn-suchfeld">
        <input class="rn-suche" data-suche type="search" placeholder="Suchen: Lieferant, Kunde, Artikel, Design, Nummer …" aria-label="Suchen" />
        <button class="rn-punkt rn-punkt-gruen" data-punkt type="button" title="Keine Filter aktiv" aria-label="Keine Filter aktiv" disabled></button>
      </div>
      <select data-f-jahr aria-label="Jahr"></select>
      <select data-f-monat aria-label="Monat"></select>
      <select data-f-status data-nur="bestellungen" aria-label="Status"><option value="">Alle Bestellungen</option><option value="komplett">Nur vollständige</option><option value="offen">Es fehlt etwas</option><option value="storniert">Nur storniert</option></select>
      <select data-f-lieferant data-nur="rechnungen" aria-label="Lieferant"></select>
      <select data-f-art data-nur="rechnungen" aria-label="Art"><option value="">Einnahmen &amp; Ausgaben</option><option value="ausgabe">Nur Ausgaben</option><option value="einnahme">Nur Einnahmen</option></select>
      <select data-f-feld aria-label="Sortieren nach">${Object.entries(SORTIERUNG).map(([k, v]) => `<option value="${k}">Sortieren: ${v.label}</option>`).join('')}</select>
    </div>
    <div class="rn-zaehler leise" data-zaehler data-listenteil></div>
    <button class="knopf-mini" data-dup-entfernen type="button" hidden data-listenteil></button>
    <div class="rn-liste" data-liste data-listenteil></div>
    <button class="knopf-mini rn-mehr" data-mehr type="button" hidden data-listenteil></button>`

  const $ = (sel) => ctx.element.querySelector(sel)
  const eingabe = $('[data-dateiauswahl]')
  const status = (text = '') => { $('[data-status]').textContent = text }

  const gefiltert = () => filtern(dateien, filter, doppelt)
  const zeitraumLabel = () => {
    const mo = filter.monat ? MONATSNAMEN[+filter.monat - 1] : ''
    if (mo && !filter.jahr) return `${mo} · alle Jahre`
    return [mo, filter.jahr].filter(Boolean).join(' ')
  }

  const kachel = (titel, wert, klasse = '', hinweis = '') => `<div class="rn-kpi ${klasse}"><span class="rn-kpi-titel">${titel}</span><strong>${euro(wert)}</strong>${hinweis ? `<small>${hinweis}</small>` : ''}</div>`
  const prozent = (x) => (x == null ? '–' : `${(x * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`)
  const monatBalken = (label, wert, maximum, art) => `<span class="rn-monat-zeile" data-monat-zeile="${art}"><span class="rn-monat-label">${label}</span><span class="rn-monat-spur"><span class="rn-monat-fuellung rn-monat-${art}" data-monat-balken data-anteil="${maximum ? Math.min(100, Math.abs(wert) / maximum * 100).toFixed(1) : 0}"></span></span><b>${euro(wert)}</b></span>`
  const monatHtml = (key, werte, maximum, anzahl) => `<button type="button" class="rn-monat-eintrag ${filter.jahr === key.slice(0, 4) && filter.monat === key.slice(5, 7) ? 'rn-monat-an' : ''}" data-monat="${key}">
    <span class="rn-monat-kopf"><b>${m(monatText(key))}</b><small>${anzahl}</small></span>
    <span class="rn-monat-metriken">${monatBalken('Umsatz', werte.einnahmen, maximum, 'umsatz')}${monatBalken('Kosten', werte.ausgaben, maximum, 'kosten')}${monatBalken('Gewinn', werte.gewinn, maximum, werte.gewinn < 0 ? 'verlust' : 'gewinn')}</span>
  </button>`
  const monatsBalkenAktivieren = () => $('[data-monate]').querySelectorAll('[data-monat-balken]').forEach((b) => { b.style.width = `${b.dataset.anteil}%` })

  function kpisZeichnen() {
    const unter = zeitraumLabel() || 'alle Zeiträume'
    if (ansicht === 'bestellungen') {
      const alle = bestellungenListe(dateien, doppelt)
      const k = kennzahlenBestellungen(bestellungenFiltern(alle, filter))
      $('[data-kpis]').innerHTML =
        kachel('Umsatz', k.erloesAlle, 'rn-plus', `${k.anzahl} Bestellung${k.anzahl === 1 ? '' : 'en'} · ${unter}`) +
        kachel('Produktionskosten', k.kostenAlle, 'rn-minus', 'Shirtigo, inkl. MwSt – nur erfasste') +
        kachel('Gewinn', k.gewinn, k.gewinn >= 0 ? 'rn-plus rn-gross' : 'rn-minus rn-gross', `nur ${k.komplett} vollständige Bestellung${k.komplett === 1 ? '' : 'en'}`) +
        kachel('Ø je Bestellung', k.schnitt, (k.schnitt ?? 0) >= 0 ? 'rn-plus' : 'rn-minus', `Marge ${prozent(k.marge)}`)
      // Fixkosten ohne Bestellbezug (z. B. Shopify-Abo) im gleichen Zeitraum
      const fix = rund(filtern(dateien, { suche: '', lieferant: '', art: 'ausgabe', jahr: filter.jahr, monat: filter.monat, zahlungsbasis: filter.zahlungsbasis }, doppelt)
        .filter((d) => !d.rechnung.referenz).reduce((a, d) => a + (betragVon(d.rechnung) || 0), 0))
      const teile = []
      if (fix) teile.push(`<span>Fixkosten ohne Bestellbezug (z. B. Shopify-Abo): <b>${euro(fix)}</b> → Gewinn danach: <b class="${k.gewinn - fix >= 0 ? 'rn-plus' : 'rn-minus'}">${euro(rund(k.gewinn - fix))}</b></span>`)
      if (k.umtauschBestellungen) teile.push(`<span>Davon Umtausch/Größenfehler: <b class="rn-minus">${euro(k.umtauschKosten)}</b> (${k.umtauschAnzahl} Artikel in ${k.umtauschBestellungen} Bestellung${k.umtauschBestellungen === 1 ? '' : 'en'}) → ohne Umtausch läge der Gewinn bei <b class="${k.gewinn + k.umtauschKosten >= 0 ? 'rn-plus' : 'rn-minus'}">${euro(rund(k.gewinn + k.umtauschKosten))}</b></span>`)
      if (k.ohneShop) teile.push(`<span class="rn-warntext">${k.ohneShop} Shirtigo-Rechnung${k.ohneShop === 1 ? '' : 'en'} ohne Shopify-Bestellung (Kosten ${euro(k.kostenOhneShop)}) – noch nicht im Gewinn</span>`)
      $('[data-fix]').innerHTML = teile.join('')
      const monate = {}
      for (const b of bestellungenFiltern(alle, { ...filter, monat: '' })) {
        const key = (datumNachBasis(b, filter.zahlungsbasis) || '').slice(0, 7)
        if (!key) continue
        const x = (monate[key] ||= { n: 0, einnahmen: 0, ausgaben: 0, gewinn: 0 })
        x.n++
        x.einnahmen += b.erloes || 0
        x.ausgaben += b.kosten || 0
        if (b.komplett) x.gewinn += b.gewinn
      }
      const keys = filter.jahr ? Object.keys(monate).sort().reverse() : []
      const maximum = Math.max(0, ...keys.flatMap((key) => [monate[key].einnahmen, monate[key].ausgaben, monate[key].gewinn].map(Math.abs)))
      $('[data-monate]').innerHTML = keys.length > 1 ? keys.map((key) => monatHtml(key, monate[key], maximum, `${monate[key].n} Bestellung${monate[key].n === 1 ? '' : 'en'}`)).join('') : ''
      monatsBalkenAktivieren()
      return
    }
    const g = kennzahlen(gefiltert(), filter.zahlungsbasis, dateien)
    $('[data-fix]').innerHTML = ''
    $('[data-kpis]').innerHTML =
      kachel('Einnahmen', g.einnahmen, 'rn-plus', `ohne MwSt · ${unter}`) +
      kachel('Ausgaben', g.ausgaben, 'rn-minus', `inkl. MwSt · ${unter}`) +
      kachel('davon Versand', g.versand, '', 'in den Ausgaben enthalten') +
      kachel('Gewinn', g.gewinn, g.gewinn >= 0 ? 'rn-plus rn-gross' : 'rn-minus rn-gross', 'Einnahmen − Ausgaben')
    const monatszahlen = kennzahlen(filtern(dateien, { ...filter, monat: '' }, doppelt), filter.zahlungsbasis, dateien)
    const keys = filter.jahr ? Object.keys(monatszahlen.monate).filter((k) => k !== 'ohne').sort().reverse() : []
    const maximum = Math.max(0, ...keys.flatMap((key) => [monatszahlen.monate[key].einnahmen, monatszahlen.monate[key].ausgaben, monatszahlen.monate[key].gewinn].map(Math.abs)))
    $('[data-monate]').innerHTML = keys.length > 1 ? keys.map((key) => {
      const x = monatszahlen.monate[key]
      return monatHtml(key, x, maximum, `${x.anzahl} Beleg${x.anzahl === 1 ? '' : 'e'}`)
    }).join('') : ''
    monatsBalkenAktivieren()
  }

  function leisteZeichnen() {
    const bestell = ansicht === 'bestellungen'
    const lieferanten = [...new Set(dateien.map((d) => d.rechnung?.lieferant).filter(Boolean))].sort((x, y) => x.localeCompare(y, 'de'))
    // Anzahl je Monat (unter Beachtung der anderen Filter), damit man sieht, wo etwas liegt
    const proMonat = Array(12).fill(0)
    const daten = bestell ? bestellungenFiltern(bestellungenListe(dateien, doppelt), { ...filter, monat: '' }) : filtern(dateien, { ...filter, monat: '' }, doppelt)
    const bestellDaten = filter.zahlungsbasis === 'bestellung' ? bestelldatenMap(dateien) : null
      for (const x of daten) {
        const datum = bestell ? datumNachBasis(x, filter.zahlungsbasis) : datumNachBasis(x.rechnung, filter.zahlungsbasis, bestellDaten)
        const mm = +(datum || '').slice(5, 7)
        if (mm) proMonat[mm - 1]++
      }
    $('[data-f-jahr]').innerHTML = '<option value="">Alle Jahre</option>' + jahreListe(dateien, new Date().getFullYear(), filter.zahlungsbasis).map((j) => `<option value="${j}">${j}</option>`).join('')
    $('[data-f-monat]').innerHTML = '<option value="">Alle Monate</option>' + MONATSNAMEN.map((n, i) => `<option value="${String(i + 1).padStart(2, '0')}">${n}${proMonat[i] ? ` · ${proMonat[i]}` : ''}</option>`).join('')
    $('[data-f-lieferant]').innerHTML = '<option value="">Alle Lieferanten</option>' + lieferanten.map((l) => `<option value="${m(l)}">${m(l)}</option>`).join('')
    $('[data-f-feld]').innerHTML = bestell
      ? Object.entries(SORT_BESTELLUNG).map(([k, v]) => `<option value="${k}">Sortieren: ${v.label}</option>`).join('')
      : Object.entries(SORTIERUNG).map(([k, v]) => `<option value="${k}">Sortieren: ${v.label}</option>`).join('')
    if (![...$('[data-f-jahr]').options].some((o) => o.value === filter.jahr)) filter.jahr = ''
    if (![...$('[data-f-lieferant]').options].some((o) => o.value === filter.lieferant)) filter.lieferant = ''
    $('[data-f-jahr]').value = filter.jahr
    $('[data-f-monat]').value = filter.monat
    $('[data-f-lieferant]').value = filter.lieferant
    $('[data-f-art]').value = filter.art
    $('[data-f-status]').value = filter.status
    $('[data-f-feld]').value = bestell ? filter.feldB : filter.feld
    ctx.element.querySelectorAll('[data-nur]').forEach((el) => { el.hidden = el.dataset.nur !== ansicht })
    const basisContainer = ctx.element.querySelector('[data-zahlungsbasis]')
    if (basisContainer) basisContainer.hidden = !['bestellungen', 'rechnungen'].includes(ansicht)
    ctx.element.querySelectorAll('[data-zahlungsbasis-button]').forEach((el) => {
      const an = el.dataset.zahlungsbasisButton === filter.zahlungsbasis
      el.classList.toggle('rn-tab-an', an)
      el.setAttribute('aria-pressed', String(an))
      el.disabled = an
    })
    ctx.element.querySelectorAll('[data-tab]').forEach((b) => { const an = b.dataset.tab === ansicht; b.classList.toggle('rn-tab-an', an); b.setAttribute('aria-selected', String(an)) })
  }

  const filterAktiv = () => !!(filter.suche.trim() || filter.jahr || filter.monat || filter.zahlungsbasis !== 'zahlung' || (ansicht === 'bestellungen' ? filter.status : (filter.lieferant || filter.art)))
  function punktZeichnen() {
    const an = filterAktiv()
    const punkt = $('[data-punkt]')
    punkt.className = `rn-punkt ${an ? 'rn-punkt-rot' : 'rn-punkt-gruen'}`
    punkt.disabled = !an
    const text = an ? 'Filter aktiv – klicken zum Zurücksetzen' : 'Keine Filter aktiv'
    punkt.title = text
    punkt.setAttribute('aria-label', text)
  }

  // Eine Bestellung = Shopify-Rechnung (Erlös) + Shirtigo-Rechnung(en) (Kosten)
  function bestellKarte(b) {
    const auf = offen.has(`b-${b.referenz}`)
    const angezeigtesDatum = datumNachBasis(b, filter.zahlungsbasis)
    const st = b.storniert ? ['rn-grau', 'Storniert'] : { komplett: ['rn-gruen', '✓ Shop + Shirtigo'], 'kosten-fehlen': ['rn-gelb', 'Shirtigo-Rechnung fehlt'], 'shop-fehlt': ['rn-gelb', 'Shopify-Bestellung fehlt'] }[b.status]
    const erwartet = b.artikelShop + (b.umtausch?.anzahl || 0) // Umtausch-Artikel wurden zusätzlich produziert und sind keine Abweichung
    const abweichung = b.komplett && erwartet !== b.artikelKosten
    const retoureArtikel = (b.retouren || []).filter(istRetoure).reduce((s, x) => s + x.menge, 0)
    const klasse = b.gewinn == null ? '' : b.gewinn >= 0 ? 'rn-plus' : 'rn-minus'
    const anzahl = b.artikelShop || b.artikelKosten
    const weitereBadges = b.storniert ? '' : `${b.umtausch ? `<span class="rn-badge rn-gelb" title="Im Shop entfernt, bei Shirtigo aber produziert">↩ Umtausch · ${b.umtausch.anzahl} Artikel · −${euro(b.umtausch.kosten)}</span>` : ''}${retoureArtikel ? `<span class="rn-badge rn-gelb" title="Laut Shopify zurückgegeben und erstattet">↩ Retoure · ${retoureArtikel} Artikel</span>` : ''}${abweichung ? `<span class="rn-badge rn-gelb" title="Im Shop verkauft: ${b.artikelShop}${b.umtausch ? ` + Umtausch ${b.umtausch.anzahl}` : ''}, bei Shirtigo produziert: ${b.artikelKosten}">⚠ Artikelzahl ${erwartet} ≠ ${b.artikelKosten}</span>` : ''}`
    const spalte = (titel, docs, leer) => `<div class="rn-b-spalte"><h4>${titel}</h4>${docs.length ? docs.map((d) => {
      const r = d.rechnung
      const zeilen = r.positionen.map((p) => `<li class="${p.entfernt ? 'rn-entfernt' : ''}${b.umtausch?.zeilen.has(p) ? ' rn-retoure' : ''}"><span>${m(p.bezeichnung)}${[p.projekt, p.farbe, p.groesse].filter(Boolean).length ? ` <small>${[p.projekt, p.farbe, p.groesse].filter(Boolean).map(m).join(' · ')}</small>` : ''}${p.entfernt ? ' <small>(entfernt)</small>' : ''}${b.umtausch?.zeilen.has(p) ? ' <small>(Umtausch – ohne Erlös)</small>' : ''}</span><b>${euro(p.gesamt)}</b></li>`).join('')
      return `<div class="rn-b-doc"><div class="rn-b-docname">${m(r.lieferant || '')} ${m(r.rechnungsnummer || '')} · ${datumText(r.datum)}${r.zahlung?.datum && r.zahlung.datum !== r.datum ? ` · bezahlt ${datumText(r.zahlung.datum)}` : ''}</div><ul>${zeilen}</ul><div class="rn-b-docsumme"><span>Summe ${m(r.wirksamArt || '')}</span><b>${euro(betragVon(r))}</b></div>${d.beleg ? `<button class="knopf-mini" data-bestell-beleg="${m(d.id)}" type="button">${d.quelle === 'shopify' ? 'Beleg-PDF öffnen' : 'Original-PDF öffnen'}</button>` : ''}</div>`
    }).join('') : `<p class="leise rn-b-leer">${leer}</p>`}</div>`
    return `
      <article class="rn-karte rn-bestellung ${auf ? 'rn-auf' : ''} ${b.storniert ? 'rn-storniert' : b.komplett ? '' : 'rn-pruefen'}" data-bid="${m(b.referenz)}">
        <div class="rn-karte-kopf" data-umschalten role="button" tabindex="0" aria-expanded="${auf}">
          <span class="rn-pfeil" aria-hidden="true">▸</span>
          <div class="rn-titel">
            <strong>Bestellung #${m(b.referenz)} <span class="rn-nr">${m(b.kunde || 'Kunde unbekannt')}</span></strong>
            <small>${datumText(angezeigtesDatum)} · ${anzahl} Artikel${b.ort ? ` · ${m(b.ort)}` : ''}${b.komplett ? ` · Erlös ${euro(b.erloes)} − Kosten ${euro(b.kosten)}` : ''}</small>
          </div>
          <span class="rn-badges"><span class="rn-badge ${st[0]}">${st[1]}</span>${weitereBadges}</span>
          <div class="rn-betrag ${klasse}"><strong>${b.gewinn == null ? '–' : `${b.gewinn >= 0 ? '+' : '−'}${euro(Math.abs(b.gewinn))}`}</strong><small>${b.komplett ? `Gewinn · Marge ${prozent(b.marge)}` : 'Gewinn nicht berechenbar'}</small></div>
        </div>
        ${auf ? `
        <div class="rn-karte-koerper">
          ${b.umtausch ? `<ul class="rn-hinweis"><li>Umtausch/Größenwechsel: ${b.umtausch.anzahl} im Shop entfernte Artikel wurden bei Shirtigo trotzdem produziert (${euro(b.umtausch.kosten)} Kosten ohne Erlös, in der Spalte „Shirtigo“ markiert). Gab es eine Reklamation oder Gutschrift von Shirtigo, mindert sich dieser Verlust.</li></ul>` : ''}
          ${(b.retouren || []).length ? `<ul class="rn-hinweis">${b.retouren.map((x) => `<li>Laut Shopify: ${x.menge}× ${m(x.bezeichnung || 'Artikel')}${x.variante ? ` (${m(x.variante)})` : ''} – ${RUECKGABE[x.art] || 'erstattet'}${x.datum ? `, ${datumText(x.datum)}` : ''}</li>`).join('')}</ul>` : ''}
          ${abweichung ? `<ul class="rn-warnliste"><li>Im Shop wurden ${b.artikelShop} Artikel verkauft${b.umtausch ? ` (+ ${b.umtausch.anzahl} Umtausch)` : ''}, bei Shirtigo ${b.artikelKosten} berechnet – bitte Größen und Mengen prüfen.</li></ul>` : ''}
          <div class="rn-b-spalten">
            ${spalte('Shopify · Erlös', b.shop, 'Noch keine Shopify-Rechnung zu dieser Bestellung hochgeladen.')}
            ${spalte('Shirtigo · Kosten', b.kostenDocs, 'Noch keine Shirtigo-Rechnung vorhanden – sie entsteht bei Shirtigo nach dem Versand.')}
          </div>
          ${b.komplett ? `<div class="rn-summenblock">
            <div><span>Erlös (Shop)</span><b>${euro(b.erloes)}</b></div>
            <div><span>− Produktionskosten (inkl. MwSt)</span><b>${euro(b.kosten)}</b></div>
            <div class="rn-linie rn-total"><span>Gewinn</span><b class="${klasse}">${euro(b.gewinn)}</b></div>
            <div><span>Marge</span><b>${prozent(b.marge)}</b></div>
            ${b.umtausch ? `<div class="rn-linie"><span>davon Umtausch-/Retourenkosten</span><b class="rn-minus">−${euro(b.umtausch.kosten)}</b></div><div><span>Gewinn ohne Umtausch</span><b>${euro(b.gewinnOhneUmtausch)}</b></div>` : ''}
          </div>` : '<p class="leise">Der Gewinn erscheint, sobald Shopify-Rechnung und Shirtigo-Rechnung zur selben Bestellnummer vorliegen.</p>'}
        </div>` : ''}
      </article>`
  }

  function verknHtml(r) {
    const v = r.referenz ? verkn.get(r.referenz) : null
    if (!v) return ''
    const beide = v.bestellungen && v.rechnungen
    return `<div class="rn-verkn">
      <div class="rn-verkn-kopf">Bestellung #${m(r.referenz)} · Gewinn</div>
      <div><span>Erlös (ohne MwSt)</span><b>${v.bestellungen ? euro(v.erloes) : 'Shopify-Bestellung fehlt'}</b></div>
      <div><span>Kosten (inkl. MwSt)</span><b>${v.rechnungen ? euro(v.kosten) : 'Produktionsrechnung fehlt'}</b></div>
      ${beide ? `<div class="rn-linie rn-total"><span>Gewinn dieser Bestellung</span><b class="${v.gewinn >= 0 ? 'rn-plus' : 'rn-minus'}">${euro(v.gewinn)}</b></div>` : ''}
    </div>`
  }

  function infoHtml(r) {
    const z = []
    if (r.anzahlEntfernt) z.push(`${r.anzahlEntfernt} Artikel entfernt bzw. erstattet (durchgestrichen) – zählen nicht mit.`)
    if (r.rabattEingerechnet) z.push(`Rabatt von ${euro(r.rabatt)} steckt bereits in den Einzelpreisen (nicht doppelt abgezogen).`)
    if (r.zusatzErstattung) z.push(`Zusätzliche Erstattung von ${euro(r.zusatzErstattung)} mindert den Umsatz.`)
    if (r.retouren?.length) z.push(`Laut Shopify zurückgegeben/erstattet: ${r.retouren.map((x) => `${x.menge}× ${x.bezeichnung || 'Artikel'}${x.variante ? ` (${x.variante})` : ''} – ${RUECKGABE[x.art] || 'erstattet'}`).join('; ')}.`)
    if (r.gutschrift) z.push(`Shirtigo-Gutschrift über ${euro(r.gutschrift)} (brutto) ist von den Kosten abgezogen.`)
    if (r.anbieter === 'shopify-api' && r.zahlung && !r.zahlung.bekannt) z.push('Zahlungsdatum noch unbekannt – wird beim nächsten „Synchronisieren“ aus Shopify geholt.')
    if (r.zahlung?.manuell) z.push('Überweisung: Als Zahlungsdatum gilt der Tag, an dem die Bestellung in Shopify als bezahlt markiert wurde. Bitte zeitnah markieren.')
    if (r.zahlung?.datum && r.datum && r.zahlung.datum.slice(0, 4) !== r.datum.slice(0, 4)) z.push(`Bestellt ${datumText(r.datum)}, bezahlt ${datumText(r.zahlung.datum)} – für Steuer und Grenzwerte zählt das Zahlungsjahr.`)
    if (r.p13b) z.push(r.p13b.steuerfrei ? `§ 13b: ${r.p13b.vermutetFrei ? 'vermutlich ' : ''}steuerfrei (z. B. Zahlungsdienst) – keine Umsatzsteuer fällig. Einstufung im Tab „Steuer“ prüfen.` : r.p13b.waehrungFehlt ? '§ 13b: Rechnung in Fremdwährung – bitte im Tab „Steuer“ den Euro-Betrag eintragen.' : `§ 13b: ${String(r.p13b.satz).replace('.', ',')} % = ${euro(r.p13b.steuer)} Umsatzsteuer für ${monatText(r.p13b.monat)} (Kz ${r.p13b.kz.join('/')}) – zählt zusätzlich als Ausgabe.`)
    if (r.kleinunternehmer) z.push('Kleinunternehmer (§ 19 UStG): keine MwSt ausgewiesen.')
    if (r.regelbesteuerung) z.push(`Regelbesteuerung (${String(r.regelbesteuerung).replace('.', ',')} %) laut „Meine Angaben“: enthaltene Umsatzsteuer ${euro(r.summen?.mwst)} zählt nicht als Einnahme.`)
    if (r.art !== 'einnahme' && r.wirksamArt === 'inkl. MwSt' && r.summen?.mwst) z.push(`Zählt inkl. MwSt (${euro(r.summen.mwst)}): Die Vorsteuer wird nicht beim Finanzamt geltend gemacht, die MwSt ist also echter Aufwand.`)
    return z.length ? `<ul class="rn-info">${z.map((t) => `<li>${m(t)}</li>`).join('')}</ul>` : ''
  }

  function karteHtml(d) {
    const r = d.rechnung
    const bestellDaten = filter.zahlungsbasis === 'bestellung' ? bestelldatenMap(dateien) : null
    const angezeigtesDatum = datumNachBasis(r, filter.zahlungsbasis, bestellDaten)
    const auf = offen.has(d.id)
    if (!d.scanStand || !r) {
      return `<article class="rn-karte" data-id="${m(d.id)}">
        <div class="rn-karte-kopf rn-offen-kopf">
          <div class="rn-titel"><strong title="${m(d.name)}">${m(d.name)}</strong><small>${datumText(d.zeit)} hinzugefügt · ${groesseText(d.groesse)}</small></div>
          <span class="rn-badge rn-grau">Noch nicht gelesen</span>
          <div class="rn-kopf-aktionen">
            <button class="knopf-gold knopf-mini" data-scannen type="button">Lokal scannen</button>
            <button class="knopf-mini" data-ausblenden type="button" aria-label="${m(d.name)} ausblenden" title="Bleibt im Belegarchiv">Ausblenden</button>
          </div>
        </div></article>`
    }
    const s = r.summen
    const ok = r.pruefung?.ok
    const artikelSumme = r.positionen.filter((p) => p.typ !== 'versand' && !p.entfernt).reduce((a, p) => a + p.gesamt, 0)
    const ausgabe = r.art !== 'einnahme'
    const betrag = betragVon(r)
    const meta = [
      // Verkäufe (Umsatzbelege, Phase 5.1): eigener Shop ist Verkäufer, die Nummer ist die Belegnummer, keine Rechnung
      [ausgabe ? 'Lieferant' : 'Verkäufer', r.lieferant], [ausgabe ? 'Rechnungs-Nr.' : 'Beleg-Nr.', r.rechnungsnummer], ['Datum', datumText(r.datum)],
      ['Bestell-Nr.', r.bestellnummer], ['Shopify-Bestellung', r.referenz ? `#${r.referenz}` : null],
      ['Empfänger', r.empfaenger?.name], ['Zahlung', r.zahlung?.art ? `${r.zahlung.art}${r.zahlung.bezahlt ? ' · bezahlt' : ''}` : null],
      // Zahlungsdatum aus den Shopify-Transaktionen (Schritt 4.1): zählt für Steuer und Grenzwerte, nicht das Bestelldatum
      r.zahlung?.datum ? ['Bezahlt am', datumText(r.zahlung.datum) + (r.zahlung.eingaenge?.length > 1 ? ` (${r.zahlung.eingaenge.length} Zahlungen)` : '')] : null,
      r.zahlung?.erstattungen?.length ? ['Erstattet', r.zahlung.erstattungen.map((e) => `${euro(e.betrag)} am ${datumText(e.datum)}`).join(', ')] : null,
      r.offen > 0 ? ['Offener Betrag', euro(r.offen)] : null,
      ['Gelesen mit', `${METHODE[d.methode] || d.methode} · ${d.seiten} S.`]
    ].filter(Boolean).filter(([, v]) => v && v !== '–')
    const zeilen = r.positionen.map((p) => `
      <tr class="${p.entfernt ? 'rn-entfernt' : ''}">
        <td><div class="rn-pos"><span class="rn-typ ${p.entfernt ? 'rn-typ-entfernt' : `rn-typ-${m(p.typ)}`}">${p.entfernt ? 'Entfernt' : (TYP[p.typ] || m(p.typ))}</span><div><div>${m(p.bezeichnung)}</div>
          ${p.projekt || p.farbe || p.zeitraum ? `<small>${[p.projekt && `Design: ${m(p.projekt)}`, p.farbe && m(p.farbe), p.groesse && `Gr. ${m(p.groesse)}`, p.zeitraum && m(p.zeitraum)].filter(Boolean).join(' · ')}</small>` : ''}</div></div></td>
        <td class="rn-zahl">${p.menge}</td><td class="rn-zahl">${p.ursprungspreis && p.ursprungspreis !== p.einzelpreis ? `<s class="leise">${euro(p.ursprungspreis)}</s> ` : ''}${euro(p.einzelpreis)}</td><td class="rn-zahl"><b>${euro(p.gesamt)}</b></td>
      </tr>`).join('')
    return `
      <article class="rn-karte ${auf ? 'rn-auf' : ''} ${ok ? '' : 'rn-pruefen'}" data-id="${m(d.id)}">
        <div class="rn-karte-kopf" data-umschalten role="button" tabindex="0" aria-expanded="${auf}">
          <span class="rn-pfeil" aria-hidden="true">▸</span>
          <div class="rn-titel">
            <strong>${m(r.lieferant || d.name)} <span class="rn-nr">${m(r.rechnungsnummer || '')}</span></strong>
            <small>${datumText(angezeigtesDatum)} · ${r.anzahlPositionen} Position${r.anzahlPositionen === 1 ? '' : 'en'}${r.referenz ? ` · Bestellung #${m(r.referenz)}` : ''}${r.empfaenger ? ` · ${m(r.empfaenger.name)}` : ''}</small>
          </div>
          ${doppelt.has(d.id) ? '<span class="rn-badge rn-grau">Duplikat · zählt nicht mit</span>' : ok && r.nurDaten ? '<span class="rn-badge rn-grau">Shirtigo-Daten · PDF fehlt</span>' : `<span class="rn-badge ${ok ? 'rn-gruen' : 'rn-gelb'}">${ok ? '✓ Summen stimmen' : '⚠ Bitte prüfen'}</span>`}
          <div class="rn-betrag ${ausgabe ? 'rn-minus' : 'rn-plus'}"><strong>${ausgabe ? '−' : '+'}${euro(betrag)}</strong><small>${ausgabe ? 'Ausgabe' : 'Einnahme'} ${m(r.wirksamArt || 'netto')}</small></div>
        </div>
        ${auf ? `
        <div class="rn-karte-koerper">
          ${ok ? '' : `<ul class="rn-warnliste">${(r.pruefung?.hinweise || []).map((h) => `<li>${m(h)}</li>`).join('')}</ul>`}
          <div class="rn-meta">${meta.map(([k, v]) => `<div><span>${k}</span><b>${m(v)}</b></div>`).join('')}</div>
          <div class="rn-tabellenrahmen"><table class="rn-tabelle">
            <thead><tr><th>Position</th><th class="rn-zahl">Menge</th><th class="rn-zahl">Einzelpreis</th><th class="rn-zahl">Gesamt</th></tr></thead>
            <tbody>${zeilen || '<tr><td colspan="4" class="leise">Keine Positionen erkannt – Originaltext prüfen.</td></tr>'}</tbody>
          </table></div>
          ${infoHtml(r)}
          ${s ? `<div class="rn-summenblock">
            <div><span>Artikel &amp; Zusatz</span><b>${euro(artikelSumme)}</b></div>
            <div><span>Versand</span><b>${euro(r.versand)}</b></div>
            <div class="rn-linie"><span>Netto</span><b>${euro(s.netto)}</b></div>
            <div><span>MwSt${s.mwstSatz ? ` (${s.mwstSatz} %)` : ''}${r.reverseCharge ? ' · Reverse-Charge' : ''}</span><b>${euro(s.mwst)}</b></div>
            <div class="rn-linie rn-total"><span>Brutto</span><b>${euro(s.brutto)}</b></div>
          </div>` : ''}
          ${verknHtml(r)}
          <div class="rn-aktionen">
            ${d.quelle === 'shopify' || d.beleg ? `<button class="knopf-mini" data-oeffnen type="button">${d.quelle === 'shopify' ? 'Beleg-PDF öffnen' : 'Original-PDF öffnen'}</button>`
              : d.quelle === 'shopify-gebuehr' ? '<span class="leise">Gebühren laut Shopify-Zahlungsdaten, Datensatz im Belegarchiv</span>'
              : d.quelle ? '<button class="knopf-mini" data-pdf-holen type="button">Original-PDF bei Shirtigo holen</button><span class="leise">Nur Daten aus Shirtigo – oder die PDF in „Shirtigo Rechnungen“ ablegen und einlesen</span>'
              : `<button class="knopf-mini" data-scannen type="button">Erneut scannen</button>
            <button class="knopf-mini" data-text type="button">${texte.has(d.id) ? 'Originaltext ausblenden' : 'Originaltext anzeigen'}</button>
            <button class="knopf-mini" data-ausblenden type="button" aria-label="${m(d.name)} ausblenden" title="Bleibt im Belegarchiv">Ausblenden</button>`}
            <span class="rn-dateiname leise" title="${m(d.name)}">${m(d.name)} · ${groesseText(d.groesse)}</span>
          </div>
          ${texte.has(d.id) ? `<pre class="rn-text">${m(texte.get(d.id))}</pre>` : ''}
        </div>` : ''}
      </article>`
  }

  function zeichnen() {
    doppelt = duplikate(dateien)
    verkn = verknuepfungen(dateien, doppelt)
    const ungelesen = dateien.filter((d) => !d.scanStand || !d.rechnung).sort((x, y) => y.zeit - x.zeit)
    const gelesen = dateien.filter((d) => d.rechnung)
    let html
    let zaehler = ''
    let trefferAnzahl = 0
    if (ansicht === 'bestellungen') {
      const alle = bestellungenListe(dateien, doppelt)
      const treffer = bestellungenSortieren(bestellungenFiltern(alle, filter), filter.feldB, filter.zahlungsbasis)
      trefferAnzahl = treffer.length
      html = [...ungelesen.map(karteHtml), ...treffer.slice(0, anzeige).map(bestellKarte)].join('')
      if (!html) html = !dateien.length ? '<div class="leer-hinweis">Noch keine PDFs abgelegt.</div>'
        : !alle.length ? '<div class="leer-hinweis">Noch keine Bestellung erkannt. Lade die Shopify-Rechnungen und die Shirtigo-Rechnungen hoch – sie werden über die Bestellnummer zusammengeführt.</div>'
        : `<div class="leer-hinweis">${zeitraumLabel() ? `Keine Bestellungen im Zeitraum ${m(zeitraumLabel())}.` : 'Keine Bestellung passt zu den Filtern.'}</div>`
      zaehler = alle.length ? `${treffer.length} von ${alle.length} Bestellungen${doppelt.size ? ` · ${doppelt.size} Duplikat${doppelt.size === 1 ? '' : 'e'} nicht mitgezählt` : ''}` : ''
    } else {
      const treffer = sortieren(gefiltert(), filter.feld, filter.zahlungsbasis, dateien)
      trefferAnzahl = treffer.length
      const dupKarten = gelesen.filter((d) => doppelt.has(d.id)) // Duplikate separat am Ende, zählen nicht
      html = [...ungelesen, ...treffer.slice(0, anzeige), ...(filterAktiv() ? [] : dupKarten)].map(karteHtml).join('')
      if (!html) html = dateien.length ? `<div class="leer-hinweis">${zeitraumLabel() ? `Keine Rechnungen im Zeitraum ${m(zeitraumLabel())}.` : 'Keine Rechnung passt zu den Filtern.'}</div>` : '<div class="leer-hinweis">Noch keine PDFs abgelegt.</div>'
      zaehler = gelesen.length ? `${treffer.length} von ${gelesen.length - doppelt.size} Rechnungen${doppelt.size ? ` · ${doppelt.size} Duplikat${doppelt.size === 1 ? '' : 'e'} nicht mitgezählt` : ''}` : ''
    }
    $('[data-liste]').innerHTML = html
    $('[data-zaehler]').textContent = zaehler
    const dupManuell = dateien.filter((d) => doppelt.has(d.id) && !d.quelle) // selbst eingelesene PDFs, die es schon über die Schnittstelle gibt
    $('[data-dup-entfernen]').hidden = !dupManuell.length
    $('[data-dup-entfernen]').textContent = `${dupManuell.length} doppelte eingelesene PDF${dupManuell.length === 1 ? '' : 's'} ausblenden`
    const rest = trefferAnzahl - anzeige
    $('[data-mehr]').hidden = rest <= 0
    $('[data-mehr]').textContent = `Mehr anzeigen (${rest} weitere)`
    punktZeichnen()
    kpisZeichnen()
  }

  // Bestellorte an den Reaktor (Globus) melden. Der Reaktor hört auf "vendo:orte"; der letzte Stand liegt in window.vendoOrte,
  // damit ein später erstellter Reaktor ihn auch bekommt.
  async function orteMelden() {
    try {
      const orte = await ctx.aufrufen('bestellOrte')
      window.vendoOrte = orte
      window.dispatchEvent(new CustomEvent('vendo:orte', { detail: orte }))
    } catch { /* der Globus ist nur Zierde, er darf die Ansicht nie stören */ }
  }

  async function summeLaden() {
    leisteZeichnen()
    zeichnen()
    orteMelden()
  }

  async function laden() {
    dateien = await ctx.aufrufen('liste')
    await summeLaden()
    if (ansicht === 'steuer') await steuerZeichnen() // nach einem Abgleich: Steuer-Tab mit neuen Zahlen
    if (ansicht === 'uebersicht' && !uebersichtFeld.hidden) await dashboardZeichnen()
  }

  const alsBase64 = (datei) => new Promise((fertig, fehler) => {
    const leser = new FileReader()
    leser.onload = () => fertig(String(leser.result).replace(/^data:[^,]*,/, ''))
    leser.onerror = () => fehler(new Error('Datei konnte nicht gelesen werden'))
    leser.readAsDataURL(datei)
  })
  async function hinzufuegen(liste) {
    if (beschaeftigt) return
    beschaeftigt = true
    const erfolgreich = []
    const fehler = []
    for (const datei of liste) {
      if (!/\.pdf$/i.test(datei.name)) { fehler.push(`${datei.name}: keine PDF-Datei`); continue }
      try {
        // Vendo gibt den Dateipfad (ctx.pfadVon), im Browser (eigenständig) wird der Inhalt übertragen
        if (ctx.pfadVon) {
          const pfad = ctx.pfadVon(datei)
          if (!pfad) throw new Error('Dateipfad nicht verfügbar')
          erfolgreich.push(await ctx.aufrufen('hinzufuegen', { pfad, name: datei.name }))
        } else {
          erfolgreich.push(await ctx.aufrufen('hinzufuegen', { inhalt: await alsBase64(datei), name: datei.name }))
        }
      } catch (e) {
        fehler.push(`${datei.name}: ${e.message}`)
      }
    }
    dateien = [...dateien, ...erfolgreich]
    zeichnen()
    status(fehler.length ? fehler.join(' · ') : `${erfolgreich.length} PDF${erfolgreich.length === 1 ? '' : 's'} abgelegt – jetzt „Lokal scannen“ klicken.`)
    beschaeftigt = false
  }

  async function scannen(id, knopf) {
    if (beschaeftigt) return
    beschaeftigt = true
    if (knopf) { knopf.disabled = true; knopf.textContent = 'Liest …' }
    status('Lese PDF lokal aus. Bei Scans kann das etwas dauern …')
    try {
      const ergebnis = await ctx.aufrufen('scannen', id)
      dateien = await ctx.aufrufen('liste')
      if (texte.has(id)) texte.set(id, ergebnis.text)
      offen.add(id)
      await summeLaden()
      status(`${ergebnis.seiten} Seite${ergebnis.seiten === 1 ? '' : 'n'} gelesen (${METHODE[ergebnis.methode]}) · ${ergebnis.rechnung?.anzahlPositionen ?? 0} Positionen erkannt.`)
    } catch (fehler) {
      status(`Auslesen fehlgeschlagen: ${fehler.message}`)
    } finally {
      beschaeftigt = false
      zeichnen()
    }
  }

  ctx.kopfKnoepfe.querySelector('[data-pdf-hinzufuegen]').addEventListener('click', () => eingabe.click())
  ctx.kopfKnoepfe.querySelector('[data-sync]').addEventListener('click', () => abgleichen())
  eingabe.addEventListener('change', async () => { await hinzufuegen([...eingabe.files]); eingabe.value = '' })

  const umschalten = (id) => { offen.has(id) ? offen.delete(id) : offen.add(id); zeichnen() }
  const liste = $('[data-liste]')
  const schluessel = (el) => (el.dataset.bid ? `b-${el.dataset.bid}` : el.dataset.id)
  liste.addEventListener('keydown', (e) => {
    const kopf = e.target.closest('[data-umschalten]')
    if (kopf && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); umschalten(schluessel(kopf.closest('[data-id],[data-bid]'))) }
  })
  liste.addEventListener('click', async (e) => {
    const bestellung = e.target.closest('[data-bid]')
    if (bestellung) {
      const pdfKnopf = e.target.closest('[data-bestell-beleg]')
      if (pdfKnopf) { try { await ctx.aufrufen('belegOeffnen', pdfKnopf.dataset.bestellBeleg) } catch (f) { status(f.message) } return }
      if (e.target.closest('[data-umschalten]')) umschalten(schluessel(bestellung))
      return
    }
    const karte = e.target.closest('[data-id]')
    if (!karte) return
    const id = karte.dataset.id
    if (e.target.closest('[data-oeffnen]')) { try { await ctx.aufrufen('belegOeffnen', id) } catch (f) { status(f.message) } return }
    if (e.target.closest('[data-pdf-holen]')) return pdfHolen()
    const scanKnopf = e.target.closest('[data-scannen]')
    if (scanKnopf) return scannen(id, scanKnopf)
    if (e.target.closest('[data-text]')) {
      if (texte.has(id)) texte.delete(id)
      else {
        try { texte.set(id, await ctx.aufrufen('textHolen', id)) } catch (fehler) { status(fehler.message); return }
      }
      return zeichnen()
    }
    if (e.target.closest('[data-ausblenden]')) {
      if (!(await ctx.bestaetigen('Dieses PDF in der Liste ausblenden? Es zählt dann nicht mehr mit. Die Datei bleibt unverändert im Belegarchiv (Aufbewahrungspflicht).', { titel: 'PDF ausblenden', ja: 'Ausblenden' }))) return
      try {
        await ctx.aufrufen('ausblenden', id)
        dateien = dateien.filter((d) => d.id !== id)
        texte.delete(id)
        offen.delete(id)
        await summeLaden()
        status('PDF ausgeblendet – im Belegarchiv bleibt es erhalten.')
        zeichnen()
      } catch (fehler) {
        status(fehler.message)
      }
      return
    }
    if (e.target.closest('[data-umschalten]')) umschalten(id)
  })

  // Filter & Sortierung
  const neu = () => { anzeige = 50; leisteZeichnen(); zeichnen() }
  $('[data-dup-entfernen]').addEventListener('click', async () => {
    const ids = dateien.filter((d) => doppelt.has(d.id) && !d.quelle).map((d) => d.id)
    if (!ids.length) return
    if (!(await ctx.bestaetigen(`${ids.length} selbst eingelesene PDF-Einträge ausblenden, die es schon über Shopify/Shirtigo gibt? Sie zählen dann nicht doppelt. Deine Originaldateien und das Belegarchiv bleiben unberührt.`, { titel: 'Duplikate ausblenden', ja: 'Ausblenden' }))) return
    let n = 0
    for (const id of ids) { try { await ctx.aufrufen('ausblenden', id); n++ } catch { /* weiter */ } }
    dateien = await ctx.aufrufen('liste')
    await summeLaden()
    status(`${n} doppelte PDF${n === 1 ? '' : 's'} ausgeblendet.`)
  })
  ctx.kopfKnoepfe.querySelector('[data-archiv-oeffnen]').addEventListener('click', async () => {
    try { status(`Archiv: ${await ctx.aufrufen('archivOeffnen')} (Belege nach Jahr und Art, Index: index.jsonl)`) } catch (e) { status(e.message) }
  })
  // Zeitstempel (Schritt 1.7): Archivstand extern versiegeln und Siegel prüfen
  const stempelZeit = (iso) => iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–'
  ctx.kopfKnoepfe.querySelector('[data-versiegeln]').addEventListener('click', async (e) => {
    const knopf = e.currentTarget
    knopf.disabled = true
    menuesSchliessen()
    status('Versiegele das Archiv bei Sectigo und FreeTSA (es wird nur ein Prüfwert gesendet) …')
    try {
      const r = await ctx.aufrufen('versiegeln')
      const dienste = r.dienste.map((d) => d.ok ? `${d.name} ✓ ${stempelZeit(d.zeit)}` : `${d.name} ✗ (${d.fehler})`).join(' · ')
      status(r.ok ? `Archiv versiegelt: ${r.archivEintraege} Einträge · ${dienste}${r.schutzFehler ? ' · Windows-Schutz: ' + r.schutzFehler[0] : ''}` : `Nicht versiegelt – kein Dienst hat geantwortet: ${dienste}`)
    } catch (f) { status(f.message) } finally { knopf.disabled = false }
  })
  ctx.kopfKnoepfe.querySelector('[data-siegel-pruefen]').addEventListener('click', async () => {
    menuesSchliessen()
    try {
      const p = await ctx.aufrufen('siegelPruefen')
      if (!p.anzahl) return status('Noch kein Siegel vorhanden. „Archiv versiegeln“ legt das erste an.')
      const offen = p.nochNichtVersiegelt ? ` · ${p.nochNichtVersiegelt} Beleg(e) seitdem noch nicht versiegelt` : ' · alles versiegelt'
      const fehler = p.ergebnisse.filter((x) => !x.ok).map((x) => x.fehler[0] || x.stempel.find((s) => !s.ok)?.fehler).filter(Boolean)
      status(p.ok ? `${p.anzahl} Siegel geprüft, alle gültig · zuletzt ${stempelZeit(p.zuletzt?.zeit)}${offen}` : `Siegelprüfung: PROBLEM – ${fehler[0] || 'siehe Wartung'}`)
    } catch (f) { status(f.message) }
  })
  // ---------- USB-Sicherung: Wiederherstellungsschlüssel (Schritt 1.8) ----------
  // Der Schlüssel steht nur im Blatt, solange es offen ist; danach wird er aus der Seite entfernt.
  const usb = $('[data-usb]')
  let usbNeu = null
  const datumZeit = (iso) => iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–'
  const usbBlattHtml = (k) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Vendo – Wiederherstellungsblatt</title>
    <style>body{font-family:"Segoe UI",Arial,sans-serif;margin:36px;color:#000}h1{font-size:20px;margin:0 0 6px}.k{font:700 24px/1.5 Consolas,monospace;letter-spacing:2px;border:2px solid #000;padding:12px 18px;display:inline-block;margin:14px 0}li{margin:7px 0}</style></head><body>
    <h1>Vendo – Wiederherstellungsblatt für die USB-Sicherung</h1>
    <p>Kennung: <strong>${m(k.kennung)}</strong> · erstellt am ${m(datumZeit(k.erstellt))}</p>
    <div class="k">${m(k.schluessel)}</div>
    <ol>
      <li>Du brauchst dieses Blatt nur, wenn der PC kaputt oder weg ist und die Belege vom USB-Stick auf einem anderen PC wiederhergestellt werden sollen.</li>
      <li>Bewahre das Blatt <strong>nicht</strong> beim USB-Stick auf – wer beides findet, kann die Sicherung öffnen.</li>
      <li>Wiederherstellen: Vendo installieren → Rechnungen → ⚙ Wartung → „USB-Sicherung einrichten“ → „Ich habe schon ein Wiederherstellungsblatt“ → Schlüssel eintippen.</li>
      <li>Die Kennung steht auch auf dem Stick. So erkennst du, welches Blatt zu welchem Stick gehört.</li>
    </ol></body></html>`
  function usbDrucken() {
    if (!usbNeu) return
    const rahmen = document.createElement('iframe')
    rahmen.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0'
    rahmen.srcdoc = usbBlattHtml(usbNeu)
    rahmen.addEventListener('load', () => { rahmen.contentWindow.focus(); rahmen.contentWindow.print(); setTimeout(() => rahmen.remove(), 1000) })
    document.body.appendChild(rahmen)
  }
  function usbSchliessen() { usbNeu = null; usb.innerHTML = ''; usb.hidden = true }
  const mb = (b) => `${(b / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`
  const gb = (b) => `${(b / 1e9).toLocaleString('de-DE', { maximumFractionDigits: 1 })} GB`
  // Sicherungsteil des USB-Felds: Sticks suchen, Probelauf anzeigen, Knöpfe freigeben
  async function usbSicherungZeichnen(gewaehlt = null) {
    const auswahl = usb.querySelector('[data-usb-laufwerk]')
    if (!auswahl) return
    const st = await ctx.aufrufen('usbStatus')
    usb.querySelector('[data-usb-letzte]').textContent = st.letzteSicherung ? `Letzte Sicherung: ${datumZeit(st.letzteSicherung)} auf „${st.laufwerk}“${st.erinnern ? ` – vor ${st.tageSeit} Tagen, bitte wieder sichern` : ''}` : 'Noch keine Sicherung auf einem USB-Stick.'
    const liste = await ctx.aufrufen('usbLaufwerke')
    auswahl.innerHTML = liste.map((l) => `<option value="${m(l.laufwerk)}">${m(l.laufwerk)} ${m(l.name || 'USB-Stick')} · ${m(l.dateisystem)} · ${m(gb(l.frei))} frei${l.vendo ? ' · enthält Vendo-Sicherung' : ''}</option>`).join('')
    if (gewaehlt && liste.some((l) => l.laufwerk === gewaehlt)) auswahl.value = gewaehlt
    const knoepfe = [usb.querySelector('[data-usb-sichern]'), usb.querySelector('[data-usb-stick-pruefen]')]
    const plan = usb.querySelector('[data-usb-plan]')
    if (!liste.length) { plan.textContent = 'Kein USB-Stick gefunden. Bitte einstecken und „Neu suchen“ drücken.'; knoepfe.forEach((k) => { k.disabled = true }); return }
    try {
      const p = await ctx.aufrufen('usbPlan', auswahl.value)
      if (!p.archivOk) plan.textContent = `Das Archiv meldet ${p.archivFehler} Fehler – erst klären, dann sichern.`
      else if (!p.passt) plan.textContent = `Zu wenig Platz: nötig bis zu ${mb(p.bytes)}, frei ${mb(p.frei)}.`
      else plan.textContent = p.neu ? `Probelauf: ${p.neu} von ${p.eintraege} Dateien (${mb(p.bytes)}) würden verschlüsselt auf ${p.laufwerk.laufwerk} geschrieben. Nichts wird gelöscht.` : `Alles schon auf dem Stick (${p.eintraege} Dateien). Eine Sicherung legt nur einen neuen Stand an und prüft den Stick.`
      knoepfe[0].disabled = !p.archivOk || !p.passt
      knoepfe[1].disabled = !p.schonGesichert
    } catch (f) { plan.textContent = f.message; knoepfe.forEach((k) => { k.disabled = true }) }
  }
  async function usbZeichnen(hinweis = '') {
    if (!umgebung.windows) { // USB-Laufwerkssuche und Archivschutz gibt es nur unter Windows: Hinweis statt Fehler
      usb.hidden = false
      usb.innerHTML = `<div class="rn-usb-kopf"><strong>USB-Sicherung</strong><button class="knopf-mini" data-usb-schliessen type="button">Schließen</button></div>
        <p class="leise">Die USB-Sicherung gibt es derzeit nur unter Windows. Bitte den Archivordner auf diesem System mit einer eigenen, verschlüsselten Sicherung mitsichern.</p>`
      return
    }
    const s = await ctx.aufrufen('usbSchluesselStatus')
    usb.hidden = false
    const kopf = `<div class="rn-usb-kopf"><strong>USB-Sicherung einrichten</strong><button class="knopf-mini" data-usb-schliessen type="button">Schließen</button></div>`
    const fehler = hinweis ? `<p class="rn-usb-fehler" role="alert">${m(hinweis)}</p>` : ''
    if (usbNeu && !s.bestaetigt) {
      usb.innerHTML = `${kopf}
        <p><strong>Schritt 1:</strong> Drucke das Wiederherstellungsblatt aus oder schreibe den Schlüssel ab. Er wird hier nur jetzt angezeigt.</p>
        <p class="leise">Kennung ${m(usbNeu.kennung)}</p>
        <p class="rn-usb-schluessel">${m(usbNeu.schluessel)}</p>
        <p><button class="knopf-gold knopf-mini" data-usb-drucken type="button">Blatt drucken</button></p>
        <p><strong>Schritt 2:</strong> Tippe den Schlüssel zur Kontrolle vom Blatt ab (Groß/klein und Bindestriche egal).</p>
        <div class="rn-usb-zeile"><input data-usb-eingabe type="text" autocomplete="off" spellcheck="false" placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" aria-label="Wiederherstellungsschlüssel zur Kontrolle" /><button class="knopf-gold knopf-mini" data-usb-bestaetigen type="button">Bestätigen</button></div>
        <p class="leise">Bewahre das Blatt nicht beim USB-Stick auf.</p>${fehler}`
      return
    }
    if (s.bestaetigt) {
      usb.innerHTML = `${kopf}<p>✓ Wiederherstellungsschlüssel eingerichtet · Kennung <strong>${m(s.kennung)}</strong> · bestätigt am ${m(datumZeit(s.bestaetigtAm))}</p>
        <p class="leise" data-usb-letzte></p>
        <div class="rn-usb-zeile"><select data-usb-laufwerk aria-label="USB-Stick"></select><button class="knopf-mini" data-usb-suchen type="button">Neu suchen</button></div>
        <p class="leise" data-usb-plan>Suche USB-Sticks …</p>
        <div class="rn-usb-zeile"><button class="knopf-gold knopf-mini" data-usb-sichern type="button" disabled>Jetzt auf USB sichern</button><button class="knopf-mini" data-usb-stick-pruefen type="button" disabled>Stick prüfen</button></div>
        <p class="leise">Nach dem Sichern den Stick über Windows „Auswerfen“ und woanders aufbewahren als das Wiederherstellungsblatt.</p>${fehler}`
      await usbSicherungZeichnen()
      return
    }
    const warnung = !s.verschluesselung ? '<p class="rn-usb-fehler">Auf diesem System ist keine verschlüsselte Ablage verfügbar. Der Schlüssel kann nicht sicher gespeichert werden.</p>'
      : s.fehler ? `<p class="rn-usb-fehler">${m(s.fehler)}</p>`
        : s.vorhanden ? '<p class="leise">Es wurde schon ein Schlüssel erzeugt, aber nie bestätigt. Ein neuer ersetzt ihn – ein altes Blatt gilt dann nicht mehr.</p>' : ''
    usb.innerHTML = `${kopf}
      <p>Die Sicherung auf dem USB-Stick wird verschlüsselt. Dafür erzeugt Vendo einen <strong>Wiederherstellungsschlüssel</strong>. Du brauchst ihn nur, wenn dieser PC ausfällt. Ein Passwort musst du dir nicht ausdenken.</p>${warnung}
      <p><button class="knopf-gold knopf-mini" data-usb-erzeugen type="button" ${s.verschluesselung ? '' : 'disabled'}>Wiederherstellungsschlüssel erzeugen</button></p>
      <details><summary>Ich habe schon ein Wiederherstellungsblatt (neuer PC)</summary>
        <div class="rn-usb-zeile"><input data-usb-blatt type="text" autocomplete="off" spellcheck="false" placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" aria-label="Wiederherstellungsschlüssel vom Blatt" /><button class="knopf-mini" data-usb-eingeben type="button">Übernehmen</button></div>
      </details>${fehler}`
  }
  ctx.kopfKnoepfe.querySelector('[data-usb-einrichten]').addEventListener('click', async () => {
    menuesSchliessen()
    try { await usbZeichnen(); usb.scrollIntoView({ block: 'nearest' }) } catch (f) { status(f.message) }
  })
  usb.addEventListener('change', (e) => { if (e.target.matches('[data-usb-laufwerk]')) usbSicherungZeichnen(e.target.value) })
  usb.addEventListener('click', async (e) => {
    const ziel = e.target.closest('button')
    if (!ziel) return
    try {
      if (ziel.matches('[data-usb-schliessen]')) {
        if (usbNeu && !(await ctx.bestaetigen('Der Schlüssel ist noch nicht bestätigt. Schließen? Er wird dann nicht mehr angezeigt, und du musst später einen neuen erzeugen.', { titel: 'Einrichtung abbrechen', ja: 'Schließen' }))) return
        return usbSchliessen()
      }
      if (ziel.matches('[data-usb-erzeugen]')) { usbNeu = await ctx.aufrufen('usbSchluesselNeu'); return usbZeichnen() }
      if (ziel.matches('[data-usb-drucken]')) return usbDrucken()
      if (ziel.matches('[data-usb-suchen]')) return usbSicherungZeichnen(usb.querySelector('[data-usb-laufwerk]')?.value)
      if (ziel.matches('[data-usb-sichern]')) {
        const lw = usb.querySelector('[data-usb-laufwerk]').value
        ziel.disabled = true
        status(`Sichere verschlüsselt auf ${lw} … (bitte den Stick nicht abziehen)`)
        const r = await ctx.aufrufen('usbSichern', lw)
        status(r.ok ? `USB-Sicherung fertig: ${r.neu} neu, ${r.schonDa} schon vorhanden, ${r.kontrolle.geprueft} Dateien auf dem Stick geprüft ✓${r.persoenlich ? ', persönliche Angaben verschlüsselt mit' : ''} · Kennung ${r.kennung}.${r.persoenlichFehler ? ` ${r.persoenlichFehler}.` : ''} Stick jetzt auswerfen.` : `USB-Sicherung NICHT vollständig: ${[...r.fehler, ...(r.kontrolle?.fehler || [])][0] || 'unbekannter Fehler'}`)
        return usbSicherungZeichnen(lw)
      }
      if (ziel.matches('[data-usb-stick-pruefen]')) {
        const lw = usb.querySelector('[data-usb-laufwerk]').value
        status(`Prüfe die Sicherung auf ${lw} …`)
        const p = await ctx.aufrufen('usbPruefen', lw)
        return status(p.ok ? `Stick geprüft: alle ${p.geprueft} Dateien lesbar und unverändert ✓ (${p.staende} Sicherungsstände, neuester vom ${datumZeit(p.erstellt)}).` : `Stick-Prüfung: ${p.fehler.length} Problem(e) – ${p.fehler[0]}`)
      }
      if (ziel.matches('[data-usb-bestaetigen]')) {
        await ctx.aufrufen('usbSchluesselBestaetigen', usb.querySelector('[data-usb-eingabe]').value)
        usbNeu = null
        status('Wiederherstellungsschlüssel bestätigt und verschlüsselt gespeichert.')
        return usbZeichnen()
      }
      if (ziel.matches('[data-usb-eingeben]')) {
        await ctx.aufrufen('usbSchluesselEingeben', usb.querySelector('[data-usb-blatt]').value)
        status('Wiederherstellungsschlüssel vom Blatt übernommen.')
        return usbZeichnen()
      }
    } catch (f) {
      const eingaben = [...usb.querySelectorAll('input')].map((i) => i.value) // Eingaben nach dem Neuzeichnen behalten
      await usbZeichnen(f.message)
      usb.querySelectorAll('input').forEach((i, n) => { i.value = eingaben[n] || '' })
    }
  })
  // ---------- Archiv-Status (Schritt 1.10) ----------
  const statusFeld = $('[data-archivstatus]')
  const tageText = (n) => n === 0 ? 'heute' : n === 1 ? 'gestern' : `vor ${n} Tagen`
  const statusZeile = (ok, titel, text, knopf = '') => `<li class="rn-st-zeile"><span class="rn-st-zeichen rn-st-${ok === true ? 'ok' : ok === false ? 'warn' : 'info'}" aria-hidden="true">${ok === true ? '✓' : ok === false ? '⚠' : 'ⓘ'}</span><div><strong>${m(titel)}</strong><br><span class="leise">${m(text)}</span></div>${knopf}</li>`
  // Datenbank (Index der Buchhaltung) und wöchentliche Gegenprobe Datenbank = Archiv (D.3)
  const datenbankZeile = (db) => {
    if (!db) return statusZeile(null, 'Datenbank', 'Zustand nicht abrufbar.')
    const bereit = db.zustand?.zustand === 'bereit'
    const gp = db.pruefung
    const index = !bereit ? `nicht verbunden (${db.zustand?.meldung || 'unbekannt'}) · die Anzeige kommt dann aus dem Archiv`
      : db.index ? `verbunden · Index vom ${datumZeit(db.index.zeit)}: ${db.index.anzahl.bestellungen} Bestellungen, ${db.index.anzahl.einkaeufe} Einkäufe, ${db.index.anzahl.belege} Belege` : 'verbunden · Index wird aufgebaut'
    const probe = !gp ? 'Gegenprobe Datenbank = Archiv: noch keine (läuft mit der wöchentlichen Prüfung)'
      : gp.fehler ? `Gegenprobe ${tageText(Math.floor((Date.now() - Date.parse(gp.zeit)) / 86_400_000))}: nicht möglich (${gp.fehler})`
        : `Gegenprobe ${tageText(Math.floor((Date.now() - Date.parse(gp.zeit)) / 86_400_000))}: ${gp.ok ? 'ohne Abweichung' : 'Abweichungen gefunden, Index neu aufgebaut'}`
    return statusZeile(bereit ? (gp ? gp.ok === true : null) : false, 'Datenbank', `${index} · ${probe}`)
  }
  async function statusZeichnen() {
    const [s, db] = await Promise.all([ctx.aufrufen('archivStatus'), ctx.aufrufen('datenbankStatus').catch(() => null)])
    const p = s.pruefung
    const sg = p.siegel
    const t = s.wiederherstellungstest
    const zeilen = [
      statusZeile(p.archiv ? p.archiv.ok && !p.faellig : false, 'Belegarchiv',
        `${s.archiv.eintraege.toLocaleString('de-DE')} Einträge in ${s.archiv.pfad} · ${p.zeit ? `zuletzt geprüft ${tageText(p.tageSeit)} (${p.archiv.ok ? 'alles in Ordnung' : `${p.archiv.anzahlFehler} Fehler, z. B. ${p.archiv.fehler[0]}`})` : 'noch nicht automatisch geprüft'} · Prüfung läuft wöchentlich von selbst`,
        '<button class="knopf-mini" data-st-pruefen type="button">Jetzt prüfen</button>'),
      statusZeile(!sg ? null : sg.ok === null ? null : sg.anzahl ? sg.ok : false, 'Zeitstempel (externer Anker)',
        !sg ? 'Wird bei der nächsten Prüfung ermittelt.' : sg.ok === null ? `Prüfung nicht möglich: ${sg.fehler[0]}` : !sg.anzahl ? 'Noch kein Siegel – im Wartungsmenü „Archiv versiegeln (Zeitstempel)“.' : sg.ok ? `${sg.anzahl} Siegel gültig · zuletzt ${datumZeit(sg.zuletzt)} · ${sg.nochNichtVersiegelt ? `${sg.nochNichtVersiegelt} Beleg(e) seitdem noch nicht versiegelt` : 'alles versiegelt'}` : `Problem: ${sg.fehler[0]}`),
      statusZeile(s.usb.tageSeit !== null && s.usb.tageSeit < 7 && s.usb.letztesErgebnis !== 'fehler', 'USB-Sicherung',
        s.usb.letzteSicherung ? `zuletzt ${tageText(s.usb.tageSeit)} auf „${s.usb.laufwerk}“${s.usb.letztesErgebnis === 'fehler' ? ' · letzter Versuch fehlgeschlagen' : ''}${s.usb.tageSeit >= 7 ? ' · bitte wieder sichern' : ''}` : 'Noch keine Sicherung – „USB-Sicherung einrichten“ im Wartungsmenü.'),
      statusZeile(t.zeit ? !t.faellig : false, 'Wiederherstellungstest',
        t.zeit ? `${t.ok ? 'bestanden' : 'FEHLGESCHLAGEN'} ${tageText(t.tageSeit)} (${t.dateien} Dateien)${t.faellig && t.ok ? ' · wieder fällig (einmal im Jahr)' : ''}` : 'Noch nie getestet – mindestens einmal im Jahr empfohlen (Stick mit Vendo-Sicherung einstecken).',
        s.schluessel.bestaetigt && s.usb.letzteSicherung ? '<button class="knopf-mini" data-st-test type="button">Wiederherstellung testen</button>' : ''),
      datenbankZeile(db),
      statusZeile(s.schluessel.bestaetigt, 'Wiederherstellungsschlüssel', s.schluessel.bestaetigt ? `eingerichtet · Kennung ${s.schluessel.kennung}` : s.schluessel.fehler || 'Noch nicht eingerichtet – „USB-Sicherung einrichten“ im Wartungsmenü.'),
      statusZeile(null, 'Verschlüsselung auf diesem PC', umgebung.windows ? 'Empfehlung: BitLocker für Laufwerk C: einschalten (in Windows 11 Pro enthalten). Sonst liegen die Kundendaten auf dem PC unverschlüsselt. Vendo ändert daran selbst nichts.' : 'Empfehlung: die Festplattenverschlüsselung des Systems einschalten (z. B. FileVault oder LUKS). Sonst liegen die Kundendaten unverschlüsselt auf dem Rechner.')
    ]
    statusFeld.hidden = false
    statusFeld.innerHTML = `<div class="rn-usb-kopf"><strong>Archiv-Status</strong><button class="knopf-mini" data-st-schliessen type="button">Schließen</button></div><ul class="rn-st-liste">${zeilen.join('')}</ul>`
  }
  // Phase 5.3: Neufassung der Umsatzbelege mit falschem Steuerausweis – erst planen, Vorschau öffnen, dann nach Rückfrage erzeugen
  ctx.kopfKnoepfe.querySelector('[data-neufassung-planen]').addEventListener('click', async () => {
    menuesSchliessen()
    try {
      const p = await ctx.aufrufen('neufassungPlanen')
      if (!p.steuer.length) return status('Alle Umsatzbelege haben den richtigen Steuerausweis. Keine Neufassung nötig.')
      const summe = p.steuerSumme.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })
      status(`${p.steuer.length} Beleg(e) zeigen keinen Steuerausweis, obwohl die Bestellung in die Regelbesteuerung fällt (zusammen ${summe} USt). Vorschau wird geöffnet …`)
      const v = await ctx.aufrufen('neufassungVorschau')
      if (v && !v.geoeffnet) status(`Vorschau konnte nicht geöffnet werden: ${v.fehler}`)
      if (!(await ctx.bestaetigen(`${p.steuer.length} Umsatzbelege neu fassen (mit 19 % USt ausgewiesen, ohne § 19-Hinweis)? Die Neufassungen kommen zusätzlich ins Belegarchiv, die alten Fassungen bleiben unverändert erhalten. Ein Protokoll hält fest, welche Fassung welche ersetzt. Die Vorschau zeigt Bestellung #${v?.nr}.`, { titel: 'Belege neu fassen', ja: 'Neu fassen' }))) return status('Neufassung abgebrochen, nichts geändert.')
      status('Erzeuge die Neufassungen …')
      const e = await ctx.aufrufen('neufassungErzeugen')
      status(`${e.anzahl} Neufassung(en) im Belegarchiv, Protokoll: ${e.protokoll || '–'}.${e.hinweise?.length ? ` ${e.hinweise[0]}` : ''}`)
      await laden()
    } catch (f) { status(`Neufassung: ${f.message}`) }
  })
  ctx.kopfKnoepfe.querySelector('[data-status-oeffnen]').addEventListener('click', async () => {
    menuesSchliessen()
    try { await statusZeichnen(); statusFeld.scrollIntoView({ block: 'nearest' }) } catch (f) { status(f.message) }
  })
  statusFeld.addEventListener('click', async (e) => {
    const ziel = e.target.closest('button')
    if (!ziel) return
    try {
      if (ziel.matches('[data-st-schliessen]')) { statusFeld.hidden = true; statusFeld.innerHTML = ''; return }
      if (ziel.matches('[data-st-pruefen]')) {
        ziel.disabled = true
        status('Prüfe das Belegarchiv und die Zeitstempel …')
        const w = await ctx.aufrufen('wartungLauf', { erzwingen: true })
        status(w.ok ? `Archiv geprüft: ${w.archiv.geprueft} Einträge, alles in Ordnung ✓` : `Archivprüfung: ${w.archiv.ok ? 'Zeitstempel-Problem' : `${w.archiv.anzahlFehler} Fehler`} – siehe Archiv-Status.`)
        return statusZeichnen()
      }
      if (ziel.matches('[data-st-test]')) {
        const stick = (await ctx.aufrufen('usbLaufwerke')).find((l) => l.vendo)
        if (!stick) return status('Kein Stick mit Vendo-Sicherung gefunden. Bitte einstecken und noch einmal „Wiederherstellung testen“.')
        ziel.disabled = true
        status(`Teste die Wiederherstellung von ${stick.laufwerk} in einen leeren Testordner … (Stick nicht abziehen)`)
        const r = await ctx.aufrufen('wiederherstellungTesten', stick.laufwerk)
        status(r.ok ? `Wiederherstellungstest bestanden: ${r.dateien} Dateien aus dem Stand vom ${datumZeit(r.erstellt)} entschlüsselt und geprüft ✓ · Testordner gelöscht · Prüfbericht im Archiv.` : `Wiederherstellungstest FEHLGESCHLAGEN: ${r.fehler[0] || r.integritaet?.fehler?.[0] || 'unbekannter Fehler'}`)
        return statusZeichnen()
      }
    } catch (f) { status(f.message); ziel.disabled = false }
  })

  // Wöchentliche Prüfung im Hintergrund (Schritt 1.10): 2 Minuten nach dem Start, danach alle 6 Stunden, ob sie fällig ist
  const wartungPruefen = async () => {
    try {
      const w = await ctx.aufrufen('wartungLauf')
      if (!w?.neu || w.ok) return
      const text = w.archiv?.ok === false ? `Die wöchentliche Prüfung des Belegarchivs meldet ${w.archiv.anzahlFehler} Fehler, z. B. ${w.archiv.fehler[0]}.` : `Die wöchentliche Prüfung der Zeitstempel meldet ein Problem: ${w.siegel?.fehler?.[0] || 'unbekannt'}.`
      ctx.melden?.({ titel: 'Belegarchiv prüfen', text, anzeige: `${text} Details: Rechnungen → ⚙ Wartung → Archiv-Status.` })
      status(text)
    } catch { /* nächster Versuch beim nächsten Takt */ }
  }
  setTimeout(wartungPruefen, 120_000)
  setInterval(wartungPruefen, 6 * 3_600_000)
  // ---------- Meine Angaben (Schritt 2.1, Plan 7.2) ----------
  // Dritter Tab: Liste und Filter werden ausgeblendet (CSS über rn-angaben-aktiv), das Formular kommt aus dem Hauptprozess-Schema.
  const angabenFeld = $('[data-angaben]')
  // Bereiche im Menü (Plan 11.3, M.1): ausgeblendete Tabs verschwinden aus der Navigation, ihre Daten bleiben
  function menueAnwenden(aus = []) {
    menueAus = new Set(aus)
    ctx.element.querySelectorAll('[data-tab]').forEach((b) => { b.hidden = menueAus.has(b.dataset.tab) })
    if (menueAus.has(ansicht)) tabWechseln('uebersicht')
  }
  const angabenFormFeld = angabenBereicheErstellen(angabenFeld, { aufrufen: (...a) => ctx.aufrufen(...a), menueAnwenden, umgebung }).firmendaten
  ctx.aufrufen('menueLaden').then((m) => menueAnwenden(m.aus)).catch(() => {})
  let angabenStand = null
  const PFLICHT_TEXT = { steuerkennung: 'Steuernummer oder USt-IdNr./W-IdNr.', steuerzeitraeume: 'Steuerstatus je Zeitraum' }
  const tag = (t) => t ? String(t).split('-').reverse().join('.') : ''
  // Steuerstatus je Zeitraum (Schritt 2.2): Zeilen werden im Formular bearbeitet und erst mit „Speichern“ übernommen
  const szZeileHtml = (z, i) => `<tr data-sz-zeile>
      <td class="rn-sz-datum"${z.von ? '' : ' data-leer'}><input type="date" data-sz="von" value="${m(z.von || '')}" aria-label="Zeitraum ${i + 1} von (leer = seit Beginn)" /><span class="rn-sz-leer" aria-hidden="true">seit Beginn</span></td>
      <td class="rn-sz-datum"${z.bis ? '' : ' data-leer'}><input type="date" data-sz="bis" value="${m(z.bis || '')}" aria-label="Zeitraum ${i + 1} bis (leer = offen, bis heute)" /><span class="rn-sz-leer" aria-hidden="true">bis heute</span></td>
      <td><select data-sz="art" aria-label="Zeitraum ${i + 1} Steuerstatus">${Object.entries(angabenStand.steuerarten).map(([k, t]) => `<option value="${m(k)}"${z.art === k ? ' selected' : ''}>${m(t)}</option>`).join('')}</select></td>
      <td><input type="text" data-sz="satz" inputmode="decimal" value="${z.art === 'regel' ? m(z.satz ?? '') : ''}" ${z.art === 'regel' ? '' : 'disabled'} aria-label="Zeitraum ${i + 1} Steuersatz in Prozent" /> %</td>
      <td><button type="button" class="knopf-mini" data-sz-weg aria-label="Zeitraum ${i + 1} entfernen">✕</button></td>
    </tr>`
  const szLesen = () => [...angabenFormFeld.querySelectorAll('[data-sz-zeile]')].map((tr) => Object.fromEntries([...tr.querySelectorAll('[data-sz]')].map((e) => [e.dataset.sz, e.value])))
  const szZeichnen = (zeilen) => { angabenFormFeld.querySelector('[data-sz-zeilen]').innerHTML = zeilen.map(szZeileHtml).join('') }
  const szListe = (liste) => liste.slice(0, 5).map((b) => `#${m(b.nr)} (${m(tag(b.datum))})`).join(', ') + (liste.length > 5 ? ` und ${liste.length - 5} weitere` : '')
  function steuerTeil(a, w, p) {
    const s = a.steuer
    const v = s.vorschlag
    const vorschlag = !v ? '' : v.anzahl
      ? `<p class="rn-hinweis" data-sz-vorschlagtext>Aus den Shopify-Bestellungen: ${v.anzahl} Bestellung${v.anzahl === 1 ? '' : 'en'} mit Umsatzsteuer vom ${m(tag(v.von))} bis ${m(tag(v.bis))} (${m(String(v.satz).replace('.', ','))} %, zusammen ${m(euro(v.steuer))} Steuer). Vorschlag: Regelbesteuerung in diesem Zeitraum, sonst Kleinunternehmer. Bitte mit dem Schreiben des Finanzamts vergleichen – Beginn und Ende können dort anders festgelegt sein. <button class="knopf-mini" data-sz-vorschlag type="button">Vorschlag übernehmen</button></p>`
      : `<p class="rn-hinweis" data-sz-vorschlagtext>In den Shopify-Bestellungen wurde nie Umsatzsteuer berechnet. Vorschlag: durchgehend Kleinunternehmer. <button class="knopf-mini" data-sz-vorschlag type="button">Vorschlag übernehmen</button></p>`
    const g = s.abgleich
    const gespeichert = (a.werte.steuerzeitraeume || []).length
    const abgleich = !g || !gespeichert ? '' : (g.steuerTrotzKlein.length || g.ohneSteuerBeiRegel.length || g.ohneStatus.length)
      ? `<ul class="rn-warnliste" data-sz-abgleich>${[
        g.steuerTrotzKlein.length ? `<li>${g.steuerTrotzKlein.length} Bestellung(en) mit Umsatzsteuer laut Shopify, obwohl hier Kleinunternehmer gilt: ${szListe(g.steuerTrotzKlein)}</li>` : '',
        g.ohneSteuerBeiRegel.length ? `<li>${g.ohneSteuerBeiRegel.length} Bestellung(en) ohne Umsatzsteuer, obwohl hier Regelbesteuerung gilt: ${szListe(g.ohneSteuerBeiRegel)}</li>` : '',
        g.ohneStatus.length ? `<li>${g.ohneStatus.length} Bestellung(en) liegen in keinem Zeitraum: ${szListe(g.ohneStatus)}</li>` : ''
      ].join('')}</ul>`
      : `<p class="leise" data-sz-abgleich>✓ Alle ${g.geprueft} Shopify-Bestellungen passen zum gespeicherten Steuerstatus.</p>`
    const fehler = p.fehler.steuerzeitraeume
    return `<fieldset class="rn-ang-gruppe" data-sz-gruppe><legend>Steuerstatus je Zeitraum</legend>
      <p class="leise">Welche Besteuerung galt wann? Leeres „von“ = seit Beginn, leeres „bis“ = bis heute und weiter. Die Zeiträume müssen lückenlos aneinander anschließen.</p>
      ${!s.daten ? '<p class="leise">Die Shopify-Bestellungen konnten nicht gelesen werden – bitte die Zeiträume selbst eintragen.</p>' : ''}
      ${vorschlag}
      <table class="rn-sz-tabelle"><thead><tr><th>Von</th><th>Bis</th><th>Steuerstatus</th><th>Satz</th><th></th></tr></thead><tbody data-sz-zeilen>${(w.steuerzeitraeume || []).map(szZeileHtml).join('')}</tbody></table>
      ${fehler ? `<small class="rn-usb-fehler" role="alert" data-sz-fehler>${m(fehler)}</small>` : ''}
      <p><button class="knopf-mini" data-sz-neu type="button">Zeitraum hinzufügen</button></p>
      ${abgleich}
    </fieldset>`
  }
  function bereichUmschalten() {
    const an = ansicht === 'angaben'
    // Liste und Filter sind in „Übersicht“, „Meine Angaben“ und „Steuer“ ausgeblendet
    ctx.element.classList.toggle('rn-angaben-aktiv', ['angaben', 'steuer', 'uebersicht'].includes(ansicht))
    angabenFeld.hidden = !an
    steuerFeld.hidden = ansicht !== 'steuer'
    uebersichtFeld.hidden = ansicht !== 'uebersicht'
    if (an) angabenZeichnen().catch((f) => status(f.message))
    if (ansicht === 'steuer') steuerZeichnen().catch((f) => status(f.message))
    if (ansicht === 'uebersicht') dashboardZeichnen().catch((f) => status(f.message))
  }
  function tabWechseln(name) {
    if (menueAus.has(name)) { status(`Der Bereich ist unter „Meine Angaben → Bereiche im Menü“ ausgeblendet.`); name = 'uebersicht' }
    ansicht = name
    bereichUmschalten()
    neu()
  }

  // ---------- Dashboard „Übersicht“ (Schritt 4.5, Plan 7.7/8.4): Aufgaben & Fristen, EÜR je Jahr ----------
  // Weitere Kacheln (Zahlen, Ampel, § 13b kompakt, Archiv-Zustand) folgen in Schritt 4.6.
  const uebersichtFeld = $('[data-uebersicht]')
  const ZEICHEN = { rot: '⚠', gelb: '●', info: '○' }
  const ERLEDIGBAR = { euer: 'Steuererklärung', konto: 'Kontoauszüge' }
  let dashboardHeute = null
  async function dashboardZeichnen() {
    const u = await ctx.aufrufen('dashboard')
    dashboardHeute = u.heute
    const aufgabe = (a) => `<li class="rn-aufgabe rn-aufgabe-${m(a.stufe)}" data-aufgabe="${m(a.schluessel)}">
        <span class="rn-aufgabe-zeichen" aria-hidden="true">${ZEICHEN[a.stufe] || '○'}</span>
        <div class="rn-aufgabe-text"><strong>${m(a.titel)}</strong>${a.frist ? ` <span class="leise">· bis ${m(datumText(a.frist))}</span>` : ''}<br><span class="leise">${m(a.text)}</span></div>
        <span class="rn-aufgabe-knoepfe">${a.ziel && a.ziel !== 'uebersicht' ? `<button class="knopf-mini" data-aufgabe-ziel="${m(a.ziel)}" type="button">Öffnen</button>` : ''}${a.erledigbar ? `<button class="knopf-mini" data-aufgabe-erledigt="${m(a.schluessel)}" type="button">Erledigt</button>` : ''}</span>
      </li>`
    const betrag = (x) => x ? euro(x) : '–'
    const erledigt = Object.entries(u.erledigt || {}).sort((a, b) => b[0].localeCompare(a[0]))
    uebersichtFeld.innerHTML = `
      <div class="rn-usb-kopf"><strong>Aufgaben & Fristen</strong><span class="leise">Stand ${m(datumText(u.heute))}</span></div>
      ${u.aufgaben.length ? `<ul class="rn-aufgaben" data-aufgaben>${u.aufgaben.map(aufgabe).join('')}</ul>` : '<p class="leise" data-aufgaben-leer>✓ Keine offenen Aufgaben.</p>'}
      ${erledigt.length ? `<p class="leise" data-aufgaben-erledigt>Erledigt: ${erledigt.map(([k, am]) => `${m(ERLEDIGBAR[k.split('-')[0]] || k)} ${m(k.split('-')[1])} am ${m(datumText(am))} <button class="knopf-mini" data-aufgabe-zurueck="${m(k)}" type="button" aria-label="${m(k)} wieder öffnen">↺</button>`).join(' · ')}</p>` : ''}
      <div class="rn-usb-kopf"><strong>EÜR je Jahr</strong><span class="leise">Kennzahlen der Anlage EÜR</span></div>
      ${u.euer.length ? `<table class="rn-steuer-tabelle" data-euer>
        <thead><tr><th scope="col">Jahr</th><th scope="col" title="Betriebseinnahmen als Kleinunternehmer">Kz 111</th><th scope="col" title="umsatzsteuerpflichtige Betriebseinnahmen (netto)">Kz 112</th><th scope="col" title="vereinnahmte Umsatzsteuer">Kz 140</th><th scope="col" title="Waren, Rohstoffe (Shirtigo)">Kz 100</th><th scope="col" title="übrige Ausgaben aus eingelesenen Belegen">übrige</th><th scope="col" title="an das Finanzamt gezahlte Umsatzsteuer (§ 13b)">Kz 186</th><th scope="col">Gewinn</th></tr></thead>
        <tbody>${u.euer.map((j) => `<tr data-euer-jahr="${m(j.jahr)}"><th scope="row">${m(j.jahr)}</th><td class="rn-zahl">${betrag(j.kz111)}</td><td class="rn-zahl">${betrag(j.kz112)}</td><td class="rn-zahl">${betrag(j.kz140)}</td><td class="rn-zahl">${betrag(j.kz100)}</td><td class="rn-zahl">${betrag(j.sonstige)}</td><td class="rn-zahl">${betrag(j.kz186)}</td><td class="rn-zahl"><b class="${j.gewinn >= 0 ? 'rn-plus' : 'rn-minus'}">${euro(j.gewinn)}</b></td></tr>`).join('')}</tbody>
      </table>` : '<p class="leise">Noch keine Einnahmen oder Ausgaben.</p>'}
      <ul class="rn-info">
        <li>Kz 111: Einnahmen als Kleinunternehmer nach Zahlungseingang. Kz 112/140: Einnahmen netto und Umsatzsteuer in der Regelbesteuerung.</li>
        <li>Kz 100: Shirtigo-Produktion nach Zahlungsdatum. „übrige“: eingelesene Belege nach Rechnungsdatum – je nach Art eintragen (z. B. Werbung Kz 224).</li>
        <li>Kz 186: § 13b-Steuer im Jahr der Zahlung. Umsatzsteuer aus der Regelbesteuerung, die du ans Finanzamt gezahlt hast, gehört zusätzlich hierher.</li>
      </ul>
      <p class="leise">Hilfe für die Steuererklärung, ersetzt sie nicht. Ohne Gewähr – keine Steuerberatung.</p>`
  }
  uebersichtFeld.addEventListener('click', async (e) => {
    const z = e.target.closest('[data-aufgabe-ziel]')
    const fertig = e.target.closest('[data-aufgabe-erledigt]')
    const zurueck = e.target.closest('[data-aufgabe-zurueck]')
    try {
      if (z) {
        const ziel = z.dataset.aufgabeZiel
        if (ziel === 'usb') return ctx.kopfKnoepfe.querySelector('[data-usb-einrichten]').click()
        if (ziel === 'archiv') return ctx.kopfKnoepfe.querySelector('[data-status-oeffnen]').click()
        if (ziel === 'verfahren') { tabWechseln('angaben'); return angabenFeld.querySelector('[data-angaben-tab="verfahren"]')?.click() }
        return tabWechseln(ziel)
      }
      if (fertig) { await ctx.aufrufen('aufgabeErledigt', fertig.dataset.aufgabeErledigt, dashboardHeute); return dashboardZeichnen() }
      if (zurueck) { await ctx.aufrufen('aufgabeErledigt', zurueck.dataset.aufgabeZurueck, null); return dashboardZeichnen() }
    } catch (f) { status(f.message) }
  })
  // Dringende (rote) Aufgaben als Vendo-Benachrichtigung: 2,5 min nach dem Start und alle 6 Stunden, je Aufgabe einmal am Tag
  const aufgabenPruefen = async () => {
    try {
      const neu = await ctx.aufrufen('aufgabenMelden')
      if (!neu?.length) return
      const text = neu.map((a) => `${a.titel}: ${a.text}`).join(' · ')
      ctx.melden?.({ titel: 'Rechnungen: dringende Aufgaben', text, anzeige: `${text} Details: Rechnungen → Übersicht.` })
    } catch { /* nächster Versuch beim nächsten Takt */ }
  }
  setTimeout(aufgabenPruefen, 150_000)
  setInterval(aufgabenPruefen, 6 * 3_600_000)

  // ---------- Tab „Steuer“ (Phase 4, Plan 7.3/7.7) ----------
  // Schritt 4.2: Umsatz je Jahr nach Zahlungseingang. Grenzwert-Ampel (4.3), § 13b (4.4) und Fristen (4.5) folgen hier.
  const steuerFeld = $('[data-steuer]')
  const STUFE = { gruen: ['rn-gruen', '✓ Kleinunternehmer'], gelb: ['rn-gelb', 'Achtung'], orange: ['rn-orange', 'Umstellung vorbereiten'], rot: ['rn-rot', 'Dringend prüfen'] }
  // Grenzwert-Ampel (Schritt 4.3): Balken je Grenze, Meldungen mit Stufe, Hinweis bei abweichendem Steuerstatus
  function ampelHtml(w, statusPasst) {
    const farbe = (wert, grenze, gelbAb = 0.8) => wert > grenze ? 'rot' : wert >= grenze * gelbAb ? 'gelb' : 'gruen'
    const balken = (name, titel, wert, grenze, f) => `<div class="rn-ampel-zeile" data-balken="${name}">
        <div class="rn-ampel-text"><span>${m(titel)}</span><b>${euro(wert)} <span class="leise">von ${euro(grenze)}</span></b></div>
        <div class="rn-balken"><span class="rn-balken-${f}" data-anteil="${Math.max(0, Math.min(100, (wert / grenze) * 100)).toFixed(1)}"></span></div>
      </div>`
    const [klasse, stufenText] = STUFE[w.stufe] || STUFE.gruen
    const text = w.kleinunternehmer ? stufenText : 'Kleinunternehmerregelung entfällt'
    return `<div class="rn-ampel" data-ampel="${m(w.stufe)}">
        <div class="rn-usb-kopf"><strong>Kleinunternehmer-Ampel ${m(w.jahr)}</strong><span class="rn-badge ${klasse}" data-ampel-stufe>${m(text)}</span></div>
        ${balken('laufend', w.gruendungsjahr ? `Umsatz ${w.jahr} (Jahr der Gründung: Grenze 25.000 €)` : `Umsatz ${w.jahr} bis heute`, w.laufend.umsatz, w.laufend.grenze, w.gruendungsjahr ? farbe(w.laufend.umsatz, w.laufend.grenze) : farbe(w.laufend.umsatz, w.laufend.grenze, 0.9))}
        ${w.gruendungsjahr ? '' : balken('folgejahr', `Umsatz ${w.jahr} für die Grenze ab ${Number(w.jahr) + 1}`, w.laufend.umsatz, w.laufend.grenze25, w.laufend.umsatz > w.laufend.grenze25 ? 'orange' : farbe(w.laufend.umsatz, w.laufend.grenze25))}
        ${w.gruendungsjahr ? '' : balken('vorjahr', `Umsatz ${w.vorjahr.jahr} (Vorjahr)`, w.vorjahr.umsatz, w.vorjahr.grenze, w.vorjahr.umsatz > w.vorjahr.grenze ? 'rot' : 'gruen')}
        ${balken('eu', `Lieferungen in andere EU-Länder ${w.jahr}${w.eu.laender.length ? ` (${w.eu.laender.join(', ')})` : ''}`, w.eu.umsatz, w.eu.grenze, farbe(w.eu.umsatz, w.eu.grenze))}
        ${w.meldungen.length ? `<ul class="rn-ampel-meldungen">${w.meldungen.map((x) => `<li class="rn-meldung-${m(x.stufe)}">${m(x.text)}</li>`).join('')}</ul>` : '<p class="leise" data-ampel-ok>Alle Grenzen eingehalten: Die Kleinunternehmerregelung gilt.</p>'}
        ${statusPasst ? '' : '<p class="rn-warnliste" data-ampel-status>Laut Umsatz gilt die Kleinunternehmerregelung nicht mehr, in „Meine Angaben“ steht für heute aber noch Kleinunternehmer. Bitte den Steuerstatus prüfen und einen neuen Zeitraum anlegen.</p>'}
        <p class="leise">Hinweis ohne Gewähr – mit Steuerberater oder Finanzamt abstimmen. Grundlage: § 19 UStG, BMF-Schreiben vom 18.03.2025, § 3c UStG.</p>
      </div>`
  }
  // § 13b (Schritt 4.4): Monate mit Kennzahlen und Fälligkeit, Einstufung je Lieferant, Kennzeichen je Ausgaben-Beleg
  const monatText = (mo) => !mo ? '–' : mo.includes('Q') ? `${mo.slice(5)}/${mo.slice(0, 4)}` : `${mo.slice(5, 7)}.${mo.slice(0, 4)}`
  function p13bHtml(u) {
    const ein = u.einstellungen || { quartalAb: null, dauerfrist: false } // ältere Dienste ohne Einstellungen
    const vor = u.vorschlag || null
    const betrag = (x) => x ? euro(x) : '–'
    const monate = u.monate.length ? `<table class="rn-steuer-tabelle" data-p13b-monate>
        <thead><tr><th scope="col">Zeitraum</th><th scope="col">Belege</th><th scope="col">Kz 46</th><th scope="col">Kz 47</th><th scope="col">Kz 84</th><th scope="col">Kz 85</th><th scope="col">fällig bis</th><th scope="col">Voranmeldung</th></tr></thead>
        <tbody>${u.monate.map((x) => `<tr data-monat="${m(x.monat)}" class="${x.ueberfaellig ? 'rn-meldung-rot' : ''}">
          <th scope="row">${m(monatText(x.monat))}</th><td class="rn-zahl">${x.rechnungen}${x.steuerfrei ? ` <span class="leise">(${x.steuerfrei} steuerfrei)</span>` : ''}</td>
          <td class="rn-zahl">${betrag(x.eu.bemessung)}</td><td class="rn-zahl"><b>${betrag(x.eu.steuer)}</b></td><td class="rn-zahl">${betrag(x.drittland.bemessung)}</td><td class="rn-zahl"><b>${betrag(x.drittland.steuer)}</b></td>
          <td class="rn-zahl">${m(datumText(x.faellig))}${x.ueberfaellig ? ' · überfällig' : ''}</td>
          <td class="rn-zahl">${x.angemeldet ? `✓ ${m(datumText(x.angemeldet))} <button type="button" class="knopf-mini" data-p13b-zurueck="${m(x.monat)}" aria-label="Markierung für ${m(monatText(x.monat))} entfernen">✕</button>` : x.pflicht ? `<button type="button" class="knopf-mini" data-p13b-anmelden="${m(x.monat)}">als angemeldet markieren</button>` : '<span class="leise">nichts anzumelden</span>'}</td>
        </tr>${x.offenWaehrung ? `<tr><td colspan="8" class="rn-meldung-gelb">${x.offenWaehrung} Beleg(e) in Fremdwährung: bitte unten den Euro-Betrag eintragen.</td></tr>` : ''}`).join('')}</tbody>
      </table>` : '<p class="leise" data-p13b-leer>Noch keine § 13b-Belege.</p>'
    const anbieter = u.lieferanten.length ? `<table class="rn-steuer-tabelle rn-p13b-anbieter">
        <thead><tr><th scope="col">Lieferant</th><th scope="col">Einstufung</th><th scope="col">Sitz</th></tr></thead>
        <tbody>${u.lieferanten.map((l) => `<tr data-lieferant="${m(l.lieferant)}"><th scope="row">${m(l.lieferant)}${l.vermutetFrei ? ' <span class="rn-badge rn-gelb">vermutlich steuerfrei – prüfen</span>' : ''}</th>
          <td><select data-p13b-einstufung aria-label="Einstufung ${m(l.lieferant)}"><option value=""${l.einstufung ? '' : ' selected'}>automatisch</option><option value="steuerpflichtig"${l.einstufung === 'steuerpflichtig' ? ' selected' : ''}>steuerpflichtig (19 %)</option><option value="steuerfrei"${l.einstufung === 'steuerfrei' ? ' selected' : ''}>steuerfrei (z. B. Zahlungsdienst)</option></select></td>
          <td><select data-p13b-herkunft aria-label="Sitz ${m(l.lieferant)}"><option value=""${l.herkunft ? '' : ' selected'}>automatisch</option><option value="eu"${l.herkunft === 'eu' ? ' selected' : ''}>EU (Kz 46/47)</option><option value="drittland"${l.herkunft === 'drittland' ? ' selected' : ''}>außerhalb der EU (Kz 84/85)</option></select></td></tr>`).join('')}</tbody>
      </table>` : ''
    const belege = u.faelle.length ? `<details class="rn-p13b-belege"${u.faelle.some((x) => x.fall) ? '' : ' open'}><summary>Ausgaben-Belege (${u.faelle.length}) – § 13b markieren</summary>
        <table class="rn-steuer-tabelle"><thead><tr><th scope="col">§ 13b</th><th scope="col">Lieferant</th><th scope="col">Datum</th><th scope="col">Netto</th><th scope="col">Monat</th><th scope="col">Steuer</th></tr></thead>
        <tbody>${u.faelle.map((x) => `<tr data-p13b-beleg="${m(x.id)}" data-erkannt="${x.erkannt ? 1 : 0}">
          <td><input type="checkbox" data-p13b-aktiv ${x.fall ? 'checked' : ''} aria-label="§ 13b für ${m(x.name)}" />${x.erkannt ? ' <span class="leise" title="Reverse-Charge-Hinweis auf der Rechnung erkannt">erkannt</span>' : ''}</td>
          <td>${m(x.lieferant || x.name)}</td><td>${m(datumText(x.datum))}</td>
          <td class="rn-zahl">${x.waehrung !== 'EUR' ? `${m(x.betrag ?? '–')} ${m(x.waehrung)} <input type="text" inputmode="decimal" data-p13b-eur value="${m(x.eintrag.betragEur ?? '')}" placeholder="€" aria-label="Betrag in Euro" />` : betrag(x.betrag)}</td>
          <td><input type="month" data-p13b-monat value="${m(x.fall?.monat || x.eintrag.monat || '')}" ${x.fall ? '' : 'disabled'} aria-label="Monat der Leistung" /></td>
          <td class="rn-zahl">${x.fall ? (x.fall.steuerfrei ? 'steuerfrei' : x.fall.waehrungFehlt ? 'Euro-Betrag fehlt' : euro(x.fall.steuer)) : '–'}</td></tr>`).join('')}</tbody></table></details>`
      : '<p class="leise" data-p13b-keine>Noch keine eingelesenen Ausgaben-Belege. Rechnungen von Meta, Google, Shopify (Abo, Apps) und anderen ausländischen Anbietern über „PDF hinzufügen“ einlesen – Vendo erkennt den Reverse-Charge-Hinweis und rechnet die Steuer aus.</p>'
    return `<div class="rn-p13b" data-p13b>
        <div class="rn-usb-kopf"><strong>§ 13b – Umsatzsteuer auf Leistungen ausländischer Anbieter</strong><span class="leise">19 % vom Nettobetrag, zählt als Ausgabe</span></div>
        <p class="leise">Für jeden Voranmeldungszeitraum mit § 13b-Steuer ist auch als Kleinunternehmer eine Umsatzsteuer-Voranmeldung nötig, dazu für das Jahr eine Umsatzsteuer-Jahreserklärung (§ 18 Abs. 4a UStG). Abgabe und Zahlung bis zum 10. nach Ablauf des Zeitraums, mit Dauerfristverlängerung einen Monat später. Kennzahlen laut Vordruck 2026: EU-Anbieter Kz 46 (netto) / 47 (Steuer), Anbieter außerhalb der EU Kz 84 / 85.</p>
        <div class="rn-p13b-zeitraum" data-p13b-zeitraum>
          <label>Voranmeldungszeitraum <select data-p13b-quartal aria-label="Voranmeldungszeitraum"><option value=""${ein.quartalAb ? '' : ' selected'}>monatlich</option>${(vor ? [vor.jahr - 2, vor.jahr - 1, vor.jahr, vor.jahr + 1] : []).map((j) => `<option value="${j}"${Number(ein.quartalAb) === j ? ' selected' : ''}>vierteljährlich ab ${j}</option>`).join('')}</select></label>
          <label><input type="checkbox" data-p13b-dauerfrist ${ein.dauerfrist ? 'checked' : ''} /> Dauerfristverlängerung (§ 46 UStDV)</label>
          ${vor ? `<span class="leise" data-p13b-vorschlag>Vorschlag ${m(vor.jahr)}: ${m(vor.grund)}${vor.befreiungMoeglich ? ' Bei höchstens 2.000 € Steuer im Vorjahr kann das Finanzamt auf Antrag von den Voranmeldungen befreien.' : ''} Einstellen, wie es das Finanzamt festgelegt hat.</span>` : ''}
        </div>
        ${monate}${anbieter}${belege}
        <p class="leise">Feiertage sind bei der Frist nicht berücksichtigt. Ohne Gewähr – mit Steuerberater oder Finanzamt abstimmen.</p>
      </div>`
  }
  steuerFeld.addEventListener('change', async (e) => {
    if (e.target.matches?.('[data-p13b-quartal], [data-p13b-dauerfrist]')) {
      const z = e.target.closest('[data-p13b-zeitraum]')
      try { await ctx.aufrufen('p13bEinstellungen', { quartalAb: z.querySelector('[data-p13b-quartal]').value || null, dauerfrist: z.querySelector('[data-p13b-dauerfrist]').checked }); await steuerZeichnen() } catch (f) { status(f.message) }
      return
    }
    try {
      const zeile = e.target.closest('[data-p13b-beleg]')
      if (zeile && e.target.matches('[data-p13b-aktiv], [data-p13b-monat], [data-p13b-eur]')) {
        const aktiv = zeile.querySelector('[data-p13b-aktiv]').checked
        const erkannt = zeile.dataset.erkannt === '1' // erkannt + angehakt = automatisch (kein eigener Eintrag)
        await ctx.aufrufen('p13bSetzen', zeile.dataset.p13bBeleg, { aktiv: aktiv === erkannt ? null : aktiv, monat: aktiv ? zeile.querySelector('[data-p13b-monat]').value || null : null, betragEur: zeile.querySelector('[data-p13b-eur]')?.value || null })
      } else if (e.target.matches('[data-p13b-einstufung], [data-p13b-herkunft]')) {
        const z = e.target.closest('[data-lieferant]')
        await ctx.aufrufen('p13bAnbieter', z.dataset.lieferant, { einstufung: z.querySelector('[data-p13b-einstufung]').value || null, herkunft: z.querySelector('[data-p13b-herkunft]').value || null })
      } else return
      await steuerZeichnen()
      await summeLaden()
    } catch (f) { status(f.message) }
  })
  steuerFeld.addEventListener('click', async (e) => {
    const an = e.target.closest('[data-p13b-anmelden]')
    const weg = e.target.closest('[data-p13b-zurueck]')
    if (!an && !weg) return
    try {
      await ctx.aufrufen('p13bAngemeldet', (an || weg).dataset[an ? 'p13bAnmelden' : 'p13bZurueck'], an ? p13bHeute : null)
      status(an ? `§ 13b ${monatText(an.dataset.p13bAnmelden)}: als angemeldet markiert.` : 'Markierung entfernt.')
      await steuerZeichnen()
    } catch (f) { status(f.message) }
  })
  let p13bHeute = null
  async function steuerZeichnen() {
    const { jahre, waechter, statusPasst } = await ctx.aufrufen('umsatzJahre')
    const p13b = await ctx.aufrufen('p13bUebersicht')
    p13bHeute = p13b.heute
    const zeile = (j) => `<tr data-jahr="${m(j.jahr)}">
        <th scope="row">${m(j.jahr)}</th>
        <td class="rn-zahl"><b>${euro(j.umsatz)}</b></td>
        <td class="rn-zahl">${j.erstattungen ? `−${euro(j.erstattungen)}` : '–'}</td>
        <td class="rn-zahl">${j.ust ? euro(j.ust) : '–'}</td>
        <td class="rn-zahl">${j.bestellungen}</td>
        <td class="rn-zahl leise">${euro(j.nachBestelldatum)}</td>
      </tr>`
    const hinweise = [
      ...jahre.filter((j) => j.ust).map((j) => `${j.jahr}: In der Regelbesteuerung zählt nur der Nettobetrag; die enthaltene Umsatzsteuer (${euro(j.ust)}) steht getrennt.`),
      ...jahre.filter((j) => j.geschaetzt).map((j) => `${j.jahr}: Bei ${j.geschaetzt} Bestellung(en) ist das Zahlungsdatum noch unbekannt – dort zählt vorläufig das Bestelldatum. „Synchronisieren“ holt es nach.`),
      ...jahre.filter((j) => j.sonstige).map((j) => `${j.jahr}: ${j.sonstige} weitere Einnahme(n) aus eingelesenen Belegen zählen nach Rechnungsdatum.`)
    ]
    steuerFeld.innerHTML = `
      ${waechter ? ampelHtml(waechter, statusPasst) : ''}
      <div class="rn-usb-kopf"><strong>Umsatz je Jahr</strong><span class="leise">nach Zahlungseingang (§ 19 Abs. 2 UStG)</span></div>
      <p class="leise">Gezählt wird, was im Jahr tatsächlich bezahlt wurde – abzüglich Erstattungen im Jahr der Erstattung. Grundlage für die Kleinunternehmergrenzen (25.000 € Vorjahr, 100.000 € laufendes Jahr).</p>
      ${jahre.length ? `<table class="rn-steuer-tabelle">
        <thead><tr><th scope="col">Jahr</th><th scope="col">Umsatz</th><th scope="col">Erstattungen</th><th scope="col">USt (Regelbest.)</th><th scope="col">Bestellungen</th><th scope="col">nach Bestelldatum</th></tr></thead>
        <tbody>${jahre.map(zeile).join('')}</tbody>
      </table>` : '<p class="leise" data-steuer-leer>Noch keine Einnahmen vorhanden.</p>'}
      ${hinweise.length ? `<ul class="rn-info">${hinweise.map((h) => `<li>${m(h)}</li>`).join('')}</ul>` : ''}
      <p class="leise">„nach Bestelldatum“ ist der bisherige Wert zum Vergleich. Zahlungsdatum laut Shopify (bei Überweisung: Tag der Markierung als bezahlt). Ohne Gewähr – keine Steuerberatung.</p>
      ${p13bHtml(p13b)}`
    steuerFeld.querySelectorAll('[data-anteil]').forEach((b) => { b.style.width = `${b.dataset.anteil}%` }) // Balkenbreite per CSSOM
  }
  async function angabenZeichnen({ werte = null, pruefung = null, meldung = '' } = {}) {
    angabenStand = await ctx.aufrufen('angabenLaden')
    const a = angabenStand
    const w = werte || a.werte
    const p = pruefung || a.pruefung
    const label = Object.fromEntries(a.felder.map((f) => [f.feld, f.label]))
    const eingabe = (f) => {
      const v = w[f.feld]
      const id = `rn-ang-${f.feld}`
      const fehler = p.fehler[f.feld]
      const attr = `id="${id}" data-angabe="${m(f.feld)}" aria-invalid="${fehler ? 'true' : 'false'}"`
      const breit = f.typ === 'textarea' || f.typ === 'liste'
      const maxLaenge = f.maxLaenge ? ` maxlength="${f.maxLaenge}"` : ''
      const feld = f.typ === 'auswahl'
        ? `<select ${attr}>${f.optionen.map((o) => `<option value="${m(o.wert)}"${String(v) === o.wert ? ' selected' : ''}>${m(o.label)}</option>`).join('')}</select>`
        : breit ? `<textarea ${attr} rows="${f.typ === 'liste' ? 3 : 2}"${maxLaenge}>${m(f.typ === 'liste' ? (v || []).join('\n') : v)}</textarea>`
          : `<input ${attr} type="${f.typ === 'email' ? 'email' : f.typ === 'zahl' ? 'number' : f.typ === 'datum' ? 'date' : 'text'}"${f.typ === 'datum' ? ' min="0001-01-01"' : ''}${maxLaenge} value="${m(v)}" autocomplete="off" spellcheck="false" />`
      const verborgen = f.anzeigenWenn && w[f.anzeigenWenn.feld] !== f.anzeigenWenn.wert
      return `<label class="rn-ang-feld${breit ? ' rn-ang-breit' : ''}" data-angaben-feld="${m(f.feld)}"${verborgen ? ' hidden' : ''} for="${id}"><span>${m(f.label)}${f.pflicht ? ' *' : ''}</span>${feld}${f.hilfe ? `<small class="leise">${m(f.hilfe)}</small>` : ''}${fehler ? `<small class="rn-usb-fehler" role="alert">${m(fehler)}</small>` : ''}</label>`
    }
    const fehlend = p.fehlend.map((x) => PFLICHT_TEXT[x] || label[x])
    const gruppen = [...new Set(a.felder.map((f) => f.gruppe))]
    angabenFormFeld.innerHTML = `
      <div class="rn-usb-kopf"><strong>Firmendaten</strong><span class="leise">${a.gespeichert ? `zuletzt gespeichert ${m(datumZeit(a.verlauf.at(-1)?.zeit))}` : 'noch nicht gespeichert'}</span></div>
      <p class="leise">Diese Angaben kommen auf neue Belege. Bestehende Belege bleiben unverändert. Pflichtfelder sind mit * markiert.</p>
      ${a.vorschlag ? '<p class="rn-hinweis" data-ang-vorschlagtext>Für noch leere Felder hat Vendo Angaben aus der bisherigen festen Einstellung gefunden. <button class="knopf-mini" data-ang-vorschlag type="button">Vorschlag übernehmen</button> Danach bitte prüfen und speichern.</p>' : ''}
      ${fehlend.length ? `<p class="rn-warnliste" data-ang-fehlend>Es fehlen noch Pflichtangaben: ${fehlend.map(m).join(', ')}. Solange erzeugt Vendo für neue Shopify-Bestellungen keine Umsatzbelege (die Bestellungen kommen trotzdem ins Archiv, die Belege werden danach nachgeholt).</p>` : p.ok ? '<p class="leise" data-ang-vollstaendig>✓ Alle Pflichtangaben vorhanden.</p>' : ''}
      ${p.hinweise.length ? `<ul class="rn-info">${p.hinweise.map((h) => `<li>${m(h)}</li>`).join('')}</ul>` : ''}
      <form data-ang-form novalidate>
        ${gruppen.map((g) => `<fieldset class="rn-ang-gruppe"><legend>${m(g)}</legend><div class="rn-ang-raster">${a.felder.filter((f) => f.gruppe === g).map(eingabe).join('')}</div>${g === 'Rechnungen und Angebote' ? `<p class="leise">Nächste Nummer laut gespeicherter Angabe: ${m(a.vorschau)}</p>` : ''}</fieldset>${g === 'Steuern' ? steuerTeil(a, w, p) : ''}`).join('')}
        <fieldset class="rn-ang-gruppe"><legend>Belegarchiv</legend><p class="leise">${m(a.archiv.pfad)}${a.archiv.belegt ? ' – fest, weil das Archiv schon Belege enthält (ein Umzug geht nur über die geprüfte Migration).' : ''}</p></fieldset>
        <div class="rn-usb-zeile"><button class="knopf-gold knopf-mini" data-ang-speichern type="submit">Speichern</button>${meldung ? `<span class="leise" role="status" data-ang-meldung>${m(meldung)}</span>` : ''}</div>
      </form>
      ${a.verlauf.length ? `<p class="leise">Letzte Änderungen: ${a.verlauf.slice().reverse().map((v) => `${m(datumZeit(v.zeit))} (${v.felder.length} Feld${v.felder.length === 1 ? '' : 'er'})`).join(' · ')}</p>` : ''}`
  }
  const angabenSammeln = () => ({ ...Object.fromEntries([...angabenFormFeld.querySelectorAll('[data-angabe]')].map((e) => [e.dataset.angabe, e.value])), steuerzeitraeume: szLesen() })
  angabenFormFeld.addEventListener('submit', async (e) => {
    e.preventDefault()
    try {
      const r = await ctx.aufrufen('angabenSpeichern', angabenSammeln())
      const meldung = !r.ok ? 'Nicht gespeichert – bitte die markierten Felder korrigieren.' : r.geaendert ? `Gespeichert (${r.geaendert} Änderung${r.geaendert === 1 ? '' : 'en'}).` : 'Keine Änderungen.'
      await angabenZeichnen(r.ok ? { meldung } : { werte: r.werte, pruefung: r.pruefung, meldung })
      status(r.ok ? `Meine Angaben: ${meldung}` : `Meine Angaben: ${meldung}`)
    } catch (f) { status(f.message) }
  })
  // Leeres Datumsfeld: statt „tt.mm.jjjj“ steht dort „seit Beginn“ bzw. „bis heute“
  angabenFormFeld.addEventListener('input', (e) => { if (e.target.matches('input[type="date"][data-sz]')) e.target.parentElement.toggleAttribute('data-leer', !e.target.value) })
  angabenFormFeld.addEventListener('change', (e) => {
    if (e.target.matches('input[type="date"][data-sz]')) { e.target.parentElement.toggleAttribute('data-leer', !e.target.value); return }
    if (e.target.matches('[data-angabe="rechtsform"]')) {
      const einkunftsart = angabenFormFeld.querySelector('[data-angaben-feld="einkunftsart"]')
      if (einkunftsart) {
        einkunftsart.hidden = e.target.value !== 'einzelunternehmen'
        if (einkunftsart.hidden) einkunftsart.querySelector('select').value = ''
      }
      return
    }
    if (!e.target.matches('[data-sz="art"]')) return
    const satz = e.target.closest('[data-sz-zeile]').querySelector('[data-sz="satz"]')
    satz.disabled = e.target.value !== 'regel'
    satz.value = e.target.value === 'regel' ? (satz.value || '19') : ''
  })
  angabenFormFeld.addEventListener('click', (e) => {
    if (e.target.closest('[data-sz-neu]')) { szZeichnen([...szLesen(), { von: '', bis: '', art: 'klein', satz: null }]); return }
    const weg = e.target.closest('[data-sz-weg]')
    if (weg) { const zeilen = szLesen(); zeilen.splice([...angabenFormFeld.querySelectorAll('[data-sz-zeile]')].indexOf(weg.closest('[data-sz-zeile]')), 1); szZeichnen(zeilen); return }
    if (e.target.closest('[data-sz-vorschlag]') && angabenStand?.steuer?.vorschlag) {
      szZeichnen(angabenStand.steuer.vorschlag.zeitraeume)
      status('Steuerstatus-Vorschlag eingetragen – bitte prüfen und dann „Speichern“.')
      return
    }
    if (!e.target.closest('[data-ang-vorschlag]') || !angabenStand?.vorschlag) return
    for (const [feld, wert] of Object.entries(angabenStand.vorschlag)) {
      const el = angabenFormFeld.querySelector(`[data-angabe="${feld}"]`)
      if (el) el.value = Array.isArray(wert) ? wert.join('\n') : wert
    }
    status('Vorschlag eingetragen – bitte prüfen und dann „Speichern“.')
  })
  $('[data-mehr]').addEventListener('click', () => { anzeige += 50; zeichnen() })
  $('[data-suche]').addEventListener('input', (e) => { filter.suche = e.target.value; anzeige = 50; zeichnen() })
  $('[data-f-jahr]').addEventListener('change', (e) => { filter.jahr = e.target.value; neu() })
  $('[data-f-monat]').addEventListener('change', (e) => { filter.monat = e.target.value; neu() })
  $('[data-f-lieferant]').addEventListener('change', (e) => { filter.lieferant = e.target.value; neu() })
  $('[data-f-art]').addEventListener('change', (e) => { filter.art = e.target.value; neu() })
  $('[data-f-feld]').addEventListener('change', (e) => { filter[ansicht === 'bestellungen' ? 'feldB' : 'feld'] = e.target.value; neu() })
  $('[data-f-status]').addEventListener('change', (e) => { filter.status = e.target.value; neu() })
  ctx.element.addEventListener('click', (e) => {
    const basisKnopf = e.target.closest('[data-zahlungsbasis-button]')
    if (!basisKnopf) return
    filter.zahlungsbasis = basisKnopf.dataset.zahlungsbasisButton
    neu()
  })
  ctx.element.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => tabWechseln(b.dataset.tab)))
  $('[data-punkt]').addEventListener('click', () => { Object.assign(filter, { suche: '', lieferant: '', art: '', jahr: '', monat: '', status: '', zahlungsbasis: 'zahlung' }); $('[data-suche]').value = ''; neu() })
  $('[data-monate]').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-monat]')
    if (!chip) return
    const [j, mo] = chip.dataset.monat.split('-')
    const gleich = filter.jahr === j && filter.monat === mo
    filter.jahr = j
    filter.monat = gleich ? '' : mo
    neu()
  })

  // ---------- Abgleich mit Shopify (Bestellungen + Beleg-PDF) und Shirtigo (Kosten) ----------
  // Hinweise der Abgleiche (z. B. Ansichtskopie nicht angelegt, Windows-Schutz fehlgeschlagen) nicht verschweigen
  const hinweisText = (h) => h?.length ? ` Hinweis: ${h[0]}${h.length > 1 ? ` (+${h.length - 1} weitere)` : ''}.` : ''
  const shirtigoText = (s) => {
    let t = `Shirtigo: ${s.neu} neu, ${s.geaendert} geändert, ${s.ohneRechnung} noch ohne Rechnung`
    if (s.pdfNeu) t += ` · ${s.pdfNeu} Original-PDF${s.pdfNeu === 1 ? '' : 's'} geladen`
    if (s.pdfFehler?.length) t += ` · PDF-Download: ${s.pdfFehler[0]}`
    if (s.pdfOffen) t += ` · ${s.pdfOffen} Rechnung(en) noch ohne PDF${s.pdfKeine ? ` (${s.pdfKeine} davon hat Shirtigo noch nicht herausgegeben)` : ' – wird beim nächsten Abgleich fortgesetzt'}`
    return t + '.' + hinweisText(s.hinweise)
  }

  async function pdfHolen() {
    status('Hole Original-PDFs von Shirtigo …')
    let fragtFortschritt = false
    const ticker = setInterval(async () => {
      if (fragtFortschritt) return
      fragtFortschritt = true
      try {
        const f = await ctx.aufrufen('shirtigoFortschritt')
        if (f?.phase === 'pdf') status(`Shirtigo: Original-PDFs ${f.erledigt}/${f.gesamt} · ${f.pdfNeu} geladen, ${f.pdfFehler} Fehler …`)
        else if (f?.phase === 'bestellungen') status(`Shirtigo: Bestellungen werden geladen (Seite ${f.seite}) …`)
      } catch { /* Fortschrittsanzeige darf den Abruf nicht stören */ }
      finally { fragtFortschritt = false }
    }, 1500)
    try {
      const s = await ctx.aufrufen('shirtigoSyncen')
      dateien = await ctx.aufrufen('liste')
      await summeLaden()
      status(s ? shirtigoText(s) : 'Shirtigo ist nicht verbunden.')
    } catch (e) { status(`Shirtigo: ${e.message}`) }
    finally { clearInterval(ticker) }
  }

  // Zeigt, ob der Shirtigo-Token gespeichert ist (er liegt verschlüsselt im Benutzerordner der App)
  async function shirtigoAnzeige() {
    const ok = await ctx.aufrufen('shirtigoStatus')
    const menue = ctx.kopfKnoepfe.querySelector('[data-menue="shirtigo"]')
    menue.querySelector('[data-shirtigo-label]').textContent = ok ? 'Shirtigo verbunden' : 'Shirtigo verbinden'
    menue.classList.toggle('rn-menue-ok', ok)
    menue.querySelector('[data-shirtigo-hinweis]').textContent = ok ? 'Token gespeichert (verschlüsselt). Du kannst ihn hier ersetzen.' : 'API-Token aus dem Shirtigo-Cockpit einfügen.'
    ctx.kopfKnoepfe.querySelector('[data-shirtigo-knopf]').textContent = ok ? 'Token ersetzen' : 'Verbinden'
  }

  // Dropdown-Menüs in der Kopfzeile (Shirtigo, Wartung): klappen über dem Inhalt auf und schieben nichts
  const menuesSchliessen = (ausser) => ctx.kopfKnoepfe.querySelectorAll('.rn-menue').forEach((m) => {
    if (m === ausser) return
    m.querySelector('[data-menue-korb]').hidden = true
    m.querySelector('[data-menue-knopf]').setAttribute('aria-expanded', 'false')
  })
  ctx.kopfKnoepfe.addEventListener('click', (e) => {
    const knopf = e.target.closest('[data-menue-knopf]')
    if (!knopf) return
    const menue = knopf.closest('.rn-menue')
    const korb = menue.querySelector('[data-menue-korb]')
    menuesSchliessen(menue)
    korb.hidden = !korb.hidden
    knopf.setAttribute('aria-expanded', String(!korb.hidden))
    if (!korb.hidden) korb.querySelector('input')?.focus()
  })
  document.addEventListener('click', (e) => { if (!e.target.closest('.rn-menue')) menuesSchliessen() })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menuesSchliessen() })

  function abgleichen() {
    if (abgleichLaeuft) return abgleichLaeuft
    const knopf = ctx.kopfKnoepfe.querySelector('[data-sync]')
    knopf.disabled = true
    abgleichLaeuft = (async () => {
      status('Hole Bestellungen aus Shopify …')
      try {
        const r = await ctx.aufrufen('bestellungenSyncen')
        let text = r.neu + r.geaendert ? `${r.neu} neue, ${r.geaendert} geänderte Bestellung(en) mit Beleg-PDF abgelegt.` : 'Bestellungen sind aktuell.'
        if (r.pdfNeu) text += ` ${r.pdfNeu} fehlende Beleg-PDF${r.pdfNeu === 1 ? '' : 's'} neu erzeugt.`
        if (r.zahlungenNeu) text += ` Zahlungsdatum für ${r.zahlungenNeu} ältere Bestellung${r.zahlungenNeu === 1 ? '' : 'en'} nachgeholt.`
        if (r.pdfFehler) text += ` PDF-Fehler: ${r.pdfFehler}.`
        text += hinweisText(r.hinweise)
        status(text + ' Hole Shirtigo-Daten …')
        try {
          const s = await ctx.aufrufen('shirtigoSyncen') // null, wenn Shirtigo nicht verbunden ist
          if (s) text += ` · ${shirtigoText(s)}`
        } catch (e) { text += ` · Shirtigo: ${e.message}` }
        dateien = await ctx.aufrufen('liste')
        await summeLaden()
        status(text)
      } catch (e) { status(`Shopify-Abgleich fehlgeschlagen: ${e.message}`) }
    })().finally(() => { knopf.disabled = false; abgleichLaeuft = null })
    return abgleichLaeuft
  }

  ctx.kopfKnoepfe.querySelector('[data-shirtigo-knopf]').addEventListener('click', async () => {
    const feld = ctx.kopfKnoepfe.querySelector('[data-shirtigo-token]')
    const token = feld.value.trim()
    if (!token) return feld.focus()
    feld.value = '' // nicht länger als nötig im Feld
    menuesSchliessen()
    status('Prüfe Token bei Shirtigo …')
    try {
      const r = await ctx.aufrufen('shirtigoVerbinden', token)
      status(`Shirtigo verbunden – ${r.anzahl} Tools gefunden.`)
      await shirtigoAnzeige().catch(() => {})
      abgleichen()
    } catch (e) { status(`Shirtigo: ${e.message}`) }
  })
  ctx.kopfKnoepfe.querySelector('[data-shirtigo-probe]').addEventListener('click', async () => {
    status('Frage Shirtigo ab …')
    try { const p = await ctx.aufrufen('shirtigoProbe'); status(`Fertig. Tools: ${p.werkzeuge.join(', ')} · Datei: ${p.datei}`) } catch (e) { status(`Shirtigo: ${e.message}`) }
  })

  async function shopifyAnzeige() {
    const menue = ctx.kopfKnoepfe.querySelector('[data-menue="shopify"]')
    if (!menue) return
    const z = (await ctx.aufrufen('zugaengeLaden')).shopify
    menue.querySelector('[data-shopify-label]').textContent = z.eingerichtet ? 'Shopify verbunden' : 'Shopify verbinden'
    menue.classList.toggle('rn-menue-ok', z.eingerichtet)
    menue.querySelector('[data-shopify-hinweis]').textContent = z.eingerichtet ? `Verbunden mit ${z.shop} (Token verschlüsselt gespeichert). Hier ersetzen oder beide Felder leer speichern zum Entfernen.` : 'Shop-Adresse und Admin-API-Zugriffstoken (shpat_…) einer eigenen App eintragen.'
    if (z.shop) menue.querySelector('[data-shopify-shop]').value = z.shop
  }
  ctx.kopfKnoepfe.querySelector('[data-shopify-speichern]')?.addEventListener('click', async () => {
    const feld = ctx.kopfKnoepfe.querySelector('[data-shopify-token]')
    const shop = ctx.kopfKnoepfe.querySelector('[data-shopify-shop]').value
    const token = feld.value
    feld.value = '' // nicht länger als nötig im Feld
    try {
      const r = await ctx.aufrufen('shopifyZugangSpeichern', { shop, token })
      menuesSchliessen()
      status(r.eingerichtet ? `Shopify-Zugang für ${r.shop} gespeichert. Jetzt „Synchronisieren“.` : 'Shopify-Zugang entfernt.')
      await shopifyAnzeige().catch(() => {})
    } catch (e) { status(`Shopify: ${e.message}`) }
  })

  await shirtigoAnzeige().catch(() => {})
  await shopifyAnzeige().catch(() => {})
  await laden() // zeigt nur die lokal gespeicherten Daten; abgefragt wird erst per „Synchronisieren“
  bereichUmschalten() // Start mit dem Dashboard „Übersicht“
  // Erinnerung an die USB-Sicherung (Plan 7.5: wenn die letzte älter als 7 Tage ist)
  if (umgebung.windows) try { const u = await ctx.aufrufen('usbStatus'); if (u?.erinnern && !$('[data-status]').textContent) status(`Letzte USB-Sicherung vor ${u.tageSeit} Tagen – bitte wieder sichern (⚙ Wartung → USB-Sicherung).`) } catch { /* Erinnerung ist nicht wichtig genug für eine Fehlermeldung */ }
}