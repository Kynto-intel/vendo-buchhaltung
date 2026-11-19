'use strict'
// Eigene Angaben zur Laufzeit (Schritt 2.3, Plan 7.2): ersetzt die früher fest im Code stehenden FIRMA (beleg-layout.js),
// EIGENE_NAMEN, EIGENER_SHOP und KLEINUNTERNEHMER (parser.js). haupt.js setzt die gespeicherten „Meine Angaben“ beim Start
// und nach jedem Speichern; Parser, Shopify, Shirtigo und Beleg lesen nur noch hier.
// Ohne gespeicherten Steuerstatus gilt wie bisher Kleinunternehmer (unbekannt: true).

const angaben = require('./angaben')

let werte = angaben.standardwerte()
let stempel = ''

function setzen(neu) {
  werte = { ...angaben.standardwerte(), ...(neu && typeof neu === 'object' ? neu : {}) }
  // Kennung des Stands: Ändert sie sich, werden gespeicherte Auswertungen eingelesener PDFs neu berechnet
  stempel = JSON.stringify([werte.firmenname, werte.eigeneNamen, werte.steuerzeitraeume])
}
const stand = () => stempel
const pruefung = () => angaben.pruefen(werte)
const vollstaendig = () => pruefung().vollstaendig

// Steuerstatus an einem Tag (JJJJ-MM-TT): { art: 'klein' | 'regel', satz, unbekannt }
function steuerAm(tag) {
  const z = angaben.steuerstatusAm(werte.steuerzeitraeume, tag)
  return z ? { art: z.art, satz: z.art === 'regel' ? z.satz : 0, unbekannt: false } : { art: 'klein', satz: 0, unbekannt: true }
}
const kleinunternehmerAm = (tag) => steuerAm(tag).art === 'klein'
// Vorsteuer: Entscheidung Nutzer 29.10.2026 – wird nie beim Finanzamt geltend gemacht, auch nicht in der Regelbesteuerung
// Die MwSt auf Einkäufe ist darum immer echter Aufwand, Ausgaben zählen immer brutto.
const vorsteuerAbziehbarAm = () => false

// Eigene Namen: Groß-/Kleinschreibung egal, Teilwort genügt (wie die früheren Muster /name/i)
const eigeneNamen = () => [...(werte.eigeneNamen || [])]
const istEigen = (text) => { const t = String(text || '').toLowerCase(); return !!t && eigeneNamen().some((n) => t.includes(n.toLowerCase())) }
const eigenerShop = () => werte.firmenname || 'Eigener Shop'

// Zeilen höchstens ~breite Zeichen lang, an Teilgrenzen umbrechen (Fußtext im Beleg steht zentriert ohne Zeilenumbruch)
function umbrechen(teile, breite = 95) {
  const zeilen = []
  for (const teil of teile.filter(Boolean)) {
    for (const wort of teil.split(' ')) {
      const letzte = zeilen.at(-1)
      if (letzte != null && (letzte + ' ' + wort).length <= breite) zeilen[zeilen.length - 1] = letzte + ' ' + wort
      else zeilen.push(wort)
    }
  }
  return zeilen
}

// Firmenangaben für einen Beleg mit Belegdatum tag: Kopf (Name + Zeilen) und Schluss (Hinweis + Bank + Steuerkennung).
// Der § 19-Hinweis steht nur, wenn an diesem Tag Kleinunternehmer gilt.
// klein: Steuerstatus des Belegs selbst (sonst nach Tag), damit § 19-Hinweis und Steuersatz sich nie widersprechen
function firma(tag, klein = kleinunternehmerAm(tag)) {
  const w = werte
  const land = w.land && w.land !== 'DE' ? w.land : ''
  const zeilen = [w.strasse, [w.plz, w.ort].filter(Boolean).join(' '), land, w.email, w.website, w.telefon].filter(Boolean)
  const empfaenger = w.kontoinhaber || w.inhaber
  const bank = [
    w.iban ? `${empfaenger ? `Empfänger: ${empfaenger}, ` : ''}IBAN: ${angaben.ibanAnzeige(w.iban)}${w.bic ? `, BIC: ${w.bic}` : ''}${w.bank ? `, Bank: ${w.bank}` : ''}${w.ustId || w.wId || w.steuernummer ? ',' : ''}` : '',
    w.ustId ? `USt-IdNr.: ${w.ustId}` : w.wId ? `W-IdNr.: ${w.wId}` : w.steuernummer ? `Steuernummer: ${w.steuernummer}` : ''
  ]
  const hinweis = klein ? w.hinweis19 : ''
  return { name: w.firmenname, inhaber: w.inhaber, zeilen, schluss: umbrechen([hinweis, ...bank]), dankestext: w.dankestext || '' }
}

module.exports = { setzen, stand, pruefung, vollstaendig, steuerAm, kleinunternehmerAm, vorsteuerAbziehbarAm, eigeneNamen, istEigen, eigenerShop, firma }
