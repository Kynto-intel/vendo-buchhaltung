'use strict'
// Offline-Geocoding für die Bestellorte auf dem Globus. Es verlässt keine Adresse den Rechner.
// Reihenfolge: 1. Postleitzahl (plz.json, erzeugt mit tools/plz-bauen.js)  2. Ortsname (kleine Tabelle unten)  3. Land (Mittelpunkt)
// Ohne plz.json funktioniert alles weiter, nur ungenauer (Ortsname bzw. Landesmitte).

let PLZ = {}
try { PLZ = require('./plz.json') } catch { /* optional */ }

const norm = (s) => String(s || '').toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/\p{M}/gu, '').replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim()

// [Name, Breite, Länge]
const STAEDTE = [
  ['Berlin', 52.52, 13.40], ['Hamburg', 53.55, 9.99], ['München', 48.14, 11.58], ['Köln', 50.94, 6.96], ['Frankfurt am Main', 50.11, 8.68], ['Frankfurt', 50.11, 8.68],
  ['Stuttgart', 48.78, 9.18], ['Düsseldorf', 51.23, 6.78], ['Leipzig', 51.34, 12.37], ['Dortmund', 51.51, 7.47], ['Essen', 51.46, 7.01], ['Bremen', 53.08, 8.80],
  ['Dresden', 51.05, 13.74], ['Hannover', 52.37, 9.74], ['Nürnberg', 49.45, 11.08], ['Duisburg', 51.43, 6.76], ['Bochum', 51.48, 7.22], ['Wuppertal', 51.26, 7.15],
  ['Bielefeld', 52.02, 8.53], ['Bonn', 50.74, 7.10], ['Münster', 51.96, 7.63], ['Karlsruhe', 49.01, 8.40], ['Mannheim', 49.49, 8.47], ['Augsburg', 48.37, 10.90],
  ['Wiesbaden', 50.08, 8.24], ['Gelsenkirchen', 51.52, 7.09], ['Mönchengladbach', 51.19, 6.44], ['Braunschweig', 52.27, 10.52], ['Kiel', 54.32, 10.14],
  ['Chemnitz', 50.83, 12.92], ['Aachen', 50.78, 6.08], ['Halle', 51.48, 11.97], ['Magdeburg', 52.12, 11.63], ['Freiburg im Breisgau', 47.999, 7.85], ['Freiburg', 47.999, 7.85],
  ['Krefeld', 51.34, 6.59], ['Lübeck', 53.87, 10.69], ['Mainz', 50.00, 8.27], ['Erfurt', 50.98, 11.03], ['Rostock', 54.09, 12.10], ['Kassel', 51.31, 9.48],
  ['Hagen', 51.36, 7.47], ['Saarbrücken', 49.24, 6.99], ['Potsdam', 52.39, 13.07], ['Ludwigshafen', 49.48, 8.44], ['Oldenburg', 53.14, 8.21], ['Osnabrück', 52.28, 8.04],
  ['Heidelberg', 49.40, 8.69], ['Regensburg', 49.01, 12.10], ['Ingolstadt', 48.76, 11.42], ['Würzburg', 49.79, 9.95], ['Wolfsburg', 52.42, 10.79], ['Ulm', 48.40, 9.99],
  ['Heilbronn', 49.14, 9.22], ['Pforzheim', 48.89, 8.69], ['Göttingen', 51.53, 9.93], ['Trier', 49.76, 6.64], ['Jena', 50.93, 11.59], ['Koblenz', 50.36, 7.59],
  ['Konstanz', 47.66, 9.18], ['Rosenheim', 47.86, 12.12], ['Passau', 48.57, 13.46], ['Bayreuth', 49.95, 11.58], ['Bamberg', 49.89, 10.89], ['Schongau', 47.81, 10.90],
  ['Kempten', 47.73, 10.32], ['Garmisch-Partenkirchen', 47.49, 11.10], ['Landshut', 48.54, 12.15], ['Flensburg', 54.78, 9.44], ['Schwerin', 53.63, 11.40],
  ['Gießen', 50.58, 8.68], ['Fulda', 50.55, 9.68], ['Darmstadt', 49.87, 8.65],
  // Österreich / Schweiz
  ['Wien', 48.21, 16.37], ['Graz', 47.07, 15.44], ['Linz', 48.31, 14.29], ['Salzburg', 47.81, 13.05], ['Innsbruck', 47.26, 11.39], ['Klagenfurt', 46.62, 14.31],
  ['Villach', 46.61, 13.85], ['Bregenz', 47.50, 9.75], ['Zürich', 47.38, 8.54], ['Genf', 46.20, 6.14], ['Basel', 47.56, 7.59], ['Bern', 46.95, 7.45],
  ['Lausanne', 46.52, 6.63], ['Luzern', 47.05, 8.31], ['St. Gallen', 47.42, 9.37]
]
const ORTE = new Map(STAEDTE.map(([n, la, lo]) => [norm(n), [la, lo]]))

