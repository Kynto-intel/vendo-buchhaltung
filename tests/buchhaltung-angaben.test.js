import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

// Tests für „Meine Angaben“ (plugins/buchhaltung/angaben.js): Eingabeprüfung (Schritt 2.1) und Steuerstatus je Zeitraum (2.2).
// Nur synthetische Angaben (Beispiel-IBAN aus der Norm, erfundene Namen und Nummern).

const require = createRequire(import.meta.url)
const a = require('../angaben.js')

const gueltig = {
  firmenname: 'Synthetik-Shop', inhaber: 'Erika Muster', strasse: 'Teststraße 1', plz: '12345', ort: 'Musterstadt', land: 'de',
  email: 'Test@Example.test', steuernummer: '123/456/78901', iban: 'de89 3704 0044 0532 0130 00', bic: 'cobadeffxxx',
  steuerzeitraeume: [{ von: '', bis: '', art: 'klein' }]
}

test('Normalisieren und Prüfen: Formate, Großschreibung, unbekannte Felder fallen weg (Schritt 2.1)', () => {
  const w = a.normalisieren({ ...gueltig, geheim: 'x', eigeneNamen: 'Muster\nSynthetik, Muster' })
  assert.deepEqual([w.land, w.email, w.iban, w.bic, 'geheim' in w, w.eigeneNamen], ['DE', 'test@example.test', 'DE89370400440532013000', 'COBADEFFXXX', false, ['Muster', 'Synthetik']])
  const p = a.pruefen(w)
  assert.deepEqual([p.ok, p.vollstaendig, p.fehlend], [true, true, []], JSON.stringify(p.fehler))
  const fehlerVon = (aenderung) => Object.keys(a.pruefen(a.normalisieren({ ...gueltig, ...aenderung })).fehler)
  assert.deepEqual(fehlerVon({ iban: 'DE89370400440532013001' }), ['iban'], 'IBAN-Prüfsumme')
  assert.deepEqual(fehlerVon({ iban: 'DE8937040044053201300' }), ['iban'], 'deutsche IBAN hat 22 Zeichen')
  assert.deepEqual(fehlerVon({ plz: '1234' }), ['plz'])
  assert.deepEqual(fehlerVon({ land: 'AT', plz: '1010' }), [], 'ausländische PLZ')
  assert.deepEqual(fehlerVon({ email: 'kein-at.example' }), ['email'])
  assert.deepEqual(fehlerVon({ steuernummer: '123/456' }), ['steuernummer'])
  assert.deepEqual(fehlerVon({ ustId: 'DE12345678' }), ['ustId'])
  assert.deepEqual(fehlerVon({ wId: 'DE123456789-00001' }), [])
  assert.deepEqual(fehlerVon({ wId: 'DE123456789-1' }), ['wId'])
  assert.deepEqual(fehlerVon({ bic: 'ABC' }), ['bic'])
  assert.deepEqual(fehlerVon({ nummernFormat: 'RE/{NNNN}' }), ['nummernFormat'], 'kein / im Nummernkreis')
  assert.deepEqual(fehlerVon({ nummernFormat: 'RE-{JJJJ}' }), ['nummernFormat'], 'laufende Nummer fehlt')
  assert.deepEqual(fehlerVon({ naechsteNummer: '0' }), ['naechsteNummer'])
  const leer = a.pruefen(a.normalisieren({}))
  assert.deepEqual(leer.fehlend, ['firmenname', 'inhaber', 'strasse', 'plz', 'ort', 'email', 'steuerkennung', 'steuerzeitraeume'])
  assert.equal(a.nummerVorschau('RE-{JJJJ}-{MM}-{NNNN}', 7, new Date(2026, 2, 5)), 'RE-2026-03-0007')
})

