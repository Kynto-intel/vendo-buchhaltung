'use strict'
// „Meine Angaben“ → Persönliche Angaben (Plan 11.3, M.2) und ELSTER-Übersicht (M.5).
// Gebraucht für die Einkommensteuererklärung in Mein ELSTER (Hauptvordruck); Vendo sendet nichts an ELSTER.
// Besonders schützenswert (Religion, Steuer-ID, Geburtsdatum): gespeichert wird nur verschlüsselt (haupt.js, safeStorage),
// nie in Logs, nicht im Jahresarchiv.

const FELDER = [
  { feld: 'anrede', gruppe: 'Steuerpflichtige Person', label: 'Anrede', typ: 'auswahl', optionen: ['', 'Frau', 'Herr', 'Divers'] },
  { feld: 'steuerId', gruppe: 'Steuerpflichtige Person', label: 'Steuer-ID (11 Ziffern)', typ: 'text' },
  { feld: 'vorname', gruppe: 'Steuerpflichtige Person', label: 'Vorname', typ: 'text' },
  { feld: 'nachname', gruppe: 'Steuerpflichtige Person', label: 'Nachname', typ: 'text' },
  { feld: 'geburtsdatum', gruppe: 'Steuerpflichtige Person', label: 'Geburtsdatum', typ: 'datum' },
  { feld: 'religion', gruppe: 'Steuerpflichtige Person', label: 'Religion (Kirchensteuer)', typ: 'text', vorschlaege: ['keine', 'evangelisch', 'römisch-katholisch', 'altkatholisch'] },
  { feld: 'beruf', gruppe: 'Steuerpflichtige Person', label: 'Ausgeübter Beruf', typ: 'text' },
  { feld: 'veranlagung', gruppe: 'Veranlagung', label: 'Art', typ: 'auswahl', optionen: ['', 'einzeln', 'zusammen', 'getrennt'] },
  { feld: 'verheiratetSeit', gruppe: 'Veranlagung', label: 'Verheiratet / verpartnert seit', typ: 'datum' },
  { feld: 'ehegatteVorname', gruppe: 'Ehegatte (Person B)', label: 'Vorname', typ: 'text' },
  { feld: 'ehegatteNachname', gruppe: 'Ehegatte (Person B)', label: 'Nachname', typ: 'text' },
  { feld: 'ehegatteSteuerId', gruppe: 'Ehegatte (Person B)', label: 'Steuer-ID (11 Ziffern)', typ: 'text' },
  { feld: 'ehegatteGeburtsdatum', gruppe: 'Ehegatte (Person B)', label: 'Geburtsdatum', typ: 'datum' },
  { feld: 'ehegatteReligion', gruppe: 'Ehegatte (Person B)', label: 'Religion (Kirchensteuer)', typ: 'text', vorschlaege: ['keine', 'evangelisch', 'römisch-katholisch', 'altkatholisch'] }
]
const NAMEN = new Set(FELDER.map((f) => f.feld))

function normalisieren(eingabe = {}) {
  const w = {}
  for (const f of FELDER) {
    let x = String(eingabe?.[f.feld] ?? '').trim().replace(/\s+/g, ' ').slice(0, 120)
    if (f.feld === 'steuerId' || f.feld === 'ehegatteSteuerId') x = x.replace(/[\s/.-]/g, '')
    if (f.typ === 'auswahl' && !f.optionen.includes(x)) x = ''
    w[f.feld] = x
  }
  return w
}

// Steuerliche Identifikationsnummer (§ 139b AO): 11 Ziffern, erste nicht 0, Prüfziffer nach ISO/IEC 7064 MOD 11,10;
// in den ersten 10 Ziffern kommt genau eine Ziffer zwei- oder dreimal vor (dreimal nicht direkt hintereinander).
function steuerIdGueltig(id) {
  const s = String(id || '')
  if (!/^[1-9]\d{10}$/.test(s)) return false
  const zehn = s.slice(0, 10)
  const anzahl = {}
  for (const z of zehn) anzahl[z] = (anzahl[z] || 0) + 1
  const mehrfach = Object.values(anzahl).filter((n) => n > 1)
  if (mehrfach.length !== 1 || mehrfach[0] > 3) return false
  if (/(\d)\1\1/.test(zehn)) return false
  let produkt = 10
  for (let i = 0; i < 10; i++) {
    let summe = (Number(zehn[i]) + produkt) % 10
    if (summe === 0) summe = 10
    produkt = (summe * 2) % 11
  }
  const pruef = (11 - produkt) % 10
  return pruef === Number(s[10])
}

