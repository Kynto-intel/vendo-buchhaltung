// Browser-ctx für den eigenständigen Betrieb: dieselbe ansicht.js wie in Vendo, nur mit einem anderen ctx.
// aufrufen → POST /api/<name> mit Sitzungs-Token; bestaetigen/hinweis → einfache Dialoge; melden → Meldung unten rechts.

const inhalt = document.getElementById('inhalt')
const kopf = document.getElementById('kopf')
const meldungen = document.getElementById('meldungen')

const maskieren = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// Sitzungs-Token: kommt einmal über die Adresse (#t=…) aus dem Terminal, bleibt nur in diesem Tab
const ausAdresse = new URLSearchParams(location.hash.slice(1)).get('t')
if (ausAdresse) { sessionStorage.setItem('buchhaltung-sitzung', ausAdresse); history.replaceState(null, '', location.pathname) }
const token = sessionStorage.getItem('buchhaltung-sitzung')

async function rufen(name, argumente = [], { roh = false } = {}) {
  const antwort = await fetch(`/api/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sitzung': token || '' },
    body: JSON.stringify(roh ? argumente : { argumente })
  })
  let j = null
  try { j = await antwort.json() } catch { /* unten */ }
  if (antwort.status === 423) { sperrbildschirm(); throw new Error('Gesperrt.') }
  if (!j) throw new Error(`Server antwortet mit ${antwort.status}.`)
  for (const d of j.downloads || []) herunterladen(d)
  if (!j.ok) throw new Error(j.fehler || 'Unbekannter Fehler.')
  return j.wert
}

function herunterladen({ url, name }) {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  melden({ titel: 'Download', text: `${name} wird heruntergeladen.` })
}

function melden({ titel = '', text = '' } = {}) {
  const el = document.createElement('div')
  el.className = 'meldung'
  el.innerHTML = `${titel ? `<strong>${maskieren(titel)}</strong>` : ''}<span>${maskieren(text)}</span>`
  meldungen.appendChild(el)
  setTimeout(() => el.remove(), 8000)
}

function dialog(text, { titel = '', ja = 'OK', nein = 'Abbrechen', gefahr = false, nurOk = false } = {}) {
  return new Promise((fertig) => {
    const d = document.createElement('dialog')
    d.className = 'dialog'
    d.innerHTML = `${titel ? `<h3>${maskieren(titel)}</h3>` : ''}<p>${maskieren(text).replace(/\n/g, '<br>')}</p>
      <div class="dialog-knoepfe">${nurOk ? '' : `<button type="button" class="knopf-mini" data-nein>${maskieren(nein)}</button>`}
      <button type="button" class="${gefahr ? 'knopf-gefahr' : 'knopf-gold'}" data-ja>${maskieren(ja)}</button></div>`
    document.body.appendChild(d)
    const ende = (wert) => { d.close(); d.remove(); fertig(wert) }
    d.querySelector('[data-ja]').addEventListener('click', () => ende(true))
    d.querySelector('[data-nein]')?.addEventListener('click', () => ende(false))
    d.addEventListener('cancel', (e) => { e.preventDefault(); ende(false) })
    d.showModal()
    d.querySelector('[data-ja]').focus()
  })
}

const ctx = {
  id: 'buchhaltung',
  element: inhalt,
  kopfKnoepfe: kopf,
  maskieren,
  aufrufen: (name, ...argumente) => rufen(name, argumente),
  bestaetigen: (text, optionen = {}) => dialog(text, optionen),
  hinweis: (text, { titel = '' } = {}) => dialog(text, { titel, nurOk: true }),
  melden,
  vorlesen: () => {},
  oeffnen: () => {}
}

function sperrbildschirm(neu = false, meldung = '') {
  kopf.innerHTML = ''
  inhalt.innerHTML = `<form class="sperre" data-sperre>
    <h3>${neu ? 'Passwort festlegen' : 'Entsperren'}</h3>
    <p class="leise">${neu
      ? 'Mit diesem Passwort werden persönliche Angaben, Zugänge und der Wiederherstellungsschlüssel verschlüsselt (scrypt + AES-GCM). Es lässt sich nicht zurücksetzen – bitte gut aufbewahren.'
      : 'Passwort für den Tresor dieser Buchhaltung.'}</p>
    <input type="password" name="passwort" autocomplete="${neu ? 'new-password' : 'current-password'}" placeholder="Passwort (mindestens 8 Zeichen)" required minlength="8" />
    ${neu ? '<input type="password" name="wiederholung" autocomplete="new-password" placeholder="Passwort wiederholen" required minlength="8" />' : ''}
    <button class="knopf-gold" type="submit">${neu ? 'Festlegen' : 'Entsperren'}</button>
    <p class="sperre-fehler" role="alert">${maskieren(meldung)}</p>
  </form>`
  const form = inhalt.querySelector('[data-sperre]')
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const daten = Object.fromEntries(new FormData(form))
    if (neu && daten.passwort !== daten.wiederholung) return sperrbildschirm(neu, 'Die beiden Eingaben stimmen nicht überein.')
    form.querySelector('button').disabled = true
    try {
      await rufen('_entsperren', { passwort: daten.passwort }, { roh: true })
      starten()
    } catch (f) { sperrbildschirm(neu, f.message) }
  })
  form.querySelector('input').focus()
}

async function starten() {
  if (!token) {
    inhalt.innerHTML = '<div class="leer-hinweis">Bitte die Adresse aus dem Terminal öffnen (sie enthält das Sitzungs-Token).</div>'
    return
  }
  let zustand
  try { zustand = await rufen('_zustand', {}, { roh: true }) } catch (f) {
    inhalt.innerHTML = `<div class="leer-hinweis fehler">${maskieren(f.message)}</div>`
    return
  }
  if (zustand.gesperrt) return sperrbildschirm(zustand.neu)
  inhalt.innerHTML = ''
  try {
    const modul = await import('/plugin/ansicht.js')
    const r = (await modul.starten(ctx)) || {}
    if (typeof r.laden === 'function') {
      setInterval(() => { if (!document.hidden) Promise.resolve(r.laden()).catch(() => {}) }, Math.max(15_000, Number(r.takt) || 60_000))
    }
  } catch (f) {
    inhalt.innerHTML = `<div class="leer-hinweis fehler">Die Buchhaltung konnte nicht starten: ${maskieren(f.message)}</div>`
  }
}

starten()
