const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { createCanvas } = require('@napi-rs/canvas')
const { createWorker } = require('tesseract.js')
const deutscheSprache = require('@tesseract.js-data/deu')
const { parseRechnung, auswerten, VERSION } = require('./parser')
const { seitenText } = require('./textlayer')
const bestellungen = require('./bestellungen') // Shopify-Bestellungen (API) + Beleg-PDF
const shirtigo = require('./shirtigo') // Shirtigo-Zugang (MCP)
const shirtigoB = require('./shirtigo-bestellungen') // Shirtigo-Bestellungen = Produktionskosten
const { archiv } = require('./archiv') // zentrales Belegarchiv (Plan 7.5)
const schutz = require('./schutz') // Windows-Schutz für die Archivdateien
const zeitstempel = require('./zeitstempel') // externer Anker: RFC-3161-Zeitstempel (Plan 7.5, Schritt 1.7)
const schluessel = require('./schluessel') // Wiederherstellungsschlüssel der USB-Sicherung (Schritt 1.8)
const usbSicherung = require('./usb') // verschlüsselte, inkrementelle Sicherung auf den USB-Stick (Schritt 1.9)
const angaben = require('./angaben') // „Meine Angaben“: eigene Angaben für Belege (Schritt 2.1)
const steuer = require('./steuer') // Steuer-Übersicht: Umsatz je Jahr nach Zahlungseingang (Schritt 4.2)
const uebersicht = require('./uebersicht') // Dashboard: EÜR je Jahr, Aufgaben & Fristen (Schritt 4.5)
const profil = require('./profil') // gespeicherte Angaben zur Laufzeit für Parser, Shopify, Shirtigo, Beleg (Schritt 2.3)
const persoenlich = require('./persoenlich') // persönliche Angaben (verschlüsselt) und ELSTER-Übersicht (Plan 11.3)
const jahresarchiv = require('./jahresarchiv') // Jahresarchiv als ZIP (Plan 11.4, E.1)
const dbIndex = require('./datenbank-index') // abgeleiteter Index in PostgreSQL (Plan 11.2, Phase D)
const verfahren = require('./verfahren') // Verfahrensdokumentation und Jahresnachweis (Schritt 7.2 / E.4)
const dsgvo = require('./dsgvo') // Verzeichnis, Auskunft, Sperre statt Löschen (Schritt 7.3)

const ID = /^r[a-f0-9]{20}$/
const MAX_SEITEN = 50
const MAX_TEXT = 1_000_000
let pdfjsLaden

const innerhalb = (kind, eltern) => { const rel = path.relative(eltern, kind); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) }
const archivBelegt = (ordner) => (fs.statSync(path.join(ordner, 'index.jsonl'), { throwIfNoEntry: false })?.size || 0) > 0