test('Firmendaten: Gründungsdatum, Finanzamt und Haben-Auswahlen werden normalisiert und geprüft', () => {
  const werte = a.normalisieren({
    ...gueltig,
    taetigkeit: ' Softwareentwicklung ',
    gruendungsdatum: '2000-02-29',
    finanzamt: ' Musterstadt ',
    rechtsform: 'ug',
    einkunftsart: 'gewerbe',
    versteuerung: 'soll',
    kontenrahmen: 'SKR04'
  })
  assert.deepEqual(
    [werte.taetigkeit, werte.gruendungsdatum, werte.finanzamt, werte.rechtsform, werte.einkunftsart, werte.versteuerung, werte.kontenrahmen],
    ['Softwareentwicklung', '2000-02-29', 'Musterstadt', 'ug', 'gewerbe', 'soll', 'SKR04']
  )
  assert.equal(a.pruefen(werte).ok, true)
  assert.equal(a.pruefen(a.normalisieren({ ...gueltig, taetigkeit: 'A'.repeat(100) })).ok, true)
  assert.deepEqual(
    a.FELDER.find((f) => f.feld === 'rechtsform').optionen.map((o) => o.wert),
    ['einzelunternehmen', 'gmbh', 'ug']
  )
  assert.deepEqual(
    a.FELDER.find((f) => f.feld === 'einkunftsart').optionen.map((o) => o.wert),
    ['', 'selbstaendig', 'gewerbe']
  )

  const fehlerVon = (aenderung) => Object.keys(a.pruefen(a.normalisieren({ ...gueltig, ...aenderung })).fehler)
  assert.deepEqual(fehlerVon({ gruendungsdatum: '2025-02-29' }), ['gruendungsdatum'])
  assert.deepEqual(fehlerVon({ gruendungsdatum: '9999-12-31' }), ['gruendungsdatum'])
  assert.deepEqual(fehlerVon({ rechtsform: 'gbr' }), ['rechtsform'])
  assert.deepEqual(fehlerVon({ einkunftsart: 'freelance' }), ['einkunftsart'])
  assert.deepEqual(fehlerVon({ rechtsform: 'gmbh', einkunftsart: 'freelance' }), [], 'EÜR-Art wird bei Kapitalgesellschaften nicht geprüft')
  assert.deepEqual(fehlerVon({ versteuerung: 'bar' }), ['versteuerung'])
  assert.deepEqual(fehlerVon({ kontenrahmen: 'SKR05' }), ['kontenrahmen'])
  assert.deepEqual(fehlerVon({ taetigkeit: 'A'.repeat(101) }), ['taetigkeit'])
})

test('Steuerstatus je Zeitraum: Normalisieren, lückenlos, keine Überschneidung, Satz nur bei Regelbesteuerung (Schritt 2.2)', () => {
  const pruefe = (zeitraeume) => a.pruefen(a.normalisieren({ ...gueltig, steuerzeitraeume: zeitraeume }))
  const drei = [
    { von: '2024-06-01', bis: '', art: 'klein', satz: '19' },
    { von: '', bis: '2024-03-31', art: 'klein' },
    { von: '2024-04-01', bis: '2024-05-31', art: 'regel', satz: '19,0 %' }
  ]
  const w = a.normalisieren({ steuerzeitraeume: drei })
  assert.deepEqual(w.steuerzeitraeume, [
    { von: '', bis: '2024-03-31', art: 'klein', satz: null },
    { von: '2024-04-01', bis: '2024-05-31', art: 'regel', satz: 19 },
    { von: '2024-06-01', bis: '', art: 'klein', satz: null }
  ], 'sortiert, Satz als Zahl, bei Kleinunternehmer kein Satz')
  const ok = pruefe(drei)
  assert.deepEqual([ok.ok, ok.fehler.steuerzeitraeume, ok.hinweise.filter((h) => /Steuerstatus|Steuersatz/.test(h))], [true, undefined, []])

  const fehler = (zeitraeume) => pruefe(zeitraeume).fehler.steuerzeitraeume
  assert.equal(fehler([{ von: '', bis: '2024-03-31', art: 'klein' }, { von: '2024-04-02', bis: '', art: 'klein' }]), 'Zwischen 31.03.2024 und 02.04.2024 fehlt ein Zeitraum.')
  assert.equal(fehler([{ von: '', bis: '2024-04-05', art: 'klein' }, { von: '2024-04-01', bis: '', art: 'regel', satz: 19 }]), 'Zeile 1 und 2 überschneiden sich (01.04.2024).')
  assert.equal(fehler([{ von: '2024-02-30', bis: '', art: 'klein' }]), '„von“ ist kein gültiges Datum.')
  assert.equal(fehler([{ von: '2024-05-01', bis: '2024-04-01', art: 'klein' }]), '„bis“ liegt vor „von“.')
  assert.equal(fehler([{ von: '', bis: '2024-03-31', art: 'klein' }, { von: '', bis: '', art: 'regel', satz: 19 }]), 'Zeile 2: Bitte ein Anfangsdatum angeben (nur der erste Zeitraum darf „seit Beginn“ sein).')
  assert.equal(fehler([{ von: '', bis: '', art: 'klein' }, { von: '2024-01-01', bis: '', art: 'regel', satz: 19 }]), 'Zeile 1: Bitte ein Enddatum angeben (nur der letzte Zeitraum darf offen bleiben).')
  for (const satz of ['', '0', '31', 'neunzehn', '19,555']) assert.match(fehler([{ von: '', bis: '', art: 'regel', satz }]), /Steuersatz/, `Satz ${satz}`)
  assert.equal(fehler([{ von: '', bis: '', art: 'regel', satz: '7' }]), undefined)
  assert.ok(pruefe([{ von: '', bis: '', art: 'regel', satz: '16' }]).hinweise.some((h) => /Ungewöhnlicher Steuersatz/.test(h)))
  const nichtOffen = pruefe([{ von: '2023-01-01', bis: '2024-12-31', art: 'klein' }])
  assert.deepEqual([nichtOffen.ok, nichtOffen.hinweise.filter((h) => /kein Steuerstatus/.test(h)).length], [true, 2], 'Anfang und Ende nicht abgedeckt → Hinweise')
  assert.equal(a.normalisieren({ steuerzeitraeume: Array.from({ length: 30 }, () => ({})) }).steuerzeitraeume.length, 20, 'höchstens 20 Zeilen')
  assert.deepEqual(a.normalisieren({ steuerzeitraeume: 'kaputt' }).steuerzeitraeume, [])
  assert.deepEqual(a.unterschiede({ steuerzeitraeume: [] }, w).map((x) => x.feld).includes('steuerzeitraeume'), true, 'Änderung landet im Verlauf')
})

