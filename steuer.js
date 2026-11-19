'use strict'
// Steuer-Übersicht (Phase 4). Reine Rechenfunktionen ohne Dateizugriff. Ohne Gewähr – keine Steuerberatung.
// Schritt 4.2: Umsatz je Kalenderjahr so, wie § 19 Abs. 2 UStG ihn zählt – nach vereinnahmten Entgelten: jede Zahlung im
// Jahr ihres Eingangs, jede Erstattung mindert im Jahr der Erstattung. In der Regelbesteuerung zählt nur der Nettoanteil;
// die enthaltene Umsatzsteuer wird getrennt ausgewiesen (Plan 8.1).
// Schritt 4.3: Grenzwert-Wächter § 19 Abs. 1 UStG und EU-Fernverkauf § 3c Abs. 4 UStG, nach BMF-Schreiben vom 18.03.2025
// (III C 3 - S 7360/00027/044/105, Abschnitte 19.1 bis 19.3 und 19.7 UStAE):
// - Vorjahr über 25.000 € → im laufenden Jahr keine Kleinunternehmerregelung (19.1 Abs. 2 Satz 2).
// - Laufendes Jahr: steuerfrei, solange 100.000 € nicht überschritten sind; bereits der Umsatz, mit dem die Grenze
//   überschritten wird, ist steuerpflichtig (19.1 Abs. 2 Satz 4), ebenso alle danach vereinnahmten Entgelte (19.7 Abs. 1).
// - Im Jahr der Aufnahme der Tätigkeit gilt 25.000 € statt 100.000 € (19.1 Abs. 3).
// - Gesamtumsatz = vereinnahmte Entgelte, netto (19.2). „Nicht überschritten“: genau 25.000,00 € ist noch in Ordnung.
// - EU-Fernverkauf: Entgelte (netto) für Lieferungen an Privatkunden in anderen EU-Staaten, Vorjahr und laufendes Jahr
//   je höchstens 10.000 € (§ 3c Abs. 4) – sonst Besteuerung im Bestimmungsland. Zugeordnet nach Bestelldatum (Lieferung).

const rund = (n) => Math.round(n * 100) / 100
const GRENZE_VORJAHR = 25000
const GRENZE_LAUFEND = 100000
const GRENZE_GRUENDUNG = 25000
const GRENZE_EU = 10000
// EU-Mitgliedstaaten außer Deutschland (Ländercodes wie bei Shopify, Griechenland = GR)
const EU = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'])

// Einzelne Zahlungs-/Erstattungsposten (vereinnahmte Entgelte) in zeitlicher Reihenfolge
function posten(rechnungen = []) {
  const liste = []
  for (const r of rechnungen) {
    if (!r || r.art !== 'einnahme' || !r.summen) continue
    if (r.anbieter !== 'shopify-api') {
      // Einnahme aus einem eingelesenen Beleg: kein Zahlungsdatum bekannt → Rechnungsdatum
      if (r.datum) liste.push({ datum: r.datum, zeit: r.datum, umsatz: r.wirksam ?? 0, ust: 0, art: 'sonstige', referenz: r.referenz || r.rechnungsnummer || null })
      continue
    }
    const z = r.zahlung
    // Nettoanteil: in der Regelbesteuerung ohne die enthaltene USt (Verhältnis aus der Bestellung), sonst alles
    const faktor = r.regelbesteuerung && r.summen.brutto > 0 ? (r.summen.brutto - (r.summen.mwst || 0)) / r.summen.brutto : 1
    const p = (datum, zeit, betrag, art) => liste.push({ datum, zeit: zeit || datum, umsatz: betrag * faktor, ust: betrag * (1 - faktor), betrag, art, referenz: r.referenz })
    if (z?.bekannt) {
      for (const e of z.eingaenge || []) p(e.datum, e.zeit, e.betrag, 'eingang')
      for (const e of z.erstattungen || []) p(e.datum, e.zeit, -e.betrag, 'erstattung')
    } else if (r.datum && r.summen.brutto) {
      p(r.datum, r.datum, r.summen.brutto, 'geschaetzt') // Zahlungsdatum unbekannt: Bestelldatum als Schätzung
    }
  }
  return liste.sort((a, b) => String(a.zeit).localeCompare(String(b.zeit)))
}

