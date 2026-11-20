// „Meine Angaben“: Bereiche links, Inhalt rechts (Plan 11.3). Firmendaten baut ansicht.js in das zurückgegebene Feld;
// Persönliche Angaben, ELSTER-Übersicht, Bereiche im Menü und Export laden ihre Daten beim ersten Öffnen selbst.
const BEREICHE = [
  { id: 'firmendaten', titel: 'Firmendaten' },
  { id: 'persoenlich', titel: 'Persönliche Angaben' },
  { id: 'elster', titel: 'ELSTER-Übersicht' },
  { id: 'verfahren', titel: 'Verfahrensdokumentation' },
  { id: 'datenschutz', titel: 'Datenschutz' },
  { id: 'menue', titel: 'Bereiche im Menü' },
  { id: 'export', titel: 'Export' }
]
const TABS = [['uebersicht', 'Übersicht'], ['bestellungen', 'Bestellungen'], ['rechnungen', 'Rechnungen'], ['angaben', 'Meine Angaben'], ['steuer', 'Steuer']]

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (z) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[z])
const euro = (n) => Number(n).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const datum = (iso) => (iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–')
const kopieren = (wert) => `<button class="knopf-mini" type="button" data-kopieren="${esc(wert)}" ${wert === '' || wert == null ? 'disabled' : ''}>Kopieren</button>`

function feldHtml(f, wert) {
  const id = `rn-pers-${f.feld}`
  if (f.typ === 'auswahl') return `<label class="rn-ang-feld" for="${id}"><span>${esc(f.label)}</span><select id="${id}" name="${f.feld}">${f.optionen.map((o) => `<option value="${esc(o)}" ${o === wert ? 'selected' : ''}>${esc(o || 'Bitte wählen')}</option>`).join('')}</select></label>`
  const liste = f.vorschlaege ? ` list="${id}-liste"` : ''
  const vorschlaege = f.vorschlaege ? `<datalist id="${id}-liste">${f.vorschlaege.map((v) => `<option value="${esc(v)}"></option>`).join('')}</datalist>` : ''
  return `<label class="rn-ang-feld" for="${id}"><span>${esc(f.label)}</span><input id="${id}" name="${f.feld}" type="${f.typ === 'datum' ? 'date' : 'text'}" value="${esc(wert)}" autocomplete="off"${liste} />${vorschlaege}</label>`
}

export function angabenBereicheErstellen(container, { aufrufen = null, menueAnwenden = () => {}, umgebung = {} } = {}) {
  container.innerHTML = `<div class="rn-angaben-layout">
    <div class="rn-angaben-tabs" role="tablist" aria-label="Angabenbereiche">
      ${BEREICHE.map(({ id, titel }, i) => `<button id="rn-ang-tab-${id}" type="button" role="tab" data-angaben-tab="${id}" aria-controls="rn-ang-panel-${id}" aria-selected="${i === 0}" tabindex="${i === 0 ? '0' : '-1'}">${titel}</button>`).join('')}
    </div>
    ${BEREICHE.map(({ id }, i) => `<section id="rn-ang-panel-${id}" class="rn-angaben-panel" role="tabpanel" aria-labelledby="rn-ang-tab-${id}" data-angaben-inhalt="${id}" ${i ? 'hidden' : ''}>${id === 'firmendaten' ? '<div data-angaben-formular></div>' : '<p class="leise">Lädt …</p>'}</section>`).join('')}
  </div>`
  const panel = (id) => container.querySelector(`[data-angaben-inhalt="${id}"]`)
  const fehlerZeigen = (id, f) => { panel(id).innerHTML = `<p class="rn-ang-fehler">Konnte nicht geladen werden: ${esc(f?.message || f)}</p>` }

  // ---------- Persönliche Angaben (M.2): verschlüsselt gespeichert ----------
  async function persoenlichZeichnen() {
    const p = await aufrufen('persoenlichLaden')
    const gruppen = [...new Set(p.felder.map((f) => f.gruppe))]
    // P-2: nach einer Neuinstallation die Angaben aus der USB-Sicherung zurückholen (nur solange nichts gespeichert ist)
    const sticks = p.gespeichert ? [] : await aufrufen('usbLaufwerke').catch(() => [])
    const rueckholen = sticks.length ? `<div class="rn-ang-aktion"><select data-pers-stick aria-label="USB-Stick">${sticks.map((l) => `<option value="${esc(l.laufwerk)}">${esc(`${l.laufwerk} ${l.name || ''}`)}</option>`).join('')}</select><button class="knopf-mini" type="button" data-pers-vom-stick>Vom USB-Stick zurückholen</button></div>` : ''
    panel('persoenlich').innerHTML = `<form class="rn-ang-vorschau" data-pers-form>
      <div class="rn-usb-kopf"><strong>Persönliche Angaben</strong></div>
      <p class="leise">Für die Einkommensteuererklärung in Mein ELSTER (Hauptvordruck). Wird nur verschlüsselt gespeichert (${umgebung.art === 'eigenstaendig' ? 'Passwort-Tresor' : 'Windows'}), nie protokolliert und nicht ins Jahresarchiv exportiert.</p>
      ${gruppen.map((g) => `<fieldset class="rn-ang-gruppe"><legend>${esc(g)}</legend><div class="rn-ang-raster">${p.felder.filter((f) => f.gruppe === g).map((f) => feldHtml(f, p.werte[f.feld])).join('')}</div></fieldset>`).join('')}
      <div class="rn-ang-aktion"><button class="knopf-mini" type="submit">Speichern</button><span class="leise" data-pers-meldung>${p.gespeichert ? 'Gespeichert. Jede USB-Sicherung nimmt sie verschlüsselt mit.' : 'Noch nichts gespeichert.'}</span></div>
      ${rueckholen}
    </form>`
  }
  container.addEventListener('click', async (e) => {
    const k = e.target.closest?.('[data-pers-vom-stick]')
    if (!k) return
    const meldung = container.querySelector('[data-pers-meldung]')
    k.disabled = true
    try {
      const r = await aufrufen('persoenlichVomStick', container.querySelector('[data-pers-stick]').value)
      if (!r.ok) { meldung.textContent = r.meldung; return }
      await persoenlichZeichnen()
      container.querySelector('[data-pers-meldung]').textContent = `Vom Stick zurückgeholt (${r.felder} Felder, Sicherung vom ${new Date(r.erstellt).toLocaleString('de-DE')}). Bitte prüfen.`
      elsterGeladen = false
    } catch (f) { meldung.textContent = `Nicht zurückgeholt: ${f.message}` } finally { k.disabled = false }
  })
  container.addEventListener('submit', async (e) => {
    const form = e.target.closest?.('[data-pers-form]')
    if (!form) return
    e.preventDefault()
    const meldung = form.querySelector('[data-pers-meldung]')
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'))
    try {
      const erg = await aufrufen('persoenlichSpeichern', Object.fromEntries(new FormData(form)))
      if (erg.ok) { meldung.textContent = `Gespeichert (verschlüsselt), ${new Date().toLocaleTimeString('de-DE')}.`; elsterGeladen = false; return }
      for (const f of erg.pruefung.fehler) form.querySelector(`[name="${f.feld}"]`)?.setAttribute('aria-invalid', 'true')
      meldung.textContent = `Nicht gespeichert: ${erg.pruefung.fehler.map((f) => f.text).join(' ')}`
    } catch (f) { meldung.textContent = `Nicht gespeichert: ${f.message}` }
  })

  // ---------- ELSTER-Übersicht (M.5) ----------
  let elsterGeladen = false
  async function elsterZeichnen(jahr) {
    const u = await aufrufen('elsterUebersicht', jahr ? { jahr } : {})
    const zeile = (label, wert, extra = '') => `<tr><th scope="row">${esc(label)}</th><td>${extra}${esc(wert || '–')}</td><td>${kopieren(wert)}</td></tr>`
    panel('elster').innerHTML = `<div class="rn-ang-vorschau">
      <div class="rn-usb-kopf"><strong>ELSTER-Übersicht</strong>
        <label class="rn-ang-feld rn-ang-jahr"><span>Jahr</span><select data-elster-jahr>${u.jahre.map((j) => `<option ${j === u.jahr ? 'selected' : ''}>${esc(j)}</option>`).join('')}</select></label></div>
      <p class="leise">${esc(u.hinweis)}</p>
      <h3 class="rn-ang-unter">Hauptvordruck (ESt 1 A)</h3>
      <table class="rn-ang-tabelle"><tbody>${u.hauptvordruck.map((z) => zeile(z.label, z.wert)).join('')}</tbody></table>
      <h3 class="rn-ang-unter">${esc(u.gewinn.anlage)}</h3>
      <table class="rn-ang-tabelle"><tbody>${zeile(u.gewinn.label, u.gewinn.wert == null ? '' : euro(u.gewinn.wert))}${zeile('Steuernummer', u.firma.steuernummer)}${zeile('Finanzamt', u.firma.finanzamt)}</tbody></table>
      <h3 class="rn-ang-unter">Anlage EÜR ${esc(u.jahr || '')}</h3>
      ${u.euer.length ? `<table class="rn-ang-tabelle"><tbody>${u.euer.map((z) => zeile(`${z.kz} ${z.label}`, euro(z.wert))).join('')}</tbody></table>` : '<p class="leise">Für dieses Jahr gibt es keine Beträge.</p>'}
      ${u.umsatzsteuer ? `<h3 class="rn-ang-unter">Umsatzsteuererklärung ${esc(u.jahr || '')} (USt 2 A)</h3><p class="leise">Pflicht, weil im Jahr § 13b-Steuer oder Regelbesteuerung anfiel (§ 18 Abs. 3 und 4a UStG). Bereits gezahlte Vorauszahlungen werden angerechnet.</p>${u.umsatzsteuer.length ? `<table class="rn-ang-tabelle"><tbody>${u.umsatzsteuer.map((z) => zeile(z.label, euro(z.wert))).join('')}</tbody></table>` : ''}` : ''}
    </div>`
    elsterGeladen = true
  }
  container.addEventListener('change', (e) => { if (e.target.matches?.('[data-elster-jahr]')) elsterZeichnen(e.target.value).catch((f) => fehlerZeigen('elster', f)) })

  // ---------- Bereiche im Menü (M.1) ----------
  async function menueZeichnen() {
    const m = await aufrufen('menueLaden')
    panel('menue').innerHTML = `<div class="rn-ang-vorschau">
      <div class="rn-usb-kopf"><strong>Bereiche im Menü</strong></div>
      <p class="leise">Ausgeblendete Bereiche verschwinden aus der Navigation dieses Plugins; ihre Daten bleiben erhalten. „Übersicht“ und „Meine Angaben“ bleiben immer sichtbar.</p>
      <ul class="rn-ang-menue-liste">${TABS.map(([id, titel]) => `<li><label><input type="checkbox" data-menue-tab="${id}" ${m.aus.includes(id) ? '' : 'checked'} ${m.ausblendbar.includes(id) ? '' : 'disabled'} /><span>${titel}</span></label></li>`).join('')}</ul>
      <span class="leise" data-menue-meldung></span>
    </div>`
  }
  container.addEventListener('change', async (e) => {
    if (!e.target.matches?.('[data-menue-tab]')) return
    const aus = [...container.querySelectorAll('[data-menue-tab]:not(:checked):not(:disabled)')].map((el) => el.dataset.menueTab)
    try {
      const m = await aufrufen('menueSpeichern', aus)
      menueAnwenden(m.aus)
      container.querySelector('[data-menue-meldung]').textContent = 'Gespeichert.'
    } catch (f) { container.querySelector('[data-menue-meldung]').textContent = `Nicht gespeichert: ${f.message}` }
  })

  // ---------- Export (M.3, E.2): nur Karten mit echter Funktion ----------
  async function exportZeichnen() {
    const [status, pw, db, jahre] = await Promise.all([aufrufen('archivStatus'), aufrufen('pruefwert'), aufrufen('datenbankStatus'), aufrufen('jahresarchivJahre')])
    const p = status.pruefung
    const dbText = db.zustand.zustand === 'bereit' ? (db.index ? `verbunden, Index vom ${datum(db.index.zeit)}: ${db.index.anzahl.bestellungen} Bestellungen, ${db.index.anzahl.einkaeufe} Einkäufe, ${db.index.anzahl.belege} Belege` : 'verbunden, Index wird aufgebaut') : `nicht verbunden (${db.zustand.meldung})`
    const gp = db.pruefung
    const vorjahr = (jahre || []).find((j) => Number(j) < new Date().getFullYear()) // abgeschlossenes Jahr vorauswählen
    panel('export').innerHTML = `<div class="rn-ang-vorschau">
      <div class="rn-usb-kopf"><strong>Export</strong></div>
      <div class="rn-ang-export-raster">
        <section class="rn-ang-export-karte"><h3>Jahresarchiv</h3>
          <p class="leise">ZIP mit allen Belegen des Jahres (unverändert), Tabellen (CSV), EÜR-Kennzahlen, Hash-Kette, Prüfsummen, Verfahrensdokumentation und Jahresnachweis. Ohne persönliche Angaben.</p>
          <div class="rn-ang-aktion"><select data-jahresarchiv-jahr aria-label="Jahr">${(jahre || []).map((j) => `<option ${j === vorjahr ? 'selected' : ''}>${esc(j)}</option>`).join('')}</select>
          <button class="knopf-mini" type="button" data-export-aktion="jahresarchiv" ${(jahre || []).length ? '' : 'disabled'}>Exportieren …</button></div>
          <span class="leise" data-export-meldung="jahresarchiv"></span></section>
        <section class="rn-ang-export-karte"><h3>Archiv und Sicherung</h3>
          <p class="leise">${status.archiv.eintraege} Einträge im Belegarchiv. USB-Sicherung: ${status.usb.letzteSicherung ? `${datum(status.usb.letzteSicherung)}` : 'noch keine'}.</p>
          <button class="knopf-mini" type="button" data-export-aktion="archivOeffnen">Archivordner öffnen</button></section>
        <section class="rn-ang-export-karte"><h3>Integrität</h3>
          <p class="leise">Letzte Prüfung: ${p?.zeit ? `${datum(p.zeit)}, ${p.ok ? 'ohne Befund' : 'mit Befund'}` : 'noch keine'}.</p>
          <p class="leise rn-ang-pruefwert">Prüfwert (Kopf der Hash-Kette, ${pw.eintraege} Einträge): <code>${esc(pw.wert || '–')}</code></p>
          <div class="rn-ang-aktion">${kopieren(pw.wert)}<button class="knopf-mini" type="button" data-export-aktion="pruefen">Jetzt prüfen</button></div>
          <label class="rn-ang-feld"><span>Alten Prüfwert vergleichen</span><input type="text" data-pruefwert-alt placeholder="64 Zeichen" autocomplete="off" /></label>
          <span class="leise" data-export-meldung="integritaet"></span></section>
        <section class="rn-ang-export-karte"><h3>Versionen und Datenbank</h3>
          <p class="leise">Datenbank: ${esc(dbText)}.</p>
          <p class="leise">Gegenprobe Datenbank = Archiv: ${gp ? (gp.ok ? `ohne Abweichung (${datum(gp.zeit)})` : `Abweichungen gefunden, Index neu aufgebaut (${datum(gp.zeit)})`) : 'noch keine (läuft mit der wöchentlichen Prüfung)'}.</p>
          <button class="knopf-mini" type="button" data-export-aktion="datenbankAufbauen" ${db.zustand.zustand === 'bereit' ? '' : 'disabled'}>Index neu aufbauen</button>
          <span class="leise" data-export-meldung="datenbank"></span></section>
      </div>
    </div>`
  }
  container.addEventListener('click', async (e) => {
    const k = e.target.closest?.('[data-kopieren]')
    if (k) { navigator.clipboard?.writeText(k.dataset.kopieren).then(() => { k.textContent = 'Kopiert'; setTimeout(() => { k.textContent = 'Kopieren' }, 1500) }).catch(() => {}); return }
    const a = e.target.closest?.('[data-export-aktion]')
    if (!a) return
    const aktion = a.dataset.exportAktion
    const meldung = (wo, text) => { const el = container.querySelector(`[data-export-meldung="${wo}"]`); if (el) el.textContent = text }
    a.disabled = true
    try {
      if (aktion === 'archivOeffnen') await aufrufen('archivOeffnen')
      if (aktion === 'jahresarchiv') {
        const jahr = container.querySelector('[data-jahresarchiv-jahr]').value
        meldung('jahresarchiv', 'Stellt zusammen …')
        const erg = await aufrufen('jahresarchivExport', { jahr })
        meldung('jahresarchiv', erg.abgebrochen ? 'Abgebrochen.' : `Gespeichert: ${erg.datei} (${erg.dateien} Dateien, ${(erg.bytes / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB)${erg.fehler.length ? `. Hinweise: ${erg.fehler.join(' ')}` : '.'}`)
      }
      if (aktion === 'pruefen') { meldung('integritaet', 'Prüft alle Belege …'); await aufrufen('wartungLauf', { erzwingen: true }); await exportZeichnen() }
      if (aktion === 'datenbankAufbauen') { meldung('datenbank', 'Baut auf …'); await aufrufen('datenbankAufbauen'); await exportZeichnen() }
    } catch (f) { meldung({ datenbankAufbauen: 'datenbank', jahresarchiv: 'jahresarchiv' }[aktion] || 'integritaet', `Fehler: ${f.message}`) } finally { a.disabled = false }
  })
  container.addEventListener('change', async (e) => {
    if (!e.target.matches?.('[data-pruefwert-alt]')) return
    const el = container.querySelector('[data-export-meldung="integritaet"]')
    const v = await aufrufen('pruefwertVergleichen', e.target.value)
    el.textContent = !v.gueltig ? 'Ein Prüfwert hat 64 Zeichen (0–9, a–f).'
      : v.bekannt ? `Gefunden: Stand vom ${datum(v.zeit)} (Eintrag ${v.nr}). Seitdem nur ergänzt: ${v.seitdemNeu} neue Einträge.`
        : 'Nicht in der Hash-Kette gefunden: Dieser Stand ist im Archiv nicht mehr enthalten. Bitte „Jetzt prüfen“.'
  })

  // ---------- Verfahrensdokumentation (7.2 / E.4) ----------
  const tagDe = (t) => (t ? `${t.slice(8, 10)}.${t.slice(5, 7)}.${t.slice(0, 4)}` : '–')
  const nachricht = (f) => String(f?.message || f).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') // ohne Electron-Vorspann
  async function verfahrenZeichnen(meldungText = '') {
    const v = await aufrufen('verfahrenLaden')
    const zustand = v.bestaetigtGueltig ? `Durchgesehen und bestätigt am ${datum(v.bestaetigung.zeit)}.` : v.bestaetigung ? 'Seit der letzten Bestätigung geändert: bitte erneut durchsehen und bestätigen.' : 'Noch nicht bestätigt.'
    panel('verfahren').innerHTML = `<form class="rn-ang-vorschau" data-verfahren-form>
      <div class="rn-usb-kopf"><strong>Verfahrensdokumentation</strong></div>
      <p class="leise">Beschreibt nach GoBD, wie Belege entstehen, archiviert, geprüft und gesichert werden. Vendo erzeugt sie aus dem tatsächlichen Aufbau (Archiv, Siegel, Sicherung, Datenbank, Versionen). Ergänze nur, was Vendo nicht wissen kann. Sie liegt jedem Jahresarchiv bei; jede bestätigte und jede exportierte Fassung wird im Archiv protokolliert.</p>
      <p class="leise" data-verfahren-zustand>${v.fehlend.length ? `${v.fehlend.length} Angabe(n) fehlen. ` : 'Alle Angaben ausgefüllt. '}${esc(zustand)}</p>
      <fieldset class="rn-ang-gruppe"><legend>Ergänzungen</legend><div class="rn-ang-raster">
        ${v.felder.map((f) => `<label class="rn-ang-feld ${f.typ === 'textarea' ? 'rn-ang-breit' : ''}"><span>${esc(f.label)}</span>${f.typ === 'textarea' ? `<textarea name="${f.feld}" rows="3">${esc(v.werte[f.feld])}</textarea>` : `<input name="${f.feld}" type="text" value="${esc(v.werte[f.feld])}" placeholder="${esc(f.hilfe || '')}" autocomplete="off" />`}</label>`).join('')}
      </div></fieldset>
      <div class="rn-ang-aktion"><button class="knopf-mini" type="submit">Speichern</button>
        <button class="knopf-mini" type="button" data-verfahren-aktion="bestaetigen">Durchgesehen – bestätigen</button>
        <button class="knopf-mini" type="button" data-verfahren-aktion="speichernUnter">Als Datei speichern …</button>
        <span class="leise" data-verfahren-meldung>${esc(meldungText)}</span></div>
      <pre class="rn-ang-text" data-verfahren-text>${esc(v.text)}</pre>
    </form>`
  }
  const verfahrenWerte = () => Object.fromEntries(new FormData(container.querySelector('[data-verfahren-form]')))
  container.addEventListener('submit', async (e) => {
    if (!e.target.matches?.('[data-verfahren-form]')) return
    e.preventDefault()
    try { const r = await aufrufen('verfahrenSpeichern', verfahrenWerte()); await verfahrenZeichnen(r.fehlend.length ? `Gespeichert. Noch offen: ${r.fehlend.join(', ')}.` : 'Gespeichert.') } catch (f) { container.querySelector('[data-verfahren-meldung]').textContent = `Nicht gespeichert: ${nachricht(f)}` }
  })
  container.addEventListener('click', async (e) => {
    const a = e.target.closest?.('[data-verfahren-aktion]')
    if (!a) return
    const meldung = (t) => { const el = container.querySelector('[data-verfahren-meldung]'); if (el) el.textContent = t }
    a.disabled = true
    try {
      if (a.dataset.verfahrenAktion === 'bestaetigen') {
        await aufrufen('verfahrenSpeichern', verfahrenWerte())
        const r = await aufrufen('verfahrenBestaetigen')
        await verfahrenZeichnen(`Bestätigt und im Archiv abgelegt${r.fehlend.length ? ` (noch offen: ${r.fehlend.length} Angabe(n))` : ''}.`)
      } else {
        const r = await aufrufen('verfahrenSpeichernUnter')
        meldung(r.abgebrochen ? 'Abgebrochen.' : `Gespeichert: ${r.datei}`)
      }
    } catch (f) { meldung(`Fehler: ${nachricht(f)}`) } finally { a.disabled = false }
  })

  // ---------- Datenschutz (7.3) ----------
  async function datenschutzZeichnen() {
    const d = await aufrufen('datenschutzLaden')
    const sperren = d.anfragen.filter((x) => x.art === 'loeschung')
    panel('datenschutz').innerHTML = `<div class="rn-ang-vorschau">
      <div class="rn-usb-kopf"><strong>Datenschutz</strong></div>
      <p class="leise">Rechnungs- und Kundendaten bleiben in der Buchhaltung: Sie gehen nie an Hermes oder KI-Anbieter.</p>
      <fieldset class="rn-ang-gruppe"><legend>Auskunft und Löschanfragen</legend>
        <p class="leise">Bestellungen einer Person suchen (E-Mail-Adresse genau oder Teil des Namens). Belege dürfen während der Aufbewahrungsfrist nicht gelöscht werden: Eine Löschanfrage wird als Sperre bis zum Fristende vermerkt. Das Kundenkonto in Shopify bitte dort selbst löschen.</p>
        <form class="rn-ang-aktion" data-ds-suche><input type="search" name="begriff" placeholder="E-Mail oder Name" aria-label="E-Mail oder Name" autocomplete="off" /><button class="knopf-mini" type="submit">Suchen</button></form>
        <div data-ds-treffer></div>
        <span class="leise" data-ds-meldung></span>
      </fieldset>
      <fieldset class="rn-ang-gruppe"><legend>Vermerkte Anfragen</legend>
        ${d.anfragen.length ? `<table class="rn-ang-tabelle rn-ang-liste"><thead><tr><th>Art</th><th>Eingang/Erledigt</th><th>Person</th><th>Bestellungen</th><th>Status</th></tr></thead><tbody>${d.anfragen.slice().reverse().map((x) => `<tr><td>${x.art === 'loeschung' ? 'Löschanfrage' : 'Auskunft'}</td><td>${x.art === 'loeschung' ? tagDe(x.eingang) : datum(x.zeit)}</td><td>${esc(x.name || '–')}</td><td>${esc(x.bestellungen.join(', '))}</td><td>${x.art === 'loeschung' ? `gesperrt bis ${tagDe(x.gesperrtBis)}` : 'exportiert'}</td></tr>`).join('')}</tbody></table>` : '<p class="leise">Noch keine.</p>'}
      </fieldset>
      <fieldset class="rn-ang-gruppe"><legend>Verzeichnis der Verarbeitungstätigkeiten (Art. 30, Entwurf)</legend>
        <div class="rn-ang-aktion"><button class="knopf-mini" type="button" data-ds-aktion="verzeichnis">Als Datei speichern …</button><span class="leise" data-ds-verz-meldung></span></div>
        <pre class="rn-ang-text">${esc(d.verzeichnis)}</pre>
      </fieldset>
    </div>`
    panel('datenschutz').dataset.sperren = JSON.stringify(Object.fromEntries(sperren.flatMap((x) => x.bestellungen.map((n) => [n, x.gesperrtBis]))))
  }
  const dsMeldung = (t) => { const el = container.querySelector('[data-ds-meldung]'); if (el) el.textContent = t }
  const dsAuswahl = () => [...container.querySelectorAll('[data-ds-nr]:checked')].map((x) => x.value)
  container.addEventListener('submit', (e) => {
    if (!e.target.matches?.('[data-ds-suche]')) return
    e.preventDefault()
    dsSuchen(e.target.begriff.value)
  })
  async function dsSuchen(begriff) {
    const ziel = container.querySelector('[data-ds-treffer]')
    try {
      const treffer = await aufrufen('datenschutzSuchen', begriff)
      const gesperrt = JSON.parse(panel('datenschutz').dataset.sperren || '{}')
      dsMeldung(treffer.length ? '' : 'Keine Bestellungen gefunden.')
      ziel.innerHTML = treffer.length ? `<table class="rn-ang-tabelle rn-ang-liste"><thead><tr><th></th><th>Bestellung</th><th>Datum</th><th>Name</th><th>E-Mail</th><th>Ort</th><th>Aufbewahrung bis</th></tr></thead><tbody>${treffer.map((t) => `<tr><td><input type="checkbox" data-ds-nr value="${esc(t.nr)}" checked aria-label="Bestellung ${esc(t.nr)}" /></td><td>${esc(t.nr)}</td><td>${tagDe(t.datum)}</td><td>${esc(t.name)}</td><td>${esc(t.email)}</td><td>${esc(t.ort)}</td><td>${gesperrt[t.nr] ? `gesperrt bis ${tagDe(gesperrt[t.nr])}` : tagDe(t.gesperrtBis)}</td></tr>`).join('')}</tbody></table>
        <div class="rn-ang-aktion"><button class="knopf-mini" type="button" data-ds-aktion="auskunft">Auskunft exportieren …</button>
        <label class="rn-ang-feld rn-ang-jahr"><span>Löschanfrage vom</span><input type="date" data-ds-eingang value="${new Date().toLocaleDateString('sv-SE')}" /></label>
        <button class="knopf-mini" type="button" data-ds-aktion="sperren">Löschanfrage vermerken (sperren)</button></div>` : ''
    } catch (f) { ziel.innerHTML = ''; dsMeldung(nachricht(f)) }
  }
  container.addEventListener('click', async (e) => {
    const a = e.target.closest?.('[data-ds-aktion]')
    if (!a) return
    a.disabled = true
    try {
      if (a.dataset.dsAktion === 'verzeichnis') {
        const r = await aufrufen('datenschutzVerzeichnisSpeichern')
        container.querySelector('[data-ds-verz-meldung]').textContent = r.abgebrochen ? 'Abgebrochen.' : `Gespeichert: ${r.datei}`
      } else if (a.dataset.dsAktion === 'auskunft') {
        dsMeldung('Stellt zusammen …')
        const r = await aufrufen('datenschutzAuskunft', { nrs: dsAuswahl() })
        dsMeldung(r.abgebrochen ? 'Abgebrochen.' : `Gespeichert: ${r.datei} (${r.dateien} Dateien)${r.fehler.length ? `. Hinweise: ${r.fehler.join(' ')}` : '.'}`)
        if (!r.abgebrochen) await datenschutzNeu()
      } else if (a.dataset.dsAktion === 'sperren') {
        const r = await aufrufen('datenschutzSperren', { nrs: dsAuswahl(), eingang: container.querySelector('[data-ds-eingang]').value })
        await datenschutzNeu()
        dsMeldung(`Vermerkt: gesperrt bis ${tagDe(r.gesperrtBis)}. Danach können die Daten gelöscht werden.`)
      }
    } catch (f) { dsMeldung(`Fehler: ${nachricht(f)}`) } finally { a.disabled = false }
  })
  // Neu zeichnen und die letzte Suche wiederholen, damit Treffer und Sperren aktuell bleiben
  async function datenschutzNeu() {
    const begriff = container.querySelector('[data-ds-suche] [name="begriff"]')?.value || ''
    await datenschutzZeichnen()
    if (begriff) { container.querySelector('[data-ds-suche] [name="begriff"]').value = begriff; await dsSuchen(begriff) }
  }

  // ---------- Tabs ----------
  const LADEN = { persoenlich: persoenlichZeichnen, elster: () => (elsterGeladen ? null : elsterZeichnen()), menue: menueZeichnen, export: exportZeichnen, verfahren: () => verfahrenZeichnen(), datenschutz: datenschutzZeichnen }
  const tabs = [...container.querySelectorAll('[data-angaben-tab]')]
  const panels = [...container.querySelectorAll('[data-angaben-inhalt]')]
  const aktivieren = (id) => {
    for (const tab of tabs) {
      const aktiv = tab.dataset.angabenTab === id
      tab.setAttribute('aria-selected', String(aktiv))
      tab.tabIndex = aktiv ? 0 : -1
    }
    for (const p of panels) p.hidden = p.dataset.angabenInhalt !== id
    if (aufrufen && LADEN[id]) Promise.resolve(LADEN[id]()).catch((f) => fehlerZeigen(id, f))
  }

  container.addEventListener('click', (event) => {
    const tab = event.target.closest?.('[data-angaben-tab]')
    if (tab && container.contains(tab)) aktivieren(tab.dataset.angabenTab)
  })

  container.addEventListener('keydown', (event) => {
    const tab = event.target.closest?.('[data-angaben-tab]')
    if (!tab || !container.contains(tab)) return
    const index = tabs.indexOf(tab)
    const naechster = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
        : event.key === 'Home' ? 0
          : event.key === 'End' ? tabs.length - 1
            : -1
    if (naechster < 0) return
    event.preventDefault()
    tabs[naechster].focus()
    aktivieren(tabs[naechster].dataset.angabenTab)
  })

  return { firmendaten: container.querySelector('[data-angaben-formular]') }
}
