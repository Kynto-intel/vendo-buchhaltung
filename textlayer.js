'use strict'
// Liest den Text einer PDF-Seite und markiert durchgestrichenen Text als ~~Text~~.
// Durchstreichungen sind in PDFs keine Texteigenschaft, sondern hauchdünne gefüllte Rechtecke,
// die über dem Text liegen. Wir suchen solche Rechtecke und ordnen sie den Textteilen zu.
// Funktioniert mit pdfjs-dist 4.x (constructPath mit Unter-Operatoren) und 5.x (Pfaddaten).

const mul = (c, m) => [
  c[0] * m[0] + c[2] * m[1], c[1] * m[0] + c[3] * m[1],
  c[0] * m[2] + c[2] * m[3], c[1] * m[2] + c[3] * m[3],
  c[0] * m[4] + c[2] * m[5] + c[4], c[1] * m[4] + c[3] * m[5] + c[5]
]
const punkt = (c, x, y) => [c[0] * x + c[2] * y + c[4], c[1] * x + c[3] * y + c[5]]
const boxVon = (c, pts) => {
  const p = pts.map(([x, y]) => punkt(c, x, y))
  const xs = p.map((q) => q[0])
  const ys = p.map((q) => q[1])
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
}

// pdfjs 4.x: args = [unterOps[], koordinaten[], minMax], Malbefehl folgt als nächster Operator
function pfadeV4(unter, koord, OPS) {
  const pfade = []
  let aktuell = null
  let k = 0
  for (const op of unter) {
    if (op === OPS.rectangle) {
      const [x, y, w, h] = [koord[k], koord[k + 1], koord[k + 2], koord[k + 3]]
      pfade.push([[x, y], [x + w, y], [x + w, y + h], [x, y + h]])
      k += 4
    } else if (op === OPS.moveTo) {
      aktuell = [[koord[k], koord[k + 1]]]; pfade.push(aktuell); k += 2
    } else if (op === OPS.lineTo) {
      (aktuell ||= (pfade[pfade.length] = [])).push([koord[k], koord[k + 1]]); k += 2
    } else if (op === OPS.curveTo) k += 6
    else if (op === OPS.curveTo2 || op === OPS.curveTo3) k += 4
  }
  return pfade
}

// pdfjs 5.x: args = [malbefehl, [Float32Array(pfaddaten)], minMax]; 0=moveTo 1=lineTo 2=curveTo 3=quadTo 4=close
function pfadeV5(daten) {
  const pfade = []
  let aktuell = null
  for (let i = 0; i < daten.length;) {
    const op = daten[i++]
    if (op === 0) { aktuell = [[daten[i], daten[i + 1]]]; pfade.push(aktuell); i += 2 } else if (op === 1) { aktuell?.push([daten[i], daten[i + 1]]); i += 2 } else if (op === 2) i += 6
    else if (op === 3) i += 4
  }
  return pfade
}

async function striche(seite, OPS) {
  const ops = await seite.getOperatorList()
  const malen = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke])
  const linien = []
  let ctm = [1, 0, 0, 1, 0, 0]
  const stapel = []
  for (let i = 0; i < ops.fnArray.length; i++) {
    const f = ops.fnArray[i]
    const a = ops.argsArray[i]
    if (f === OPS.save) stapel.push(ctm)
    else if (f === OPS.restore) ctm = stapel.pop() || ctm
    else if (f === OPS.transform) ctm = mul(ctm, a)
    else if (f === OPS.constructPath) {
      let malbefehl
      let pfade
      if (Array.isArray(a[0])) { malbefehl = ops.fnArray[i + 1]; pfade = pfadeV4(a[0], a[1], OPS) } else { malbefehl = a[0]; pfade = pfadeV5(a[1]?.[0] || []) }
      if (!malen.has(malbefehl)) continue
      for (const p of pfade) {
        if (p.length < 2) continue
        const b = boxVon(ctm, p)
        if (b.y1 - b.y0 <= 2.5 && b.x1 - b.x0 >= 2) linien.push({ ...b, y: (b.y0 + b.y1) / 2 })
      }
    }
  }
  return linien
}

// true, wenn eine Linie mittig durch den Textteil läuft (nicht Unterstreichung, nicht Tabellenrand)
function durchgestrichen(teil, linien) {
  const breite = teil.width || 0
  if (!teil.str?.trim() || breite <= 0) return false
  const t = teil.transform
  const hoehe = teil.height || Math.hypot(t[2], t[3]) || 8
  const von = t[4]
  const bis = t[4] + breite
  return linien.some((l) => {
    if (l.y < t[5] + 0.15 * hoehe || l.y > t[5] + 0.7 * hoehe) return false
    const ueberlappung = Math.min(bis, l.x1) - Math.max(von, l.x0)
    return ueberlappung >= 0.5 * breite
  })
}

// Gibt den Seitentext zurück (Zeilenumbrüche wie bisher); durchgestrichene Teile als ~~...~~
async function seitenText(seite, OPS) {
  const inhalt = await seite.getTextContent()
  let linien = []
  try { linien = await striche(seite, OPS) } catch { /* ohne Markierung weiter */ }
  return inhalt.items.map((teil) => {
    const s = teil.str || ''
    const markiert = linien.length && durchgestrichen(teil, linien) ? s.replace(/^(\s*)(.*?)(\s*)$/s, '$1~~$2~~$3') : s
    return `${markiert}${teil.hasEOL ? '\n' : ' '}`
  }).join('').trim()
}

module.exports = { seitenText, striche, durchgestrichen }