module.exports = (ctx) => {
  // Umfeld (host.js): in Vendo Electron im Hauptprozess wie bisher, eigenständig bringt standalone/server.js ctx.host mit
  // ctx.ordner: Plugin-Ordner, wie Vendo ihn sieht. Ist plugins/buchhaltung eine Verknüpfung, zeigt __dirname auf das Ziel
  // (dieses Repository) und Vendos daten/ wäre falsch abgeleitet.
  const host = ctx.host || require('./host').vendo(require, ctx.ordner || __dirname)
  const pfade = host.pfade()
  const ORDNER = pfade.daten // ausgelesene Texte, OCR-Cache (veränderlich, kein Beleg)
  const VENDO = pfade.programm // Programmordner: das Archiv darf nicht darin liegen
  const ARCHIV_STANDARD = pfade.archivStandard // Plan 7.5: getrennt vom Arbeitsordner
  // ctx.datenSpeichern ersetzt die ganze Datei: immer mit dem Rest (z. B. Einstellungen) zusammenführen
  const speichern = (dateien) => ctx.datenSpeichern({ ...ctx.datenLaden(), dateien })
  const einstellungen = () => ctx.datenLaden().einstellungen || {}
  profil.setzen(ctx.datenLaden().angaben)

  // ---------- Belegarchiv: seit Schritt 1.5 die einzige Ablage der Shopify- und Shirtigo-Belege ----------
  // Der Abgleichstand ist veränderlich und liegt darum in den Plugin-Daten, nicht im Archiv.
  const archivOrdner = () => path.resolve(einstellungen().archivPfad || ARCHIV_STANDARD)
  // Shopify-Zugang: in Vendo aus Hermes (host.js), eigenständig verschlüsselt in den Plugin-Daten („zugaenge.shopify“)
  const shopifyGespeichert = () => {
    const roh = ctx.datenLaden().zugaenge?.shopify
    if (!roh) return null
    return JSON.parse(host.tresor.entschluesseln(Buffer.from(String(roh), 'base64')))
  }
  const shopifyZugang = () => (host.zugaengeEinstellbar ? shopifyGespeichert() : host.shopifyZugang())
  const abgleichStand = {
    lesen: () => ctx.datenLaden().abgleich?.shopify || {},
    schreiben: (stand) => { const d = ctx.datenLaden(); ctx.datenSpeichern({ ...d, abgleich: { ...(d.abgleich || {}), shopify: stand } }) }
  }
  let belegArchiv = null
  function archivEinrichten() {
    belegArchiv = archiv(archivOrdner(), { schutz: host.windows ? schutz : null }) // NTFS-Schutz nur unter Windows
    bestellungen.einrichten({ archiv: belegArchiv, stand: abgleichStand, zugang: shopifyZugang })
    shirtigoB.einrichten({ archiv: belegArchiv })
  }
  archivEinrichten()
  // Produktbilder (Phase 5.2): fertige PNGs im lokalen Bildspeicher neben Vendos Daten, nicht im Belegarchiv
  require('./beleg-layout').bildspeicherSetzen(pfade.bilder)

  const db = ctx.datenbank || null // PostgreSQL (fehlt in Tests und ohne Datenbank)
  // Shirtigo-Token verschlüsselt im Benutzerordner (Vendo: wie bisher userData\shirtigo.token)
  shirtigo.einrichten({ datei: () => path.join(host.benutzerOrdner(), 'shirtigo.token'), tresor: host.tresor })
  let indexLaeuft = null
  let indexZeitgeber = null
  const indexQuellen = () => ({ shop: bestellungen.eintraege(), shirtigo: shirtigoB.eintraege(), belege: lesen().map((d) => mit13b(d)) })
  const indexQuelle = () => { const e = belegArchiv.eintraege(); return dbIndex.quelleVon([belegArchiv.WURZEL, e.length, e.at(-1) || null, lesen(), ctx.datenLaden().p13bAnbieter || {}, profil.stand(), VERSION]) }
  const indexBald = () => { if (!db) return; clearTimeout(indexZeitgeber); indexZeitgeber = setTimeout(() => indexAktualisieren().catch((f) => console.warn(`Buchhaltung-Index: ${f.message}`)), 5000) }

  function lesen() {
    const daten = ctx.datenLaden()
    return Array.isArray(daten.dateien) ? daten.dateien.filter((d) => d && ID.test(d.id)) : []
  }
  const sichtbar = () => lesen().filter((d) => !d.ausgeblendet)
  // § 13b (Schritt 4.4): Fall je Ausgaben-Beleg aus Erkennung + gespeicherten Angaben (d.p13b) + Einstufung des Lieferanten.
  // Die Steuer zählt zusätzlich als Ausgabe (kein Vorsteuerabzug). Nur für die Ausgabe/Summen, gespeichert wird nichts davon.
  const mit13b = (d, anbieter = ctx.datenLaden().p13bAnbieter || {}) => {
    const r = d?.rechnung
    const fall = r ? steuer.p13bFall(r, d.p13b || {}, anbieter[r.lieferant] || {}) : null
    if (!fall) return d
    return { ...d, rechnung: { ...r, p13b: fall, wirksam: Math.round(((r.wirksam ?? 0) + fall.steuer) * 100) / 100, wirksamArt: fall.steuer ? 'inkl. § 13b-Steuer' : r.wirksamArt } }
  }
  // Selbst eingelesene PDFs liegen seit Schritt 1.6 im Belegarchiv (Art „eingang“); ältere Einträge ohne Archivverweis
  // noch unter daten/rechnungen. Der ausgelesene Text (.txt) bleibt veränderlich in daten/rechnungen (kein Beleg).
  const pdfDatei = (d) => d.archiv ? belegArchiv.pfad(d.archiv) : path.join(ORDNER, `${d.id}.pdf`)

  // Liste der PDFs. Wurde der Parser verbessert (VERSION) oder haben sich „Meine Angaben“ geändert (eigene Namen, Steuerstatus),
  // werden gespeicherte Texte automatisch neu ausgewertet – ohne erneuten Scan.
  ctx.bereitstellen('liste', () => {
    const vorhanden = sichtbar().filter((d) => fs.existsSync(pdfDatei(d)))
    let geaendert = false
    const aktuell = vorhanden.map((d) => {
      const txt = path.join(ORDNER, `${d.id}.txt`)
      if (!d.scanStand || (d.rechnung?.version === VERSION && d.rechnung?.profil === profil.stand()) || !fs.existsSync(txt)) return d
      try { geaendert = true; return { ...d, rechnung: parseRechnung(fs.readFileSync(txt, 'utf8')) } } catch { return d }
    })
    if (geaendert) speichern(lesen().map((d) => aktuell.find((a) => a.id === d.id) || d))
    const anbieter = ctx.datenLaden().p13bAnbieter || {}
    return [...aktuell.map((d) => mit13b(d, anbieter)), ...bestellungen.eintraege(), ...shirtigoB.eintraege(), ...bestellungen.gebuehrenEintraege()]
  })

  ctx.bereitstellen('textHolen', (id) => {
    id = String(id || '')
    if (!ID.test(id) || !lesen().some((d) => d.id === id)) throw new Error('PDF-Eintrag nicht gefunden.')
    const datei = path.join(ORDNER, `${id}.txt`)
    if (!fs.existsSync(datei)) throw new Error('Fuer dieses PDF wurde noch kein Text ausgelesen.')
    return fs.readFileSync(datei, 'utf8')
  })

  ctx.bereitstellen('scannen', async (id) => {
    id = String(id || '')
    const eintrag = lesen().find((d) => d.id === id)
    if (!ID.test(id) || !eintrag) throw new Error('PDF-Eintrag nicht gefunden.')
    const pdfPfad = pdfDatei(eintrag)
    if (!fs.existsSync(pdfPfad)) throw new Error('PDF-Datei nicht gefunden.')

    pdfjsLaden ||= import('pdfjs-dist/legacy/build/pdf.mjs')
    const pdfjs = await pdfjsLaden
    const ladeAufgabe = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPfad)), verbosity: 0 })
    const pdf = await ladeAufgabe.promise
    if (pdf.numPages > MAX_SEITEN) {
      await ladeAufgabe.destroy()
      throw new Error(`Das PDF hat ${pdf.numPages} Seiten. Bitte teile es in Abschnitte mit hoechstens ${MAX_SEITEN} Seiten.`)
    }

    let worker = null
    let textseiten = []
    let ocrBenutzt = false
    let textlayerBenutzt = false
    try {
      for (let nummer = 1; nummer <= pdf.numPages; nummer++) {
        const seite = await pdf.getPage(nummer)
        let text = await seitenText(seite, pdfjs.OPS) // wie bisher, aber durchgestrichener Text steht als ~~Text~~

        if (text.replace(/\s/g, '').length < 20) {
          if (!worker) {
            const cachePfad = path.join(ORDNER, '.ocr-cache')
            fs.mkdirSync(cachePfad, { recursive: true })
            worker = await createWorker('deu', 1, { langPath: deutscheSprache.langPath, cachePath: cachePfad, gzip: true })
          }
          const grundAnsicht = seite.getViewport({ scale: 1 })
          const pixelLimit = Math.sqrt(12_000_000 / (grundAnsicht.width * grundAnsicht.height))
          const ansicht = seite.getViewport({ scale: Math.min(2, pixelLimit) })
          const canvas = createCanvas(Math.ceil(ansicht.width), Math.ceil(ansicht.height))
          await seite.render({ canvasContext: canvas.getContext('2d'), viewport: ansicht }).promise
          const erkannt = await worker.recognize(canvas.toBuffer('image/png'))
          text = String(erkannt.data.text || '').trim()
          ocrBenutzt = true
        } else {
          textlayerBenutzt = true
        }

        textseiten.push(`--- Seite ${nummer} ---\n${text || '[Kein Text erkannt]'}`)
        seite.cleanup()
        if (textseiten.join('\n\n').length > MAX_TEXT) throw new Error('Das Textergebnis ist zu gross. Bitte teile das PDF auf.')
      }
    } finally {
      if (worker) await worker.terminate().catch(() => {})
      await ladeAufgabe.destroy().catch(() => {})
    }

    const text = textseiten.join('\n\n')
    const methode = ocrBenutzt && textlayerBenutzt ? 'text+ocr' : ocrBenutzt ? 'ocr' : 'text'
    let rechnung = null
    try { rechnung = parseRechnung(text) } catch (e) { rechnung = { fehler: e.message, positionen: [], pruefung: { ok: false, hinweise: ['Auswertung fehlgeschlagen: ' + e.message] } } }
    const aktualisiert = { ...eintrag, scanStand: Date.now(), methode, seiten: pdf.numPages, zeichen: text.length, rechnung }
    const temp = path.join(ORDNER, `${id}.txt.neu`)
    fs.mkdirSync(ORDNER, { recursive: true })
    fs.writeFileSync(temp, text, 'utf8')
    fs.renameSync(temp, path.join(ORDNER, `${id}.txt`))
    speichern(lesen().map((d) => d.id === id ? aktualisiert : d))
    return { ...aktualisiert, text }
  })

  ctx.bereitstellen('uebersicht', () => { const anbieter = ctx.datenLaden().p13bAnbieter || {}; return auswerten(sichtbar().map((d) => mit13b(d, anbieter).rechnung).filter(Boolean)) }) // ausgeblendete zählen nicht

  // Umsatz je Jahr nach Zahlungseingang (Schritt 4.2): Shopify-Bestellungen aus dem Archiv + eigene Einnahmen aus eingelesenen
  // Belegen. Ein eingelesener Shop-Beleg zu einer Bestellung, die schon aus Shopify kommt, zählt nicht doppelt.
  // Dazu der Grenzwert-Wächter (Schritt 4.3) für das laufende Jahr und ein Abgleich mit dem gespeicherten Steuerstatus.
  const alleEinnahmen = () => {
    const shop = bestellungen.eintraege().map((e) => e.rechnung)
    const nummern = new Set(shop.map((x) => String(x.referenz)))
    const eigene = sichtbar().map((d) => d.rechnung).filter((x) => x?.art === 'einnahme' && !(x.referenz && nummern.has(String(x.referenz))))
    return [...shop, ...eigene]
  }
  const heuteAus = (optionen) => /^\d{4}-\d{2}-\d{2}$/.test(String(optionen?.heute || '')) ? optionen.heute : new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' })
  const waechterFuer = (alle, heute) => {
    const waechter = steuer.grenzwerte(alle, { jahr: heute.slice(0, 4) })
    // Laut Daten keine Kleinunternehmerregelung mehr, im Steuerstatus („Meine Angaben“) steht aber heute noch Kleinunternehmer
    return { waechter, statusPasst: waechter.kleinunternehmer || !profil.kleinunternehmerAm(heute) }
  }
  ctx.bereitstellen('umsatzJahre', (optionen = {}) => {
    const alle = alleEinnahmen()
    const heute = heuteAus(optionen)
    return { jahre: steuer.umsatzJahre(alle), ...waechterFuer(alle, heute), heute, stand: new Date().toISOString() }
  })

  // Text erneut auswerten (z. B. nach Parser-Update), ohne das PDF neu zu scannen
  ctx.bereitstellen('neuAuswerten', (id) => {
    id = String(id || '')
    const eintrag = lesen().find((d) => d.id === id)
    if (!ID.test(id) || !eintrag) throw new Error('PDF-Eintrag nicht gefunden.')
    const datei = path.join(ORDNER, `${id}.txt`)
    if (!fs.existsSync(datei)) throw new Error('Fuer dieses PDF wurde noch kein Text ausgelesen.')
    const aktualisiert = { ...eintrag, rechnung: parseRechnung(fs.readFileSync(datei, 'utf8')) }
    speichern(lesen().map((d) => d.id === id ? aktualisiert : d))
    return aktualisiert
  })

  // Quelle: in Vendo der Pfad der gezogenen Datei, eigenständig (Browser) ihr Inhalt als Base64
  const MAX_PDF = 50 * 1024 * 1024
  ctx.bereitstellen('hinzufuegen', ({ pfad, name, inhalt } = {}) => {
    const originalName = path.basename(String(name || 'Rechnung.pdf')).slice(0, 240)
    let quelle
    let info
    if (inhalt != null && pfad == null) {
      if (path.extname(originalName).toLowerCase() !== '.pdf') throw new Error('Bitte eine PDF-Datei auswaehlen.')
      const roh = String(inhalt)
      if (roh.length > Math.ceil(MAX_PDF / 3) * 4) throw new Error('Die PDF-Datei ist zu groß (höchstens 50 MB).')
      quelle = Buffer.from(roh, 'base64')
      if (!quelle.length || quelle.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('Das ist keine PDF-Datei.')
      info = { size: quelle.length }
    } else {
      quelle = String(pfad || '')
      if (!path.isAbsolute(quelle) || path.extname(originalName).toLowerCase() !== '.pdf') {
        throw new Error('Bitte eine PDF-Datei auswaehlen.')
      }
      info = fs.statSync(quelle, { throwIfNoEntry: false })
      if (!info?.isFile() || path.extname(quelle).toLowerCase() !== '.pdf') throw new Error('Die PDF-Datei wurde nicht gefunden.')
    }

    // Ins Belegarchiv kopieren (die Quelldatei bleibt unberührt): unveränderlich, schreibgeschützt, in der Hash-Kette (B14).
    // Jahr = Eingangsjahr, weil das Belegdatum erst beim Scannen erkannt wird. Gleiche Datei = derselbe Archivbeleg.
    const id = `r${randomBytes(10).toString('hex')}`
    const abgelegt = belegArchiv.ablegen(quelle, { art: 'eingang', jahr: new Date().getFullYear(), name: originalName, meta: { quelle: 'pdf-eingang', eintrag: id, name: originalName } })
    const eintrag = { id, name: originalName, groesse: info.size, zeit: Date.now(), archiv: { datei: abgelegt.datei, sha256: abgelegt.sha256 } }
    speichern([...lesen(), eintrag]) // scheitert das, bleibt der Beleg im Archiv; erneutes Hinzufügen findet ihn wieder
    return { ...eintrag, ...(abgelegt.doppelt ? { schonImArchiv: true } : {}), ...(abgelegt.schutzFehler ? { schutzFehler: abgelegt.schutzFehler } : {}) }
  })

  // Ausblenden statt Löschen (B14): Belege sind aufbewahrungspflichtig. Der Eintrag verschwindet aus Liste und Summen,
  // die PDF bleibt unverändert im Archiv, Text und Auswertung bleiben gespeichert.
  ctx.bereitstellen('ausblenden', (id) => {
    id = String(id || '')
    if (!ID.test(id)) throw new Error('Ungueltiger PDF-Eintrag.')
    const dateien = lesen()
    if (!dateien.some((d) => d.id === id)) throw new Error('PDF-Eintrag nicht gefunden.')
    speichern(dateien.map((d) => d.id === id ? { ...d, ausgeblendet: d.ausgeblendet || new Date().toISOString() } : d))
    return true
  })

  // ---------- Shopify-Bestellungen (API) ----------
  ctx.bereitstellen('bestellOrte', () => bestellungen.orte()) // aggregierte Orte (Anzahl je Ort) für den Globus im Reaktor
  // Phase 5.3: Neufassung der Umsatzbelege mit falschem Steuerausweis. Planen und Vorschau legen nichts ab; Erzeugen legt die
  // Neufassungen und ein Protokoll zusätzlich ins Archiv (alte Fassungen bleiben).
  ctx.bereitstellen('neufassungPlanen', () => bestellungen.neufassungPlanen())
  ctx.bereitstellen('neufassungVorschau', async () => {
    const v = await bestellungen.neufassungVorschau()
    if (!v) return null
    const datei = path.join(require('node:os').tmpdir(), `Vendo Vorschau Neufassung ${v.nr}.pdf`) // nur zum Ansehen, nicht im Archiv
    fs.writeFileSync(datei, v.pdf)
    const fehler = await host.oeffnen(datei)
    return { nr: v.nr, anzahl: v.anzahl, geoeffnet: !fehler, fehler: fehler || null }
  })
  ctx.bereitstellen('neufassungErzeugen', async () => {
    if (bestellungen.beschaeftigt() || shirtigoB.beschaeftigt()) throw new Error('Ein Abgleich läuft gerade. Bitte danach erneut versuchen.')
    const erg = await bestellungen.neufassungErzeugen()
    indexBald()
    return erg
  })
  ctx.bereitstellen('bestellungenSyncen', () => Promise.resolve(bestellungen.abgleichen()).finally(() => indexBald()))
  ctx.bereitstellen('belegOeffnen', async (id) => {
    const pfad = String(id).startsWith('t') ? shirtigoB.pdfPfad(id) : bestellungen.pdfPfad(id) // t… = Shirtigo-Original, s… = Shopify-Beleg
    const fehler = await host.oeffnen(pfad)
    if (fehler) throw new Error(fehler)
    return true
  })
  // Wartung: Archiv-Ordner zeigen
  ctx.bereitstellen('archivOeffnen', async () => {
    fs.mkdirSync(belegArchiv.WURZEL, { recursive: true })
    const fehler = await host.oeffnen(belegArchiv.WURZEL)
    if (fehler) throw new Error(fehler)
    return belegArchiv.WURZEL
  })
  // „Alle zurücksetzen“ wurde entfernt (Plan B6, Schritt 1.2): Belege sind 8 Jahre aufzubewahren und werden nie gesammelt gelöscht.

  // ---------- Archivordner (Plan 7.5, Schritt 1.2) ----------
  // Belegarchiv, getrennt vom Arbeitsordner. Die Oberfläche dafür kommt mit dem Tab „Meine Angaben“ (Schritt 2.1).
  ctx.bereitstellen('archivPfad', () => {
    const eigen = einstellungen().archivPfad
    return { pfad: eigen || ARCHIV_STANDARD, standard: ARCHIV_STANDARD, eigen: !!eigen }
  })
  ctx.bereitstellen('archivPfadSetzen', (eingabe) => {
    const roh = eingabe == null || eingabe === '' ? null : String(eingabe)
    if (roh !== null && (!path.isAbsolute(roh) || roh.length > 260)) throw new Error('Bitte einen vollständigen Ordnerpfad angeben (z. B. C:\\Users\\Name\\Documents\\Vendo-Archiv).')
    const neu = roh === null ? ARCHIV_STANDARD : path.resolve(roh)
    const alt = path.resolve(einstellungen().archivPfad || ARCHIV_STANDARD)
    if (path.parse(neu).root === neu) throw new Error('Das Archiv darf nicht direkt auf einem Laufwerk liegen.')
    if (innerhalb(neu, VENDO)) throw new Error(host.art === 'vendo' ? 'Das Archiv darf nicht im Vendo-Ordner liegen.' : 'Das Archiv darf nicht im Programmordner liegen.')
    if (innerhalb(neu, bestellungen.WURZEL) || innerhalb(bestellungen.WURZEL, neu)) throw new Error('Das Archiv muss getrennt vom Arbeitsordner mit den Monatsordnern liegen.')
    const info = fs.statSync(neu, { throwIfNoEntry: false })
    if (info && !info.isDirectory()) throw new Error('Unter diesem Pfad liegt eine Datei, kein Ordner.')
    if (neu !== alt && archivBelegt(alt)) throw new Error('Das bisherige Archiv enthält schon Belege. Ein Umzug ist nur über die geprüfte Migration möglich.')
    if (neu !== alt && archivBelegt(neu)) throw new Error('Im gewählten Ordner liegt bereits ein anderes Archiv.')
    if (bestellungen.beschaeftigt() || shirtigoB.beschaeftigt()) throw new Error('Ein Abgleich läuft gerade. Bitte kurz warten und noch einmal versuchen.')
    const daten = ctx.datenLaden()
    const rest = { ...(daten.einstellungen || {}) }
    if (roh === null) delete rest.archivPfad
    else rest.archivPfad = neu
    ctx.datenSpeichern({ ...daten, einstellungen: rest })
    archivEinrichten()
    return { pfad: neu, standard: ARCHIV_STANDARD, eigen: roh !== null }
  })
  ctx.bereitstellen('integritaet', () => ({ archiv: belegArchiv.integritaet() })) // prüft alle Belege samt Hash-Kette

  // ---------- § 13b: Steuer auf Leistungen ausländischer Anbieter (Schritt 4.4, Plan 7.4) ----------
  // Gespeichert in den Plugin-Daten: je Beleg d.p13b { aktiv, monat, betragEur }, je Lieferant p13bAnbieter[lieferant]
  // { einstufung, herkunft }, je Monat p13bMonate[monat] { am } (Voranmeldung abgegeben).
  const MONAT_RE = /^\d{4}-(0[1-9]|1[0-2])$/
  const TAG_RE = /^\d{4}-\d{2}-\d{2}$/
  const heuteBerlin = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' })
  ctx.bereitstellen('p13bUebersicht', (optionen = {}) => p13bDaten(TAG_RE.test(String(optionen?.heute || '')) ? optionen.heute : heuteBerlin()))
  function p13bDaten(heute) {
    const d = ctx.datenLaden()
    const anbieter = d.p13bAnbieter || {}
    const faelle = sichtbar().filter((x) => x.rechnung && x.rechnung.art !== 'einnahme').map((x) => {
      const r = x.rechnung
      return { id: x.id, name: x.name, lieferant: r.lieferant || null, datum: r.datum || null, betrag: r.summen?.netto ?? r.summen?.brutto ?? null, waehrung: r.waehrung || 'EUR', erkannt: !!r.reverseCharge, eintrag: x.p13b || {}, fall: steuer.p13bFall(r, x.p13b || {}, anbieter[r.lieferant] || {}) }
    })
    const mit = faelle.filter((x) => x.fall)
    const lieferanten = [...new Set(mit.map((x) => x.lieferant).filter(Boolean))].sort().map((l) => ({ lieferant: l, einstufung: anbieter[l]?.einstufung || null, herkunft: anbieter[l]?.herkunft || null, vermutetFrei: mit.some((x) => x.lieferant === l && x.fall.vermutetFrei) }))
    const einstellungen = p13bEinstellungenLesen(d)
    const monate = steuer.p13bMonate(mit, d.p13bMonate || {}, { heute, ...einstellungen })
    // Vorschlag für den Voranmeldungszeitraum des laufenden Jahres (§ 18 Abs. 2 UStG); Vorjahressteuer aus den § 13b-Zeiträumen
    const jahr = Number(heute.slice(0, 4))
    const vorjahrSteuer = monate.filter((m) => m.monat.startsWith(String(jahr - 1))).reduce((s, m) => s + m.steuer, 0)
    const gd = String((d.angaben || {}).gruendungsdatum || '')
    const gruendungsjahr = /^\d{4}/.test(gd) ? Number(gd.slice(0, 4)) : null
    return { faelle, monate, lieferanten, heute, einstellungen, vorschlag: { jahr, ...steuer.zeitraumVorschlag({ jahr, gruendungsjahr, vorjahrSteuer }) } }
  }
  ctx.bereitstellen('p13bSetzen', (id, angaben = {}) => {
    id = String(id || '')
    if (!ID.test(id) || !lesen().some((x) => x.id === id)) throw new Error('Beleg nicht gefunden.')
    if (!angaben || typeof angaben !== 'object') throw new Error('Ungültige Angaben.')
    const neu = {}
    if (angaben.aktiv === true || angaben.aktiv === false) neu.aktiv = angaben.aktiv
    if (angaben.monat != null && angaben.monat !== '') { if (!MONAT_RE.test(String(angaben.monat))) throw new Error('Bitte einen Monat wie 2026-03 angeben.'); neu.monat = String(angaben.monat) }
    if (angaben.betragEur != null && angaben.betragEur !== '') {
      const b = Number(String(angaben.betragEur).replace(',', '.'))
      if (!Number.isFinite(b) || b < 0 || b > 1e7) throw new Error('Bitte einen Euro-Betrag angeben.')
      neu.betragEur = Math.round(b * 100) / 100
    }
    speichern(lesen().map((x) => x.id !== id ? x : Object.keys(neu).length ? { ...x, p13b: neu } : (({ p13b, ...rest }) => rest)(x)))
    return lesen().find((x) => x.id === id).p13b || null
  })
  ctx.bereitstellen('p13bAnbieter', (lieferant, angaben = {}) => {
    const name = String(lieferant || '').trim()
    if (!name || name.length > 200) throw new Error('Ungültiger Lieferant.')
    const einstufung = ['steuerpflichtig', 'steuerfrei'].includes(angaben?.einstufung) ? angaben.einstufung : null
    const herkunft = ['eu', 'drittland'].includes(angaben?.herkunft) ? angaben.herkunft : null
    const d = ctx.datenLaden()
    const alle = { ...(d.p13bAnbieter || {}) }
    if (einstufung || herkunft) alle[name] = { ...(einstufung ? { einstufung } : {}), ...(herkunft ? { herkunft } : {}) }
    else delete alle[name]
    ctx.datenSpeichern({ ...d, p13bAnbieter: alle })
    return alle[name] || null
  })
  // Voranmeldungszeitraum und Dauerfristverlängerung, wie vom Finanzamt festgelegt (Plan-Abschnitt 5, § 18 Abs. 2 UStG, § 46 UStDV)
  function p13bEinstellungenLesen(d = ctx.datenLaden()) { const e = d.p13bEinstellungen || {}; return { quartalAb: e.quartalAb || null, dauerfrist: !!e.dauerfrist } }
  ctx.bereitstellen('p13bEinstellungen', (neu) => {
    const d = ctx.datenLaden()
    if (neu === undefined) return p13bEinstellungenLesen(d)
    const q = neu?.quartalAb == null || neu.quartalAb === '' ? null : Number(neu.quartalAb)
    if (q !== null && !(Number.isInteger(q) && q >= 2000 && q <= 2099)) throw new Error('Bitte ein Jahr wie 2026 angeben.')
    const e = { quartalAb: q, dauerfrist: !!neu?.dauerfrist }
    ctx.datenSpeichern({ ...d, p13bEinstellungen: e })
    return e
  })
  ctx.bereitstellen('p13bAngemeldet', (monat, am) => {
    if (!MONAT_RE.test(String(monat || '')) && !/^\d{4}-Q[1-4]$/.test(String(monat || ''))) throw new Error('Ungültiger Monat.')
    if (am != null && !TAG_RE.test(String(am))) throw new Error('Ungültiges Datum.')
    const d = ctx.datenLaden()
    const alle = { ...(d.p13bMonate || {}) }
    if (am) alle[monat] = { am: String(am) }
    else delete alle[monat]
    ctx.datenSpeichern({ ...d, p13bMonate: alle })
    return alle[monat] || null
  })

  // ---------- Meine Angaben (Schritt 2.1, Plan 7.2) ----------
  // Gespeichert unter „angaben“ in den Plugin-Daten, jede Änderung mit Datum unter „angabenVerlauf“. Für leere Felder gibt es
  // einen Vorschlag aus den bis Schritt 2.3 fest im Code stehenden Angaben (bisher.js, darf fehlen).
  const bisherigeAngaben = () => {
    try { const b = require('./bisher'); return { firma: b.FIRMA || {}, namen: b.EIGENE_NAMEN || [] } } catch { return { firma: {}, namen: [] } }
  }
  // Nur Felder vorschlagen, die noch leer sind – gespeicherte Angaben werden nie überschrieben
  const vorschlagFuerLeere = (werte) => {
    const alt = bisherigeAngaben()
    const leer = (feld) => { const x = werte[feld]; return Array.isArray(x) ? !x.length : !x }
    const v = Object.entries(angaben.vorschlag(alt.firma, alt.namen)).filter(([feld, wert]) => leer(feld) && JSON.stringify(wert) !== JSON.stringify(werte[feld]))
    return v.length ? Object.fromEntries(v) : null
  }
  // Steuerstatus je Zeitraum (Schritt 2.2): Vorschlag und Abgleich aus der Shopify-Steuer im Archiv (Plan 8.1)
  const steuerBefund = () => { try { return bestellungen.steuerBefund() } catch { return null } }
  ctx.bereitstellen('angabenLaden', () => {
    const d = ctx.datenLaden()
    const werte = { ...angaben.standardwerte(), ...(d.angaben || {}) }
    const ordner = archivOrdner()
    const befund = steuerBefund()
    const vorschlag = befund && !werte.steuerzeitraeume.length ? angaben.steuerVorschlag(befund) : null
    return {
      felder: angaben.FELDER, werte, gespeichert: !!d.angaben, steuerarten: angaben.STEUERARTEN,
      steuer: { daten: !!befund, bestellungen: befund?.length || 0, vorschlag, abgleich: befund ? angaben.steuerAbgleich(werte.steuerzeitraeume, befund) : null },
      vorschlag: vorschlagFuerLeere(werte),
      pruefung: angaben.pruefen(werte), vorschau: angaben.nummerVorschau(werte.nummernFormat, werte.naechsteNummer),
      verlauf: (d.angabenVerlauf || []).slice(-5).map((v) => ({ zeit: v.zeit, felder: v.aenderungen.map((x) => x.feld) })),
      archiv: { pfad: ordner, belegt: archivBelegt(ordner) }
    }
  })
  ctx.bereitstellen('angabenSpeichern', (eingabe) => {
    if (!eingabe || typeof eingabe !== 'object' || Array.isArray(eingabe)) throw new Error('Ungültige Angaben.')
    const werte = angaben.normalisieren(eingabe)
    const pruefung = angaben.pruefen(werte)
    if (!pruefung.ok) return { ok: false, werte, pruefung } // Formatfehler: nichts speichern
    const d = ctx.datenLaden()
    const aenderungen = angaben.unterschiede(d.angaben || {}, werte)
    if (d.angaben && !aenderungen.length) return { ok: true, werte, pruefung, geaendert: 0 }
    const verlauf = [...(d.angabenVerlauf || []), { zeit: new Date().toISOString(), aenderungen }].slice(-100)
    ctx.datenSpeichern({ ...d, angaben: werte, angabenVerlauf: verlauf })
    // Ab jetzt gelten die neuen Angaben (Liste, Summen, neue Belege). Bestehende Belege im Archiv bleiben unverändert.
    profil.setzen(werte)
    bestellungen.neuBerechnen()
    shirtigoB.neuBerechnen()
    return { ok: true, werte, pruefung, geaendert: aenderungen.length }
  })

  // ---------- Persönliche Angaben, Bereiche im Menü, ELSTER-Übersicht (Plan 11.3, M.1/M.2/M.5) ----------
  // Persönliche Angaben stehen nur verschlüsselt in den Plugin-Daten („persoenlich“): in Vendo mit dem Windows-Speicher
  // (safeStorage), eigenständig mit dem Passwort-Tresor (host.js).
  const tresor = () => {
    if (!host.tresor.verfuegbar()) throw new Error(`${host.tresor.name} ist gerade nicht verfügbar.`)
    return host.tresor
  }
  const persoenlichLesen = () => {
    const roh = ctx.datenLaden().persoenlich
    if (!roh) return null
    return persoenlich.normalisieren(JSON.parse(tresor().entschluesseln(Buffer.from(String(roh), 'base64'))))
  }
  ctx.bereitstellen('persoenlichLaden', () => {
    const werte = persoenlichLesen()
    return { felder: persoenlich.FELDER, werte: werte || persoenlich.leer(), gespeichert: !!werte }
  })
  ctx.bereitstellen('persoenlichSpeichern', (eingabe) => {
    if (!eingabe || typeof eingabe !== 'object' || Array.isArray(eingabe)) throw new Error('Ungültige Angaben.')
    const werte = persoenlich.normalisieren(eingabe)
    const pruefung = persoenlich.pruefen(werte)
    if (!pruefung.ok) return { ok: false, pruefung }
    const verschluesselt = tresor().verschluesseln(JSON.stringify(werte)).toString('base64')
    ctx.datenSpeichern({ ...ctx.datenLaden(), persoenlich: verschluesselt })
    return { ok: true, pruefung }
  })
  const AUSBLENDBAR = ['bestellungen', 'rechnungen', 'steuer'] // Übersicht und Meine Angaben bleiben immer sichtbar (B-1)
  ctx.bereitstellen('menueLaden', () => ({ ausblendbar: AUSBLENDBAR, aus: (ctx.datenLaden().menue?.aus || []).filter((t) => AUSBLENDBAR.includes(t)) }))
  ctx.bereitstellen('menueSpeichern', (aus) => {
    const liste = [...new Set((Array.isArray(aus) ? aus : []).map(String).filter((t) => AUSBLENDBAR.includes(t)))]
    ctx.datenSpeichern({ ...ctx.datenLaden(), menue: { aus: liste } })
    return { ausblendbar: AUSBLENDBAR, aus: liste }
  })
  ctx.bereitstellen('elsterUebersicht', (optionen = {}) => {
    const euer = dashboardDaten(heuteAus(optionen)).euer || []
    const jahre = euer.map((e) => e.jahr).sort().reverse()
    const jahr = jahre.includes(String(optionen?.jahr)) ? String(optionen.jahr) : jahre.find((j) => j < heuteAus(optionen).slice(0, 4)) || jahre[0] || null
    const firma = { ...angaben.standardwerte(), ...(ctx.datenLaden().angaben || {}) }
    let person = null
    try { person = persoenlichLesen() } catch { /* Windows-Speicher gerade nicht verfügbar: Übersicht ohne persönliche Angaben */ }
    const ust = ustJahreVon(ctx.datenLaden(), p13bDaten(heuteAus(optionen)).monate).find((u) => u.jahr === jahr) || null
    return { jahre, ...persoenlich.elster({ person: person || {}, firma, euer: euer.find((e) => e.jahr === jahr) || null, jahr, ust }) }
  })

  // ---------- Zeitstempel (Schritt 1.7) ----------
  // Versiegeln schickt nur den SHA-256 eines kleinen Siegel-Dokuments (Kettenhash + Anzahl) an Sectigo (qualifiziert) und FreeTSA.
  ctx.bereitstellen('versiegeln', async () => {
    if (bestellungen.beschaeftigt() || shirtigoB.beschaeftigt()) throw new Error('Ein Abgleich läuft gerade. Bitte danach versiegeln.')
    return zeitstempel.versiegeln({ archiv: belegArchiv })
  })
  ctx.bereitstellen('siegelPruefen', () => zeitstempel.pruefen({ archiv: belegArchiv }))

  // ---------- Wiederherstellungsschlüssel für die USB-Sicherung (Schritt 1.8) ----------
  // Verschlüsselt mit dem Host-Tresor (Vendo: Windows-DPAPI) im Benutzerordner, wie der Shirtigo-Token. Der Schlüssel
  // verlässt den Hauptprozess nur einmal: beim Erzeugen fürs Wiederherstellungsblatt. Status und Bestätigung ohne Schlüssel.
  let usbSpeicher = null
  const usb = () => {
    if (usbSpeicher) return usbSpeicher
    usbSpeicher = schluessel.speicher({
      // Dateiname bleibt aus der Zeit als „rechnungen“: Der vorhandene Schlüssel öffnet die USB-Sicherungen
      datei: path.join(host.benutzerOrdner(), 'rechnungen-usb-schluessel.bin'),
      tresor: { verfuegbar: () => host.tresor.verfuegbar(), verschluesseln: (t) => host.tresor.verschluesseln(t), entschluesseln: (b) => host.tresor.entschluesseln(b) }
    })
    return usbSpeicher
  }
  ctx.bereitstellen('usbSchluesselStatus', () => usb().status())
  ctx.bereitstellen('usbSchluesselNeu', () => usb().neu())
  ctx.bereitstellen('usbSchluesselBestaetigen', (eingabe) => usb().bestaetigen(String(eingabe || '').slice(0, 100)))
  ctx.bereitstellen('usbSchluesselEingeben', (eingabe) => usb().eingeben(String(eingabe || '').slice(0, 100)))

  // ---------- USB-Sicherung (Schritt 1.9) ----------
  // Nur auf Wechseldatenträger (Windows-Laufwerkstyp 2), nie löschend. Ergebnis der letzten Sicherung in den Plugin-Daten.
  let sicherungLaeuft = null
  const laufwerkPruefen = (eingabe) => {
    const lw = host.laufwerke().find((l) => l.laufwerk === String(eingabe || '').toUpperCase())
    if (!lw) throw new Error('Dieser USB-Stick wurde nicht gefunden. Bitte einstecken und „Neu suchen“.')
    return lw
  }
  const usbStand = () => ctx.datenLaden().usb || {}
  ctx.bereitstellen('usbLaufwerke', () => host.laufwerke())
  ctx.bereitstellen('usbPlan', async (eingabe) => {
    const lw = laufwerkPruefen(eingabe)
    const st = usb().status()
    return { laufwerk: lw, ...(await usbSicherung.planen({ archiv: belegArchiv, wurzel: lw.wurzel, wiederherstellungsschluessel: st.bestaetigt ? usb().laden() : null, freiBytes: lw.frei })) }
  })
  ctx.bereitstellen('usbSichern', async (eingabe) => {
    if (sicherungLaeuft) throw new Error('Eine USB-Sicherung läuft bereits.')
    if (bestellungen.beschaeftigt() || shirtigoB.beschaeftigt()) throw new Error('Ein Abgleich läuft gerade. Bitte danach sichern.')
    const lw = laufwerkPruefen(eingabe)
    const k = usb().laden() // wirft, wenn kein bestätigter Schlüssel vorhanden ist
    let person = null // P-2: persönliche Angaben verschlüsselt mit auf den Stick (Windows-Speicher nicht verfügbar: ohne sie)
    let personFehler = null
    try { person = persoenlichLesen() } catch (f) { personFehler = f.message }
    sicherungLaeuft = usbSicherung.sichern({ archiv: belegArchiv, wurzel: lw.wurzel, wiederherstellungsschluessel: k, freiBytes: lw.frei, persoenlich: person })
    try {
      const erg = await sicherungLaeuft
      const d = ctx.datenLaden()
      ctx.datenSpeichern({ ...d, usb: { ...(d.usb || {}), letzterVersuch: new Date().toISOString(), ...(erg.ok ? { letzteSicherung: new Date().toISOString(), laufwerk: lw.name || lw.laufwerk, stand: erg.stand, kennung: erg.kennung } : {}), letztesErgebnis: erg.ok ? 'ok' : 'fehler' } })
      return { ...erg, laufwerk: lw, ...(personFehler ? { persoenlichFehler: `Persönliche Angaben nicht mitgesichert: ${personFehler}` } : {}) }
    } finally { sicherungLaeuft = null }
  })
  // Nach einer Neuinstallation: persönliche Angaben vom Stick zurückholen. Überschreibt nie gespeicherte Angaben.
  ctx.bereitstellen('persoenlichVomStick', async (eingabe) => {
    if (persoenlichLesen()) throw new Error('Es sind schon persönliche Angaben gespeichert. Sie werden nicht überschrieben.')
    const lw = laufwerkPruefen(eingabe)
    const r = await usbSicherung.persoenlichLesen({ wurzel: lw.wurzel, wiederherstellungsschluessel: usb().laden() })
    if (!r) return { ok: false, meldung: 'Auf dem Stick sind keine persönlichen Angaben gesichert.' }
    const werte = persoenlich.normalisieren(r.werte)
    ctx.datenSpeichern({ ...ctx.datenLaden(), persoenlich: tresor().verschluesseln(JSON.stringify(werte)).toString('base64') })
    return { ok: true, stand: r.stand, erstellt: r.erstellt, felder: Object.values(werte).filter(Boolean).length }
  })
  ctx.bereitstellen('usbPruefen', async (eingabe) => {
    const lw = laufwerkPruefen(eingabe)
    return { ...(await usbSicherung.pruefen({ wurzel: lw.wurzel, wiederherstellungsschluessel: usb().laden() })), laufwerk: lw }
  })
  // ---------- Wartung: wöchentliche Prüfung, Wiederherstellungstest, Status (Schritt 1.10) ----------
  const WOCHE = 7 * 86_400_000
  const tageSeit = (iso) => iso ? Math.floor((Date.now() - Date.parse(iso)) / 86_400_000) : null
  let wartungLaeuft = null
  // Prüft Archiv (ohne den Hauptprozess zu blockieren) und Zeitstempel, wenn die letzte Prüfung ≥ 7 Tage alt ist
  ctx.bereitstellen('wartungLauf', async ({ erzwingen = false } = {}) => {
    const alt = ctx.datenLaden().wartung || null
    if (!erzwingen && alt?.zeit && Date.now() - Date.parse(alt.zeit) < WOCHE) return { ...alt, neu: false }
    wartungLaeuft ||= (async () => {
      const p = await belegArchiv.integritaetAsync()
      let siegel
      try {
        const s = zeitstempel.pruefen({ archiv: belegArchiv })
        siegel = { ok: s.ok, anzahl: s.anzahl, zuletzt: s.zuletzt?.zeit || null, nochNichtVersiegelt: s.nochNichtVersiegelt, fehler: s.ergebnisse.filter((e) => !e.ok).map((e) => e.fehler[0] || e.stempel.find((x) => !x.ok)?.fehler).filter(Boolean).slice(0, 5) }
      } catch (f) { siegel = { ok: null, fehler: [f.message] } } // z. B. OpenSSL fehlt: kein Archivfehler
      const datenbank = await indexGegenprobe() // D.3: Datenbank = Archiv? (null ohne Datenbank)
      const w = { zeit: new Date().toISOString(), ok: p.ok && siegel.ok !== false, archiv: { ok: p.ok, geprueft: p.geprueft, anzahlFehler: p.fehler.length, fehler: p.fehler.slice(0, 5) }, siegel, datenbank }
      ctx.datenSpeichern({ ...ctx.datenLaden(), wartung: w })
      return { ...w, neu: true }
    })().finally(() => { wartungLaeuft = null })
    return wartungLaeuft
  })
  // Wiederherstellungstest: Stick in Temp-Ordner entschlüsseln, prüfen, Ordner löschen; Prüfbericht ins Archiv (GoBD-Nachweis)
  ctx.bereitstellen('wiederherstellungTesten', async (eingabe) => {
    if (sicherungLaeuft) throw new Error('Eine USB-Sicherung läuft gerade.')
    const lw = laufwerkPruefen(eingabe)
    const erg = await usbSicherung.wiederherstellungTesten({ wurzel: lw.wurzel, wiederherstellungsschluessel: usb().laden() })
    const fehler = [...(erg.fehler || [])]
    let bericht = null
    try {
      const inhalt = { vorgang: 'Wiederherstellungstest der USB-Sicherung (Plan 7.5 Punkt 9)', zeit: erg.zeit, ok: erg.ok, laufwerk: lw.name || lw.laufwerk, stand: erg.stand || null, standErstellt: erg.erstellt || null, dateien: erg.dateien, bytes: erg.bytes, ...(erg.persoenlich ? { persoenlich: erg.persoenlich } : {}), letzterHash: erg.letzterHash || null, integritaet: erg.integritaet || null, fehler, dauerMs: erg.dauerMs, tempGeloescht: erg.tempGeloescht }
      bericht = belegArchiv.ablegen(Buffer.from(JSON.stringify(inhalt, null, 2), 'utf8'), { art: 'pruefbericht', jahr: Number(erg.zeit.slice(0, 4)), name: `Wiederherstellungstest ${erg.zeit.slice(0, 19).replace(/:/g, '-')}.json`, meta: { vorgang: 'wiederherstellungstest', ok: erg.ok, stand: erg.stand || null } }).datei
    } catch (f) { fehler.push(`Prüfbericht: ${f.message}`) }
    const d = ctx.datenLaden()
    ctx.datenSpeichern({ ...d, usb: { ...(d.usb || {}), letzterWiederherstellungstest: { zeit: erg.zeit, ok: erg.ok, stand: erg.stand || null, dateien: erg.dateien, ...(erg.persoenlich ? { persoenlich: erg.persoenlich } : {}) } } })
    return { ...erg, fehler, bericht, laufwerk: lw }
  })
  // Alles auf einen Blick für die Statusanzeige – ohne Schlüssel, ohne Belegdaten
  ctx.bereitstellen('archivStatus', () => archivStatusDaten())
  // Jahresarchiv als ZIP (E.1): Speicherort jedes Mal erfragen (E-6), nie ins Belegarchiv; der Export wird im Archiv protokolliert
  ctx.bereitstellen('jahresarchivJahre', () => jahresarchiv.jahre(belegArchiv))
  ctx.bereitstellen('jahresarchivExport', async ({ jahr } = {}) => {
    jahr = String(jahr || '')
    if (!jahresarchiv.jahre(belegArchiv).includes(jahr)) throw new Error('Für dieses Jahr gibt es keine Belege im Archiv.')
    if (bestellungen.beschaeftigt() || shirtigoB.beschaeftigt()) throw new Error('Ein Abgleich läuft gerade. Bitte danach exportieren.')
    const heute = heuteBerlin()
    const gewaehlt = await host.speichernUnter({ titel: `Jahresarchiv ${jahr} speichern`, name: `Buchhaltung-${jahr}-${heute}.zip`, filter: { name: 'ZIP-Archiv', extensions: ['zip'] } })
    if (!gewaehlt) return { abgebrochen: true }
    const ziel = path.resolve(gewaehlt)
    if (innerhalb(ziel, belegArchiv.WURZEL)) throw new Error('Das Jahresarchiv bitte nicht in das Belegarchiv speichern.')
    const d = ctx.datenLaden()
    const anbieter = d.p13bAnbieter || {}
    let vdExport = null // Verfahrensdokumentation genau wie im ZIP, danach im Archiv protokolliert
    const inhalt = jahresarchiv.zusammenstellen({
      jahr, archiv: belegArchiv, shop: bestellungen.eintraege(), shirtigo: shirtigoB.eintraege(), gebuehren: bestellungen.gebuehrenEintraege(), belege: lesen().map((x) => mit13b(x, anbieter)),
      euer: (dashboardDaten(heute).euer || []).find((e) => e.jahr === jahr) || null,
      firma: { ...angaben.standardwerte(), ...(d.angaben || {}) }, version: require('./plugin.json').version,
      zusatz: ({ fehler, pruefwert, arten }) => {
        const stand = verfahrenStand()
        vdExport = verfahren.verfahrensdokumentation({ stand, ergaenzungen: d.verfahren?.ergaenzungen, bestaetigung: d.verfahren?.bestaetigung })
        const euer = (dashboardDaten(heute).euer || []).find((e) => e.jahr === jahr) || null
        return [{ name: 'verfahrensdokumentation.md', inhalt: Buffer.from(vdExport, 'utf8') }, { name: 'jahresnachweis.md', inhalt: Buffer.from(verfahren.jahresnachweis({ jahr, stand, arten, euer, fehler, pruefwert }), 'utf8') }]
      }
    })
    const erg = await jahresarchiv.schreiben(inhalt.dateien, ziel)
    try {
      const zeit = new Date().toISOString()
      const bericht = { vorgang: 'jahresarchiv', jahr, zeit, datei: path.basename(ziel), bytes: erg.bytes, sha256: erg.sha256, dateien: inhalt.dateien.length, fehler: inhalt.fehler, pruefwert: inhalt.pruefwert }
      belegArchiv.ablegen(Buffer.from(JSON.stringify(bericht, null, 2), 'utf8'), { art: 'protokoll', jahr: Number(heute.slice(0, 4)), name: `Jahresarchiv ${jahr} ${zeit.slice(0, 19).replace(/:/g, '-')}.json`, meta: { vorgang: 'jahresarchiv', jahr, sha256: erg.sha256 } })
    } catch (f) { inhalt.fehler.push(`Protokoll im Archiv: ${f.message}`) }
    try { if (vdExport) verfahrenAblegen(vdExport, `jahresarchiv ${jahr}`) } catch (f) { inhalt.fehler.push(`Verfahrensdokumentation im Archiv: ${f.message}`) }
    return { ...erg, dateien: inhalt.dateien.length, fehler: inhalt.fehler }
  })
  // Prüfwert (E.2): Kopf der Hash-Kette zum Abschreiben; ein alter Prüfwert muss als Kettenglied wiederzufinden sein,
  // sonst wurde der Index seitdem verändert (nicht nur ergänzt).
  ctx.bereitstellen('pruefwert', () => { const e = belegArchiv.eintraege(); return { wert: e.at(-1)?.hash || null, eintraege: e.length, zeit: e.at(-1)?.zeit || null } })
  ctx.bereitstellen('pruefwertVergleichen', (alt) => {
    const wert = String(alt || '').trim().toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(wert)) return { gueltig: false }
    const e = belegArchiv.eintraege()
    const treffer = e.find((x) => x.hash === wert)
    return { gueltig: true, bekannt: !!treffer, nr: treffer?.nr || null, zeit: treffer?.zeit || null, seitdemNeu: treffer ? e.length - treffer.nr : null }
  })
  // ---------- Verfahrensdokumentation (7.2 / E.4) ----------
  // Aus dem echten Aufbau erzeugt; der Nutzer ergänzt nur, was Vendo nicht wissen kann, und bestätigt. Jede bestätigte
  // und jede exportierte Fassung wird als Datei im Archiv protokolliert (Art „protokoll“).
  const pfadKurz = (p) => { const h = require('node:os').homedir(); return p && h && p.toLowerCase().startsWith(h.toLowerCase()) ? `%USERPROFILE%${p.slice(h.length)}` : p }
  function verfahrenStand() {
    const d = ctx.datenLaden()
    const e = belegArchiv.eintraege()
    const st = archivStatusDaten()
    let shopifyEin = false
    try { const z = shopifyZugang(); shopifyEin = !!(z?.token && z?.shop) } catch { /* nicht eingerichtet */ }
    return {
      jetzt: new Date().toISOString(), umgebung: host.art, windows: host.windows,
      firma: { ...angaben.standardwerte(), ...(d.angaben || {}) },
      versionen: { plugin: require('./plugin.json').version, parser: VERSION, node: process.versions.node, electron: process.versions.electron || null },
      archiv: { pfad: pfadKurz(belegArchiv.WURZEL), eintraege: e.length, erster: e[0]?.zeit || null, arten: jahresarchiv.anzahlJeArt(e) },
      wartung: d.wartung || null,
      usb: { letzteSicherung: st.usb.letzteSicherung, laufwerk: st.usb.laufwerk, schluesselBestaetigt: !!st.schluessel.bestaetigt, wiederherstellungstest: d.usb?.letzterWiederherstellungstest || null },
      datenbank: { zustand: !db ? 'keine Datenbank eingerichtet' : db.zustand().zustand === 'bereit' ? 'verbunden' : 'nicht verbunden' },
      quellen: { shopify: { eingerichtet: shopifyEin, quelle: host.zugaengeEinstellbar ? 'eigen' : 'hermes' }, shirtigo: !!shirtigo.verbunden(), belege: lesen().length },
      dienste: zeitstempel.DIENSTE.map((x) => x.name),
      pruefwert: e.at(-1)?.hash || '',
      regelcheck: Object.fromEntries(e.filter((x) => x.meta?.vorgang === 'regelcheck').map((x) => [String(x.meta.jahr), x.meta.am]))
    }
  }
  const verfahrenZustand = (d) => { const e = verfahren.ergaenzungenNormalisieren(d.verfahren?.ergaenzungen); const b = d.verfahren?.bestaetigung; return { bestaetigt: !!b, gueltig: !!b && b.hash === verfahren.ergaenzungenHash(e), fehlend: verfahren.fehlend(e).length } }
  const verfahrenText = () => { const v = ctx.datenLaden().verfahren || {}; return verfahren.verfahrensdokumentation({ stand: verfahrenStand(), ergaenzungen: v.ergaenzungen, bestaetigung: v.bestaetigung }) }
  const verfahrenAblegen = (text, anlass) => { const zeit = new Date().toISOString(); return belegArchiv.ablegen(Buffer.from(text, 'utf8'), { art: 'protokoll', jahr: Number(heuteBerlin().slice(0, 4)), name: `Verfahrensdokumentation ${zeit.slice(0, 19).replace(/:/g, '-')}.md`, meta: { vorgang: 'verfahrensdokumentation', anlass, fassung: verfahren.FASSUNG } }) }
  async function textSpeichernUnter(titel, name, text) {
    const gewaehlt = await host.speichernUnter({ titel, name, filter: { name: 'Markdown-Text', extensions: ['md'] } })
    if (!gewaehlt) return { abgebrochen: true }
    const ziel = path.resolve(gewaehlt)
    if (innerhalb(ziel, belegArchiv.WURZEL)) throw new Error('Bitte nicht in das Belegarchiv speichern.')
    fs.writeFileSync(ziel, text, 'utf8')
    return { datei: ziel }
  }
  ctx.bereitstellen('verfahrenLaden', () => {
    const v = ctx.datenLaden().verfahren || {}
    const e = verfahren.ergaenzungenNormalisieren(v.ergaenzungen)
    return { felder: verfahren.ERGAENZUNGEN, werte: e, fehlend: verfahren.fehlend(e), bestaetigung: v.bestaetigung || null, bestaetigtGueltig: !!v.bestaetigung && v.bestaetigung.hash === verfahren.ergaenzungenHash(e), text: verfahrenText() }
  })
  ctx.bereitstellen('verfahrenSpeichern', (werte) => {
    const e = verfahren.ergaenzungenNormalisieren(werte)
    const d = ctx.datenLaden()
    ctx.datenSpeichern({ ...d, verfahren: { ...(d.verfahren || {}), ergaenzungen: e } })
    return { fehlend: verfahren.fehlend(e) }
  })
  ctx.bereitstellen('verfahrenBestaetigen', () => {
    const d = ctx.datenLaden()
    const e = verfahren.ergaenzungenNormalisieren(d.verfahren?.ergaenzungen)
    const bestaetigung = { zeit: new Date().toISOString(), hash: verfahren.ergaenzungenHash(e) }
    ctx.datenSpeichern({ ...d, verfahren: { ...(d.verfahren || {}), ergaenzungen: e, bestaetigung } })
    return { bestaetigung, datei: verfahrenAblegen(verfahrenText(), 'bestaetigung').datei, fehlend: verfahren.fehlend(e) }
  })
  ctx.bereitstellen('verfahrenSpeichernUnter', () => textSpeichernUnter('Verfahrensdokumentation speichern', `Verfahrensdokumentation-${heuteBerlin()}.md`, verfahrenText()))

  // ---------- Datenschutz (7.3) ----------
  // Kundendaten verlassen den Hauptprozess nur als Suchtreffer für die eigene Oberfläche oder als Auskunft-ZIP (nie an Hermes/KI).
  const zahlungsarten = () => [...new Set(bestellungen.eintraege().flatMap((x) => String(x.rechnung?.zahlung?.art || '').split(',').map((t) => t.trim())).filter(Boolean))].sort()
  const verzeichnisText = () => dsgvo.verzeichnis({ firma: { ...angaben.standardwerte(), ...(ctx.datenLaden().angaben || {}) }, zahlungsarten: zahlungsarten(), shirtigo: shirtigoB.eintraege().length > 0 || !!shirtigo.verbunden() })
  const anfragen = () => ctx.datenLaden().datenschutz?.anfragen || []
  ctx.bereitstellen('datenschutzLaden', () => ({ verzeichnis: verzeichnisText(), anfragen: anfragen() }))
  ctx.bereitstellen('datenschutzVerzeichnisSpeichern', () => textSpeichernUnter('Verzeichnis der Verarbeitungstätigkeiten speichern', `Verarbeitungsverzeichnis-${heuteBerlin()}.md`, verzeichnisText()))
  ctx.bereitstellen('datenschutzSuchen', (begriff) => {
    const shop = bestellungen.eintraege()
    return dsgvo.suchen(shop, begriff).map((t) => ({ ...t, gesperrtBis: dsgvo.gesperrtBis({ archiv: belegArchiv, shop, nrs: [t.nr] }) }))
  })
  const nummernPruefen = (nrs) => {
    const n = [...new Set((Array.isArray(nrs) ? nrs : []).map(String))]
    if (!n.length || n.some((x) => !/^[\w-]{1,30}$/.test(x))) throw new Error('Bitte Bestellungen auswählen.')
    return n
  }
  const anfrageMerken = (eintrag) => { const d = ctx.datenLaden(); const ds = d.datenschutz || {}; ctx.datenSpeichern({ ...d, datenschutz: { ...ds, anfragen: [...(ds.anfragen || []), eintrag] } }) }
  ctx.bereitstellen('datenschutzAuskunft', async ({ nrs } = {}) => {
    nrs = nummernPruefen(nrs)
    const d = ctx.datenLaden()
    const erg = dsgvo.auskunft({ archiv: belegArchiv, shop: bestellungen.eintraege(), shirtigo: shirtigoB.eintraege(), nrs, firma: { ...angaben.standardwerte(), ...(d.angaben || {}) } })
    const gewaehlt = await host.speichernUnter({ titel: 'Auskunft speichern', name: `Auskunft-${heuteBerlin()}.zip`, filter: { name: 'ZIP-Archiv', extensions: ['zip'] } })
    if (!gewaehlt) return { abgebrochen: true }
    const ziel = path.resolve(gewaehlt)
    if (innerhalb(ziel, belegArchiv.WURZEL)) throw new Error('Bitte nicht in das Belegarchiv speichern.')
    const zip = await jahresarchiv.schreiben(erg.dateien, ziel)
    anfrageMerken({ art: 'auskunft', zeit: new Date().toISOString(), bestellungen: nrs, name: erg.name, sha256: zip.sha256 })
    return { ...zip, dateien: erg.dateien.length, fehler: erg.fehler }
  })
  // Löschanfrage: nicht löschen, sondern Sperre bis Fristende vermerken (Art. 17 Abs. 3 lit. b, Art. 18 DSGVO)
  ctx.bereitstellen('datenschutzSperren', ({ nrs, eingang } = {}) => {
    nrs = nummernPruefen(nrs)
    eingang = String(eingang || heuteBerlin())
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eingang)) throw new Error('Ungültiges Eingangsdatum.')
    const shop = bestellungen.eintraege()
    const name = shop.find((x) => nrs.includes(String(x.rechnung?.referenz)))?.rechnung?.empfaenger?.name || ''
    const eintrag = { art: 'loeschung', zeit: new Date().toISOString(), eingang, bestellungen: nrs, name, gesperrtBis: dsgvo.gesperrtBis({ archiv: belegArchiv, shop, nrs }) }
    anfrageMerken(eintrag)
    return eintrag
  })

  function archivStatusDaten() {
    const d = ctx.datenLaden()
    const w = d.wartung || null
    const u = d.usb || {}
    const t = u.letzterWiederherstellungstest || null
    let schl
    try { schl = usb().status() } catch (f) { schl = { fehler: f.message } }
    return {
      archiv: { pfad: belegArchiv.WURZEL, eintraege: belegArchiv.eintraege().length },
      pruefung: w ? { ...w, tageSeit: tageSeit(w.zeit), faellig: tageSeit(w.zeit) >= 7 } : { faellig: true },
      usb: { letzteSicherung: u.letzteSicherung || null, tageSeit: tageSeit(u.letzteSicherung), laufwerk: u.laufwerk || null, letztesErgebnis: u.letztesErgebnis || null },
      wiederherstellungstest: t ? { ...t, tageSeit: tageSeit(t.zeit), faellig: !t.ok || tageSeit(t.zeit) >= 365 } : { faellig: true },
      schluessel: { bestaetigt: !!schl.bestaetigt, kennung: schl.kennung || null, ...(schl.fehler ? { fehler: schl.fehler } : {}) }
    }
  }
  ctx.bereitstellen('usbStatus', () => {
    const s = usbStand()
    const tage = s.letzteSicherung ? Math.floor((Date.now() - Date.parse(s.letzteSicherung)) / 86_400_000) : null
    return { ...s, tageSeit: tage, erinnern: tage !== null && tage >= 7 }
  })

  // ---------- Dashboard „Übersicht“ (Schritt 4.5, Plan 7.7/8.4) ----------
  // EÜR je Jahr und Aufgaben & Fristen aus den vorhandenen Bausteinen (Einnahmen, Ausgaben, § 13b, Archiv-Status, Angaben).
  // Erledigte Jahresaufgaben unter „aufgabenErledigt“, bereits gemeldete unter „aufgabenGemeldet“ (je Tag einmal).
  // Jahre mit Pflicht zur Umsatzsteuer-Jahreserklärung: § 13b-Steuer oder ein Regelbesteuerungs-Zeitraum laut „Meine Angaben“
  function ustJahreVon(d, monate) {
    const regel = new Set()
    for (const z of (d.angaben || {}).steuerzeitraeume || []) {
      if (z.art !== 'regel') continue
      const von = Number(String(z.von || '2000').slice(0, 4))
      const bis = Number(String(z.bis || heuteBerlin()).slice(0, 4))
      for (let j = von; j <= bis; j++) regel.add(j)
    }
    return steuer.ustJahre(monate, [...regel])
  }
  function dashboardDaten(heute) {
    const d = ctx.datenLaden()
    const einnahmen = alleEinnahmen()
    const ausgaben = [...shirtigoB.eintraege().map((e) => e.rechnung), ...bestellungen.gebuehrenEintraege().map((e) => e.rechnung), ...sichtbar().map((x) => x.rechnung).filter((r) => r && r.art !== 'einnahme')]
    const p13b = p13bDaten(heute)
    const { waechter, statusPasst } = waechterFuer(einnahmen, heute)
    let archivStand = null
    try { archivStand = archivStatusDaten() } catch { /* Archiv nicht lesbar: dann ohne Archiv-Aufgaben */ }
    const liste = uebersicht.aufgaben({
      heute, pflichtFehlen: profil.pruefung().fehlend, belegeWartend: bestellungen.eintraege().filter((e) => !e.beleg).length,
      archiv: archivStand, p13bMonate: p13b.monate, waechter, statusPasst, erledigt: d.aufgabenErledigt || {}, verfahren: verfahrenZustand(d), ustJahre: ustJahreVon(d, p13b.monate)
    })
    return { heute, aufgaben: liste, erledigt: d.aufgabenErledigt || {}, euer: uebersicht.euerJahre({ einnahmen, ausgaben, p13bMonate: p13b.monate }) }
  }
  ctx.bereitstellen('dashboard', (optionen = {}) => dashboardDaten(heuteAus(optionen)))
  ctx.bereitstellen('aufgabeErledigt', (schluessel, am) => {
    if (!/^(euer|konto|regelcheck|ustje)-\d{4}$/.test(String(schluessel || ''))) throw new Error('Diese Aufgabe kann nicht abgehakt werden.')
    if (am != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(am))) throw new Error('Ungültiges Datum.')
    const d = ctx.datenLaden()
    const alle = { ...(d.aufgabenErledigt || {}) }
    if (am) alle[schluessel] = String(am)
    else delete alle[schluessel]
    // Regel-Check (8.5): Abhaken wird im Archiv protokolliert (Zurücknehmen löscht das Protokoll nicht, das Archiv ist nur anfügend)
    if (am && schluessel.startsWith('regelcheck-')) {
      const jahr = Number(schluessel.slice(11))
      const zeit = new Date().toISOString()
      belegArchiv.ablegen(Buffer.from(JSON.stringify({ vorgang: 'Jährlicher Regel-Check (Plan 8.5)', jahr, am, zeit, punkte: uebersicht.REGELCHECK, version: require('./plugin.json').version }, null, 2), 'utf8'), { art: 'protokoll', jahr, name: `Regel-Check ${jahr} ${zeit.slice(0, 19).replace(/:/g, '-')}.json`, meta: { vorgang: 'regelcheck', jahr, am } })
    }
    ctx.datenSpeichern({ ...d, aufgabenErledigt: alle })
    return alle[schluessel] || null
  })
  // Rote Aufgaben für die Vendo-Benachrichtigung: je Aufgabe höchstens einmal am Tag
  ctx.bereitstellen('aufgabenMelden', (optionen = {}) => {
    const heute = heuteAus(optionen)
    const { aufgaben: liste } = dashboardDaten(heute)
    const d = ctx.datenLaden()
    const gemeldet = d.aufgabenGemeldet || {}
    const neu = liste.filter((a) => a.stufe === 'rot' && gemeldet[a.schluessel] !== heute)
    if (neu.length) {
      const aktuell = Object.fromEntries(Object.entries(gemeldet).filter(([k]) => liste.some((a) => a.schluessel === k))) // erledigte vergessen
      for (const a of neu) aktuell[a.schluessel] = heute
      ctx.datenSpeichern({ ...ctx.datenLaden(), aufgabenGemeldet: aktuell })
    }
    return neu
  })

  // ---------- Umfeld und Zugänge (host.js) ----------
  // Was die Oberfläche über das Umfeld wissen darf: keine Pfade, keine Geheimnisse
  ctx.bereitstellen('umgebung', () => ({ art: host.art, windows: host.windows, zugaengeEinstellbar: !!host.zugaengeEinstellbar, tresor: { name: host.tresor.name, verfuegbar: !!host.tresor.verfuegbar() } }))
  ctx.bereitstellen('zugaengeLaden', () => {
    let shopify = { quelle: host.zugaengeEinstellbar ? 'eigen' : 'hermes', eingerichtet: false, shop: null }
    try { const z = shopifyZugang(); shopify = { ...shopify, eingerichtet: !!(z?.token && z?.shop), shop: z?.shop || null } } catch (f) { shopify.fehler = f.message }
    return { einstellbar: !!host.zugaengeEinstellbar, shopify, shirtigo: { verbunden: !!shirtigo.verbunden() } }
  })
  // Eigenständig: Shop-Adresse und Admin-API-Zugriffstoken eintragen (leer = entfernen). In Vendo kommt der Zugang aus Hermes.
  ctx.bereitstellen('shopifyZugangSpeichern', ({ shop, token } = {}) => {
    if (!host.zugaengeEinstellbar) throw new Error('In Vendo kommt der Shopify-Zugang aus Hermes (System-Tab).')
    shop = String(shop || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    token = String(token || '').trim()
    const d = ctx.datenLaden()
    const rest = { ...(d.zugaenge || {}) }
    if (!shop && !token) { delete rest.shopify; ctx.datenSpeichern({ ...d, zugaenge: rest }); return { eingerichtet: false } }
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new Error('Bitte die Shop-Adresse wie mein-shop.myshopify.com angeben.')
    if (!/^shp(at|ca|pa)_[A-Za-z0-9]{20,}$/.test(token)) throw new Error('Bitte ein Admin-API-Zugriffstoken (shpat_…) angeben.')
    rest.shopify = tresor().verschluesseln(JSON.stringify({ shop, token })).toString('base64')
    ctx.datenSpeichern({ ...d, zugaenge: rest })
    return { eingerichtet: true, shop }
  })

  // ---------- Shirtigo (MCP) ----------
  ctx.bereitstellen('shirtigoVerbinden', (token) => shirtigo.verbinden(token, path.join(ORDNER, '..', 'shirtigo-werkzeuge.json')))
  ctx.bereitstellen('shirtigoStatus', () => shirtigo.verbunden())
  ctx.bereitstellen('shirtigoProbe', () => shirtigo.probe(path.join(ORDNER, '..', 'shirtigo-probe.json')))
  ctx.bereitstellen('shirtigoFortschritt', () => shirtigoB.status())
  ctx.bereitstellen('shirtigoSyncen', () => shirtigo.verbunden() ? Promise.resolve(shirtigoB.abgleichen()).finally(() => indexBald()) : null)

  // Kein automatischer Abgleich: Shopify und Shirtigo werden nur über den Knopf „Synchronisieren“ abgefragt.

  // ---------- Datenbank (Plan 11.2, Phase D): abgeleiteter Index in PostgreSQL ----------
  // Maßgeblich bleibt das Archiv. Nach jeder Änderung (gebündelt) und beim Start wird der Index neu aufgebaut, falls sich
  // die Quellen geändert haben; die wöchentliche Prüfung vergleicht ihn Zeile für Zeile mit einem frischen Aufbau.
  function indexAktualisieren({ erzwingen = false } = {}) {
    if (!db?.bereit()) return Promise.resolve({ ok: false, grund: db ? db.zustand().meldung : 'Keine Datenbank.' })
    if (bestellungen.beschaeftigt() || shirtigoB.beschaeftigt()) { indexBald(); return Promise.resolve({ ok: false, grund: 'Abgleich läuft, später.' }) }
    indexLaeuft ||= (async () => {
      await dbIndex.einrichten(db)
      const quelle = indexQuelle()
      const alt = await dbIndex.stand(db)
      if (!erzwingen && alt?.quelle === quelle) return { ok: true, neu: false, ...alt }
      const anzahl = await dbIndex.aufbauen(db, dbIndex.zeilenBauen(indexQuellen()), quelle)
      return { ok: true, neu: true, anzahl }
    })().finally(() => { indexLaeuft = null })
    return indexLaeuft
  }
  async function indexGegenprobe() {
    if (!db?.bereit()) return null
    try {
      await indexAktualisieren()
      const erg = await dbIndex.pruefen(db, dbIndex.zeilenBauen(indexQuellen()))
      if (!erg.ok) await indexAktualisieren({ erzwingen: true }) // Index ist abgeleitet: nach der Meldung neu aufbauen
      return { ...erg, neuAufgebaut: !erg.ok }
    } catch (f) { return { ok: false, zeit: new Date().toISOString(), fehler: f.message } }
  }
  ctx.bereitstellen('datenbankStatus', async () => ({
    zustand: db ? db.zustand() : { zustand: 'aus', meldung: 'Keine Datenbank.' },
    index: db?.bereit() ? await dbIndex.stand(db).catch(() => null) : null,
    pruefung: ctx.datenLaden().wartung?.datenbank || null
  }))
  ctx.bereitstellen('datenbankAufbauen', () => indexAktualisieren({ erzwingen: true }))
  ctx.bereitstellen('datenbankJahre', async () => (db?.bereit() ? dbIndex.jahresSummen(db) : null))
  if (db) {
    const roh = ctx.datenSpeichern // jede gespeicherte Änderung (Belege, § 13b, Angaben, Abgleichstand) stößt den Index an
    ctx.datenSpeichern = (d) => { const r = roh(d); indexBald(); return r }
    db.beiBereit(() => { setTimeout(indexBald, 10_000) })
  }
}