// rechnungen: rechnung-Objekte (Shopify-Bestellungen aus bestellungen.js und eigene Einnahmen aus eingelesenen PDFs).
// Ausgaben werden ignoriert. Rückgabe: Jahre absteigend sortiert.
function umsatzJahre(rechnungen = []) {
  const jahre = new Map()
  const jahr = (j) => {
    if (!jahre.has(j)) jahre.set(j, { jahr: j, umsatz: 0, ust: 0, eingaenge: 0, erstattungen: 0, nachBestelldatum: 0, bestellungen: new Set(), geschaetzt: 0, sonstige: 0 })
    return jahre.get(j)
  }
  for (const r of rechnungen) {
    if (r?.art === 'einnahme' && r.summen && r.datum) jahr(r.datum.slice(0, 4)).nachBestelldatum += r.wirksam ?? 0 // Vergleichswert wie bisher
  }
  for (const x of posten(rechnungen)) {
    const j = jahr(x.datum.slice(0, 4))
    j.umsatz += x.umsatz
    j.ust += x.ust
    if (x.art === 'sonstige') { j.sonstige++; continue }
    if (x.art === 'eingang') j.eingaenge += x.betrag
    if (x.art === 'erstattung') j.erstattungen += -x.betrag
    if (x.art === 'geschaetzt') j.geschaetzt++
    j.bestellungen.add(x.referenz)
  }
  return [...jahre.values()]
    .map((j) => ({ jahr: j.jahr, umsatz: rund(j.umsatz), ust: rund(j.ust), eingaenge: rund(j.eingaenge), erstattungen: rund(j.erstattungen), nachBestelldatum: rund(j.nachBestelldatum), bestellungen: j.bestellungen.size, geschaetzt: j.geschaetzt, sonstige: j.sonstige }))
    .sort((a, b) => b.jahr.localeCompare(a.jahr))
}

// Erster Posten, mit dem die laufende Summe die Grenze überschreitet (strikt größer)
function ueberschreitung(liste, grenze, feld) {
  let summe = 0
  for (const x of liste) {
    summe = rund(summe + x[feld])
    if (summe > grenze) return { datum: x.datum, referenz: x.referenz, summe }
  }
  return null
}