test('Steuerstatus am Tag: Grenzen inklusive, Lücken ergeben null (Schritt 2.2, für 2.3)', () => {
  const liste = a.normalisieren({ steuerzeitraeume: [{ von: '', bis: '2024-03-31', art: 'klein' }, { von: '2024-04-01', bis: '2024-05-31', art: 'regel', satz: 19 }, { von: '2024-06-01', bis: '', art: 'klein' }] }).steuerzeitraeume
  const art = (t) => a.steuerstatusAm(liste, t)?.art ?? null
  assert.deepEqual(['2019-01-01', '2024-03-31', '2024-04-01', '2024-05-31', '2024-06-01', '2030-01-01'].map(art), ['klein', 'klein', 'regel', 'regel', 'klein', 'klein'])
  assert.equal(a.steuerstatusAm(liste, '2024-04-15T10:00:00Z').satz, 19, 'Zeitstempel wird auf den Tag gekürzt')
  assert.equal(a.steuerstatusAm([{ von: '2024-01-01', bis: '2024-01-31', art: 'klein' }], '2024-02-01'), null)
  assert.equal(a.steuerstatusAm([], '2024-02-01'), null)
})

test('Vorschlag aus den Bestellungen: erster bis letzter Tag mit Steuer, Satz aus den Beträgen, Stornos zählen nicht (Schritt 2.2)', () => {
  const befund = [
    { nr: '1', datum: '2024-03-20', steuer: 0, brutto: 30, storniert: false },
    { nr: '2', datum: '2024-04-03', steuer: 3.8, brutto: 23.8, storniert: false },
    { nr: '3', datum: '2024-05-28', steuer: 4.79, brutto: 30, storniert: false }, // 19 % (gerundet)
    { nr: '4', datum: '2024-04-20', steuer: 0, brutto: 0, storniert: false }, // komplett erstattet
    { nr: '5', datum: '2024-07-01', steuer: 1.9, brutto: 11.9, storniert: true }, // storniert: zählt nicht
    { nr: '6', datum: '2024-05-02', steuer: 1.9, brutto: 11.9, storniert: false }
  ]
  const v = a.steuerVorschlag(befund)
  assert.deepEqual(v.zeitraeume, [
    { von: '', bis: '2024-04-02', art: 'klein', satz: null },
    { von: '2024-04-03', bis: '2024-05-28', art: 'regel', satz: 19 },
    { von: '2024-05-29', bis: '', art: 'klein', satz: null }
  ])
  assert.deepEqual([v.anzahl, v.von, v.bis, v.satz, v.steuer], [3, '2024-04-03', '2024-05-28', 19, 10.49])
  assert.equal(a.pruefen({ ...a.normalisieren(gueltig), steuerzeitraeume: v.zeitraeume }).ok, true, 'Vorschlag besteht die eigene Prüfung')
  assert.equal(a.steuerVorschlag([{ nr: '9', datum: '2024-01-02', steuer: 0.7, brutto: 10.7, storniert: false }]).satz, 7)
  assert.deepEqual(a.steuerVorschlag([{ nr: '1', datum: '2024-01-01', steuer: 0, brutto: 9, storniert: false }]).zeitraeume, [{ von: '', bis: '', art: 'klein', satz: null }], 'nie Steuer → durchgehend Kleinunternehmer')
  assert.equal(a.steuerVorschlag([]).anzahl, 0)
  assert.equal(a.steuerVorschlag([{ nr: '1', datum: '2024-12-31', steuer: 1.9, brutto: 11.9 }]).zeitraeume[2].von, '2025-01-01', 'Jahreswechsel')

  const g = a.steuerAbgleich(v.zeitraeume, [...befund, { nr: '7', datum: '2024-04-10', steuer: 0, brutto: 20, storniert: false }, { nr: '8', datum: '2024-08-01', steuer: 3.8, brutto: 23.8, storniert: false }])
  assert.deepEqual([g.geprueft, g.steuerTrotzKlein, g.ohneSteuerBeiRegel, g.ohneStatus], [6, [{ nr: '8', datum: '2024-08-01' }], [{ nr: '7', datum: '2024-04-10' }], []])
  const luecke = a.steuerAbgleich([{ von: '2024-04-01', bis: '', art: 'klein', satz: null }], befund)
  assert.deepEqual(luecke.ohneStatus, [{ nr: '1', datum: '2024-03-20' }])
  assert.equal(a.steuerAbgleich([], befund).geprueft, 0, 'ohne gespeicherten Steuerstatus kein Abgleich')
})