const TAG = /^\d{4}-\d{2}-\d{2}$/
function pruefen(w) {
  const fehler = []
  for (const [feld, label] of [['steuerId', 'Steuer-ID'], ['ehegatteSteuerId', 'Steuer-ID des Ehegatten']]) {
    if (w[feld] && !steuerIdGueltig(w[feld])) fehler.push({ feld, text: `${label} ist ungültig (11 Ziffern mit Prüfziffer).` })
  }
  for (const f of FELDER.filter((x) => x.typ === 'datum')) {
    if (w[f.feld] && (!TAG.test(w[f.feld]) || Number.isNaN(Date.parse(w[f.feld])))) fehler.push({ feld: f.feld, text: `${f.label}: Datum im Format JJJJ-MM-TT.` })
  }
  if (w.veranlagung === 'zusammen' && !(w.ehegatteVorname && w.ehegatteNachname)) fehler.push({ feld: 'ehegatteVorname', text: 'Bei Zusammenveranlagung den Namen des Ehegatten eintragen.' })
  return { ok: fehler.length === 0, fehler }
}

const leer = () => Object.fromEntries(FELDER.map((f) => [f.feld, '']))

// ELSTER-Übersicht für ein Jahr: welche Werte wohin gehören (zum Abtippen, ohne Gewähr)
const ANLAGE = { gewerbe: 'Anlage G', selbstaendig: 'Anlage S' }
function elster({ person = {}, firma = {}, euer = null, jahr } = {}) {
  const p = { ...leer(), ...person }
  const name = (v, n) => [v, n].filter(Boolean).join(' ')
  const hauptvordruck = [
    ['Steuer-ID', p.steuerId], ['Name', name(p.vorname, p.nachname)], ['Geburtsdatum', p.geburtsdatum], ['Religion', p.religion],
    ['Ausgeübter Beruf', p.beruf], ['Veranlagung', p.veranlagung], ['Verheiratet / verpartnert seit', p.verheiratetSeit]
  ]
  if (p.veranlagung === 'zusammen' || p.ehegatteNachname) {
    hauptvordruck.push(['Ehegatte: Steuer-ID', p.ehegatteSteuerId], ['Ehegatte: Name', name(p.ehegatteVorname, p.ehegatteNachname)],
      ['Ehegatte: Geburtsdatum', p.ehegatteGeburtsdatum], ['Ehegatte: Religion', p.ehegatteReligion])
  }
  const anlage = ANLAGE[firma.einkunftsart] || 'Anlage G oder S (Einkunftsart unter Firmendaten wählen)'
  const e = euer || {}
  const euerZeilen = [
    ['Kz 111', 'Betriebseinnahmen als Kleinunternehmer', e.kz111], ['Kz 112', 'Umsatzsteuerpflichtige Betriebseinnahmen (netto)', e.kz112],
    ['Kz 140', 'Vereinnahmte Umsatzsteuer', e.kz140], ['Kz 100', 'Waren, Rohstoffe und Hilfsstoffe', e.kz100],
    ['Kz 186', 'An das Finanzamt gezahlte Umsatzsteuer', e.kz186], ['–', 'Übrige Ausgaben (eingelesene Belege, Kennzahl je Art selbst zuordnen)', e.sonstige]
  ].filter(([, , wert]) => Number(wert))
  return {
    jahr, hinweis: 'Zum Abtippen in Mein ELSTER. Ohne Gewähr, keine Steuerberatung. Leere Felder fehlen in „Meine Angaben“.',
    hauptvordruck: hauptvordruck.map(([label, wert]) => ({ label, wert: wert || '' })),
    gewinn: { anlage, label: 'Gewinn laut Anlage EÜR', wert: euer ? e.gewinn : null },
    euer: euerZeilen.map(([kz, label, wert]) => ({ kz, label, wert })),
    firma: { name: firma.firmenname || '', steuernummer: firma.steuernummer || '', finanzamt: firma.finanzamt || '' }
  }
}

module.exports = { FELDER, NAMEN, normalisieren, pruefen, steuerIdGueltig, leer, elster }