// Mittelpunkte (ISO-Ländercode)
const LAND = {
  DE: [51.2, 10.4], AT: [47.6, 14.1], CH: [46.8, 8.2], NL: [52.2, 5.3], BE: [50.6, 4.7], LU: [49.8, 6.1], FR: [46.6, 2.4], IT: [42.8, 12.5], ES: [40.2, -3.7],
  PT: [39.6, -8], PL: [52, 19.4], CZ: [49.8, 15.5], SK: [48.7, 19.5], HU: [47.2, 19.5], DK: [56, 10], SE: [62, 15], NO: [61, 9], FI: [64, 26], IE: [53.2, -8],
  GB: [54, -2.5], GR: [39, 22], RO: [45.9, 25], BG: [42.7, 25.5], HR: [45.1, 15.2], SI: [46.1, 14.8], LT: [55.3, 23.9], LV: [56.9, 24.6], EE: [58.6, 25],
  IS: [65, -18], MT: [35.9, 14.4], CY: [35, 33], TR: [39, 35], UA: [49, 32], US: [39.5, -98.5], CA: [56, -106], MX: [23.6, -102.5], BR: [-10, -52],
  AR: [-34, -64], CL: [-33, -71], AU: [-25, 134], NZ: [-41, 174], JP: [36, 138], KR: [36.5, 127.8], CN: [35, 103], IN: [21, 78], TH: [15, 101], SG: [1.35, 103.8],
  AE: [24, 54], IL: [31.5, 35], ZA: [-29, 24], EG: [26.5, 30]
}

// Postleitzahl so kürzen, wie sie in der Tabelle steht (NL: 4 Ziffern, GB: Teil vor den letzten 3 Zeichen, CA: 3 Zeichen)
function plzSchluessel(land, plz) {
  const p = String(plz || '').toUpperCase().replace(/\s+/g, '')
  if (land === 'NL') return p.slice(0, 4)
  if (land === 'GB') return p.length > 3 ? p.slice(0, -3) : p
  if (land === 'CA') return p.slice(0, 3)
  return p
}

function ortSuchen(ort) {
  const n = norm(ort)
  if (!n) return null
  return ORTE.get(n) || ORTE.get(n.split(/[\s,\-/]/)[0]) || null // "Köln-Ehrenfeld" -> "köln"
}

// -> { lat, lon, genau: 'plz' | 'ort' | 'land' } oder null
function finde(land, plz, ort) {
  land = String(land || '').toUpperCase()
  const p = land && PLZ[land]?.[plzSchluessel(land, plz)]
  if (Array.isArray(p)) return { lat: p[0], lon: p[1], genau: 'plz' }
  const o = (!land || land === 'DE' || land === 'AT' || land === 'CH') ? ortSuchen(ort) : null
  if (o) return { lat: o[0], lon: o[1], genau: 'ort' }
  const l = LAND[land]
  return l ? { lat: l[0], lon: l[1], genau: 'land' } : null
}

module.exports = { finde, norm, plzSchluessel }