const euroText = (n) => `${Number(n).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
const tagText = (t) => String(t).split('-').reverse().join('.')

// Grenzwert-Wächter für ein Kalenderjahr. stufe: gruen | gelb | orange | rot (die schlimmste zählt)
function grenzwerte(rechnungen = [], { jahr = String(new Date().getFullYear()) } = {}) {
  const alle = posten(rechnungen)
  const imJahr = (j) => alle.filter((x) => x.datum.startsWith(j))
  const summe = (liste) => rund(liste.reduce((s, x) => s + x.umsatz, 0))
  const vorjahrNr = String(Number(jahr) - 1)
  const laufend = summe(imJahr(jahr))
  const vorjahr = summe(imJahr(vorjahrNr))
  const ersteJahr = alle.length ? alle[0].datum.slice(0, 4) : jahr
  const gruendungsjahr = ersteJahr === jahr // keine Umsätze vor diesem Jahr → als Jahr der Aufnahme der Tätigkeit behandelt
  const grenzeLaufend = gruendungsjahr ? GRENZE_GRUENDUNG : GRENZE_LAUFEND
  const meldungen = []
  const melde = (stufe, text) => meldungen.push({ stufe, text })
  const folgejahr = Number(jahr) + 1

  const vorjahrUeber = !gruendungsjahr && vorjahr > GRENZE_VORJAHR
  if (vorjahrUeber) melde('rot', `Der Umsatz ${vorjahrNr} lag mit ${euroText(vorjahr)} über 25.000 €: Die Kleinunternehmerregelung gilt ${jahr} nicht – Umsatzsteuer ausweisen und abführen.`)
  const ueber = ueberschreitung(imJahr(jahr), grenzeLaufend, 'umsatz')
  if (ueber) {
    melde('rot', `${gruendungsjahr ? 'Im Jahr der Gründung gilt 25.000 €. ' : ''}Grenze von ${euroText(grenzeLaufend)} am ${tagText(ueber.datum)} überschritten${ueber.referenz ? ` (Zahlung zu Bestellung #${ueber.referenz})` : ''}: Bereits dieser Umsatz und alle danach eingehenden Zahlungen sind steuerpflichtig – Umsatzsteuer ausweisen.`)
  } else if (gruendungsjahr) {
    if (laufend >= GRENZE_GRUENDUNG * 0.8) melde('gelb', `Im Jahr der Gründung gilt 25.000 € als Grenze (bisher ${euroText(laufend)}): Schon der Umsatz, mit dem sie überschritten wird, ist steuerpflichtig.`)
  } else {
    if (laufend >= GRENZE_LAUFEND * 0.9) melde('rot', `Umsatz ${jahr} ${euroText(laufend)} – nahe an 100.000 €: Bereits der Umsatz, mit dem die Grenze überschritten wird, ist steuerpflichtig.`)
    if (laufend > GRENZE_VORJAHR) melde('orange', `Umsatz ${jahr} über 25.000 €: Ab 01.01.${folgejahr} gilt die Regelbesteuerung – Umstellung vorbereiten (Preise, Shopify-Steuereinstellungen, Voranmeldungen).`)
    else if (laufend >= GRENZE_VORJAHR * 0.8) melde('gelb', `Umsatz ${jahr} ${euroText(laufend)}: Bei Überschreiten von 25.000 € endet die Kleinunternehmerregelung ab 01.01.${folgejahr}.`)
  }

  // EU-Fernverkauf: nach Bestelldatum (Lieferung), Entgelt netto nach Erstattungen, nur andere EU-Staaten, keine Stornos
  const eu = (j) => rechnungen.filter((r) => r?.art === 'einnahme' && r.anbieter === 'shopify-api' && !r.storniert && String(r.datum || '').startsWith(j) && EU.has(String(r.empfaenger?.land || '').toUpperCase()))
    .sort((a, b) => String(a.datum).localeCompare(String(b.datum))).map((r) => ({ datum: r.datum, referenz: r.referenz, entgelt: r.wirksam || 0, land: String(r.empfaenger.land).toUpperCase() }))
  const euLaufend = eu(jahr)
  const euSumme = rund(euLaufend.reduce((s, x) => s + x.entgelt, 0))
  const euVorjahr = rund(eu(vorjahrNr).reduce((s, x) => s + x.entgelt, 0))
  const laender = [...new Set(euLaufend.map((x) => x.land))].sort()
  if (euVorjahr > GRENZE_EU) melde('rot', `EU-Fernverkäufe ${vorjahrNr} über 10.000 € (${euroText(euVorjahr)}): Lieferungen an Privatkunden in andere EU-Länder sind ${jahr} im Bestimmungsland steuerpflichtig (OSS prüfen).`)
  const euUeber = ueberschreitung(euLaufend, GRENZE_EU, 'entgelt')
  if (euUeber) melde('rot', `EU-Fernverkäufe ${jahr} am ${tagText(euUeber.datum)} über 10.000 €${euUeber.referenz ? ` (Bestellung #${euUeber.referenz})` : ''}: Ab dieser Lieferung Besteuerung im Bestimmungsland (OSS prüfen).`)
  else if (euSumme >= GRENZE_EU * 0.8) melde('gelb', `EU-Fernverkäufe ${jahr} ${euroText(euSumme)} – nahe an 10.000 €: Danach gilt die Umsatzsteuer des Bestimmungslands.`)

  const reihenfolge = ['gruen', 'gelb', 'orange', 'rot']
  const stufe = meldungen.reduce((s, x) => reihenfolge.indexOf(x.stufe) > reihenfolge.indexOf(s) ? x.stufe : s, 'gruen')
  return {
    jahr, stufe, meldungen, gruendungsjahr,
    kleinunternehmer: !(vorjahrUeber || ueber), // § 19 gilt laut Daten (noch) für das ganze Jahr bis heute
    laufend: { umsatz: laufend, grenze: grenzeLaufend, grenze25: GRENZE_VORJAHR, ueberschritten: ueber },
    vorjahr: { jahr: vorjahrNr, umsatz: vorjahr, grenze: GRENZE_VORJAHR },
    eu: { umsatz: euSumme, vorjahr: euVorjahr, grenze: GRENZE_EU, laender, ueberschritten: euUeber }
  }
}

// ---------- § 13b UStG: Steuer, die du als Leistungsempfänger schuldest (Schritt 4.4, Plan 7.4) ----------
// Gesetz und Vordruck USt 1 A 2026 (geprüft 29.10.2026):
// - Sonstige Leistungen eines im übrigen Gemeinschaftsgebiet ansässigen Unternehmers (§ 13b Abs. 1): Steuer entsteht mit
//   Ablauf des Monats, in dem die Leistung ausgeführt wurde → Kz 46 (Bemessungsgrundlage) / Kz 47 (Steuer).
// - Leistungen eines im Ausland (Drittland) ansässigen Unternehmers (§ 13b Abs. 2 Nr. 1): mit Ausstellung der Rechnung,
//   spätestens mit Ablauf des Folgemonats → Kz 84 / Kz 85.
// - Gilt auch für Kleinunternehmer (§ 13b Abs. 5). Voranmeldung + Zahlung am 10. Tag nach Ablauf des Monats.
// - Kein Vorsteuerabzug (Entscheidung Nutzer): die Steuer ist zusätzlicher Aufwand.
const P13B_SATZ = 19
// Zahlungsdienste: Gebühren meist umsatzsteuerfrei (§ 4 Nr. 8 UStG) → dann keine § 13b-Steuer. Nur Vorschlag, prüfen!
const ZAHLUNGSDIENST = /viva|paypal|stripe|mollie|klarna|adyen|sumup|payone|wise|revolut/i
const MONAT = /^\d{4}-(0[1-9]|1[0-2])$/

// Fall für eine Ausgaben-Rechnung oder null (kein § 13b). eintrag = gespeicherte Angaben je Rechnung { aktiv, monat, satz,
// betragEur }, anbieter = Einstufung des Lieferanten { einstufung: 'steuerpflichtig'|'steuerfrei', herkunft: 'eu'|'drittland' }.
function p13bFall(r, eintrag = {}, anbieter = {}) {
  if (!r || r.art === 'einnahme') return null
  const aktiv = eintrag.aktiv === true || (eintrag.aktiv !== false && !!r.reverseCharge)
  if (!aktiv) return null
  const vermutetFrei = !anbieter.einstufung && ZAHLUNGSDIENST.test(String(r.lieferant || ''))
  const steuerfrei = anbieter.einstufung === 'steuerfrei' || vermutetFrei
  const herkunft = anbieter.herkunft || r.herkunft || 'eu'
  const monat = MONAT.test(String(eintrag.monat || '')) ? eintrag.monat : String(r.datum || '').slice(0, 7) || null
  const satz = Number.isFinite(eintrag.satz) && eintrag.satz > 0 ? eintrag.satz : P13B_SATZ
  const fremd = r.waehrung && r.waehrung !== 'EUR'
  const bemessung = Number.isFinite(eintrag.betragEur) ? rund(eintrag.betragEur) : fremd ? null : rund(r.summen?.netto ?? r.summen?.brutto ?? 0)
  const steuer = steuerfrei || bemessung == null ? 0 : rund(bemessung * satz / 100)
  return {
    monat, herkunft, satz, bemessung, steuer, steuerfrei, vermutetFrei, waehrungFehlt: fremd && bemessung == null,
    kz: herkunft === 'drittland' ? ['84', '85'] : ['46', '47'], quelle: eintrag.aktiv === true ? 'manuell' : 'erkannt'
  }
}

// Fälligkeit: 10. Tag nach Ablauf des Monats; fällt er auf Samstag/Sonntag, der nächste Montag (§ 108 Abs. 3 AO).
// Gesetzliche Feiertage sind nicht berücksichtigt.
function faelligAm(monat) {
  const [j, m] = monat.split('-').map(Number)
  const d = new Date(Date.UTC(m === 12 ? j + 1 : j, m === 12 ? 0 : m, 10))
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

// Monatsübersicht: faelle = [{ fall, lieferant, id }], angemeldet = { 'JJJJ-MM': { am: 'JJJJ-MM-TT' } }
function p13bMonate(faelle = [], angemeldet = {}, { heute = new Date().toISOString().slice(0, 10) } = {}) {
  const monate = new Map()
  for (const { fall } of faelle) {
    if (!fall?.monat) continue
    if (!monate.has(fall.monat)) monate.set(fall.monat, { monat: fall.monat, rechnungen: 0, steuerfrei: 0, eu: { bemessung: 0, steuer: 0 }, drittland: { bemessung: 0, steuer: 0 }, offenWaehrung: 0 })
    const x = monate.get(fall.monat)
    x.rechnungen++
    if (fall.steuerfrei) { x.steuerfrei++; continue }
    if (fall.waehrungFehlt) { x.offenWaehrung++; continue }
    const ziel = fall.herkunft === 'drittland' ? x.drittland : x.eu
    ziel.bemessung += fall.bemessung
    ziel.steuer += fall.steuer
  }
  return [...monate.values()].map((x) => {
    for (const k of ['eu', 'drittland']) { x[k].bemessung = rund(x[k].bemessung); x[k].steuer = rund(x[k].steuer) }
    const steuer = rund(x.eu.steuer + x.drittland.steuer)
    const faellig = faelligAm(x.monat)
    const am = angemeldet[x.monat]?.am || null
    const pflicht = steuer > 0 || x.offenWaehrung > 0
    return { ...x, steuer, faellig, angemeldet: am, pflicht, ueberfaellig: pflicht && !am && heute > faellig }
  }).sort((a, b) => b.monat.localeCompare(a.monat))
}

module.exports = { umsatzJahre, grenzwerte, posten, p13bFall, p13bMonate, faelligAm, GRENZE_VORJAHR, GRENZE_LAUFEND, GRENZE_EU, P13B_SATZ }
