'use strict'
// Verfahrensdokumentation (GoBD Rz. 151 ff.) und Jahresnachweis (Plan 5c Ebene 4, Schritt 7.2 / E.4).
// Aufbau nach dem Muster der AWV für kleine Unternehmen: allgemeine Beschreibung, Anwenderdokumentation, technische
// Systemdokumentation, Betriebsdokumentation, internes Kontrollsystem, dazu Datenzugriff und Aufbewahrung.
// Vorbild für die Idee „automatisch aus dem echten Stand erzeugen, Fehlendes markieren“: „haben“ (nur Doku, kein Code).
//
// Alles, was Vendo selbst weiß, kommt aus `stand` (haupt.js baut ihn aus Einstellungen, Archiv, Wartung, USB, Datenbank).
// Was Vendo nicht wissen kann, ergänzt der Nutzer (ERGAENZUNGEN); fehlt etwas, steht „Fehlt: …“ im Text.
// Keine Geheimnisse, keine persönlichen Angaben (Steuer-ID, Religion usw.), keine Kundendaten.

const crypto = require('node:crypto')
const { TABELLEN } = require('./jahresarchiv')

const FASSUNG = 1 // Aufbau der Dokumentation; ändert sich der Aufbau, muss neu bestätigt werden

const ERGAENZUNGEN = [
  { feld: 'verantwortlich', label: 'Verantwortlich für Buchführung und Archiv', hilfe: 'Name, Rolle (z. B. Inhaber, erledigt alles selbst)' },
  { feld: 'vertretung', label: 'Vertretung bei Abwesenheit', hilfe: 'z. B. „keine“ oder Name der Person mit Zugang' },
  { feld: 'steuerberatung', label: 'Steuerberatung', hilfe: 'z. B. „keine, Erklärung selbst über Mein ELSTER“' },
  { feld: 'rechner', label: 'Rechner und Standort', hilfe: 'z. B. eigener Windows-PC im Büro zu Hause, Benutzerkonto mit Passwort' },
  { feld: 'zugriff', label: 'Wer hat Zugang zum Rechner und zu Vendo?', hilfe: 'z. B. nur der Inhaber' },
  { feld: 'papier', label: 'Umgang mit Papierbelegen', hilfe: 'z. B. „werden eingescannt, Original im Ordner Belege JJJJ“' },
  { feld: 'stickOrt', label: 'Aufbewahrungsort des USB-Sicherungssticks', hilfe: 'getrennt vom Rechner' },
  { feld: 'schluesselOrt', label: 'Aufbewahrungsort des Wiederherstellungsblatts', hilfe: 'getrennt vom Stick' },
  { feld: 'sonstiges', label: 'Weitere Ergänzungen', typ: 'textarea' }
]
const MAX_LAENGE = 2000

function ergaenzungenNormalisieren(roh = {}) {
  const aus = {}
  for (const { feld } of ERGAENZUNGEN) {
    const w = String(roh?.[feld] ?? '').replace(/\r\n/g, '\n').trim()
    if (w.length > MAX_LAENGE) throw new Error(`Zu lang: ${feld} (höchstens ${MAX_LAENGE} Zeichen).`)
    aus[feld] = w
  }
  return aus
}
// Prüfwert der Ergänzungen: ändert er sich nach der Bestätigung, muss neu bestätigt werden
const ergaenzungenHash = (e) => crypto.createHash('sha256').update(JSON.stringify({ FASSUNG, e: ergaenzungenNormalisieren(e) })).digest('hex')
const fehlend = (e) => ERGAENZUNGEN.filter((f) => f.feld !== 'sonstiges' && !String(e?.[f.feld] || '').trim()).map((f) => f.label)

// ---------- Hilfen ----------
const tagDe = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(String(iso || '')) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '–')
const zeitDe = (iso) => (iso ? `${tagDe(iso)}, ${new Date(iso).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })} Uhr` : '–')
const euro = (n) => `${Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
const zahl = (n) => Number(n || 0).toLocaleString('de-DE')
const oder = (w, fehlt) => (String(w || '').trim() ? String(w).trim() : `**Fehlt: ${fehlt}**`)
const RECHTSFORM = { einzelunternehmen: 'Einzelunternehmen', gmbh: 'GmbH', ug: 'UG (haftungsbeschränkt)' }
const ARTEN = {
  umsatzbeleg: 'Umsatzbelege (PDF)', 'shopify-original': 'Shopify-Originaldatensätze (JSON)', 'shopify-zahlungen': 'Shopify-Zahlungsnachweise (JSON)', 'shopify-gebuehren': 'Gebühren von Shopify Payments (JSON)',
  'shirtigo-original': 'Shirtigo-Originaldatensätze (JSON)', eingang: 'Eingangsrechnungen (PDF, XML)', siegel: 'Siegel der Hash-Kette',
  zeitstempel: 'Zeitstempel (RFC 3161)', zertifikat: 'Zertifikate der Zeitstempeldienste', pruefbericht: 'Prüfberichte', protokoll: 'Protokolle'
}
const artenListe = (arten = {}) => Object.entries(arten).sort((a, b) => b[1] - a[1]).map(([a, n]) => `- ${ARTEN[a] || a}: ${zahl(n)}`).join('\n') || '- (noch keine Einträge)'
const steuerZeilen = (zr = []) => (zr.length ? zr.map((z) => `- ${z.von ? tagDe(z.von) : 'seit Beginn'} bis ${z.bis ? tagDe(z.bis) : 'heute'}: ${z.art === 'regel' ? `Regelbesteuerung (${z.satz ?? 19} %)` : 'Kleinunternehmer (§ 19 UStG)'}`).join('\n') : '- **Fehlt: Steuerstatus je Zeitraum (Meine Angaben → Firmendaten)**')

// ---------- Verfahrensdokumentation ----------
function verfahrensdokumentation({ stand = {}, ergaenzungen = {}, bestaetigung = null } = {}) {
  const f = stand.firma || {}
  const e = ergaenzungenNormalisieren(ergaenzungen)
  const a = stand.archiv || {}
  const w = stand.wartung || null
  const s = w?.siegel || null
  const u = stand.usb || {}
  const q = stand.quellen || {}
  const v = stand.versionen || {}
  const db = stand.datenbank || {}
  const fehlt = fehlend(e)
  const bestaetigtGueltig = bestaetigung && bestaetigung.hash === ergaenzungenHash(e)
  const vendo = stand.umgebung === 'eigenstaendig' ? 'die Buchhaltung (eigenständig im Browser, ohne Vendo)' : 'Vendo mit dem Plugin Buchhaltung'
  const zeilen = [
    `# Verfahrensdokumentation Buchführung und Belegarchiv – ${f.firmenname || 'Unternehmen'}`, '',
    `Stand: ${zeitDe(stand.jetzt)}. Automatisch erzeugt aus dem aktuellen Aufbau (Plugin Buchhaltung ${v.plugin || '–'}, Fassung ${FASSUNG}).`,
    fehlt.length ? `Zustand: **unvollständig** – ${fehlt.length} Angabe(n) fehlen (Meine Angaben → Verfahrensdokumentation).` : 'Zustand: vollständig ausgefüllt.',
    bestaetigtGueltig ? `Durchgesehen und bestätigt am ${zeitDe(bestaetigung.zeit)}.` : (bestaetigung ? '**Seit der letzten Bestätigung geändert – bitte erneut durchsehen und bestätigen.**' : '**Noch nicht durchgesehen und bestätigt.**'),
    '', 'Gliederung nach dem Muster der AWV für kleine Unternehmen (GoBD Rz. 151–155). Diese Dokumentation beschreibt das Verfahren; sie ersetzt keine Steuerberatung.', '',
    '## 1. Allgemeine Beschreibung', '',
    `- Unternehmen: ${oder(f.firmenname, 'Firmenname')}, Inhaber/in ${oder(f.inhaber, 'Name')}`,
    `- Anschrift: ${oder([f.strasse, [f.plz, f.ort].filter(Boolean).join(' '), f.land].filter(Boolean).join(', '), 'Anschrift')}`,
    `- Rechtsform: ${RECHTSFORM[f.rechtsform] || oder('', 'Rechtsform')}; Tätigkeit: ${oder(f.taetigkeit, 'Art des Betriebs')}`,
    `- Steuernummer: ${oder(f.steuernummer, 'Steuernummer')}, Finanzamt: ${oder(f.finanzamt, 'Finanzamt')}`,
    '- Gewinnermittlung: Einnahmen-Überschuss-Rechnung (§ 4 Abs. 3 EStG), Zufluss-/Abflussprinzip; Einnahmen zählen am Zahlungstag.',
    `- Versteuerung: ${f.versteuerung === 'soll' ? 'Soll' : 'Ist'}; Kontenrahmen ${f.kontenrahmen || 'SKR03'} (nur zur Orientierung, keine doppelte Buchführung).`,
    '- Steuerstatus je Zeitraum:', steuerZeilen(f.steuerzeitraeume),
    `- Geschäftsmodell: Online-Shop über Shopify; Herstellung und Versand der Ware über Shirtigo (Print-on-Demand).`,
    `- Verantwortlich: ${oder(e.verantwortlich, 'Verantwortliche Person')}; Vertretung: ${oder(e.vertretung, 'Vertretung')}`,
    `- Steuerberatung: ${oder(e.steuerberatung, 'Angabe zur Steuerberatung')}`, '',
    '## 2. Anwenderdokumentation (Belegfluss)', '',
    '### 2.1 Ausgangsbelege: Shop-Bestellungen (Shopify)',
    `- Abruf: Auf Knopfdruck „Synchronisieren“ liest ${vendo} die Bestellungen über die Shopify-Admin-Schnittstelle (nur lesend). Zugang: ${q.shopify?.eingerichtet ? (q.shopify.quelle === 'hermes' ? 'eingerichtet (Zugangsdaten aus Hermes, nicht in der Buchhaltung gespeichert)' : 'eingerichtet (verschlüsselt gespeichert)') : 'derzeit nicht eingerichtet'}.`,
    '- Jede Bestellung wird als Originaldatensatz (JSON) unverändert ins Belegarchiv gelegt. Ändert sich eine Bestellung (Erstattung, Storno), entsteht eine neue Version; alte Versionen bleiben.',
    '- Zahlungsnachweise (Transaktionen mit Tag und Betrag) werden als eigener Datensatz archiviert; maßgeblich für den Zufluss ist der Zahlungstag.',
    '- Gebühren von Shopify Payments liefert Shopify je Zahlung; sie werden als eigener Datensatz archiviert und als Ausgabe am Zahlungstag erfasst (als steuerfreie Zahlungsdienstleistung ohne § 13b). Gebühren anderer Zahlungsanbieter und die Shopify-Rechnungen (Abo, Apps, Transaktionsgebühren) kommen als PDF über den Belegeingang.',
    '- Aus dem Originaldatensatz erzeugt das Programm einen Umsatzbeleg (PDF) mit fortlaufendem Bezug zur Bestellnummer, Ausstellungsdatum und Steuerhinweis (§ 19 UStG bzw. ausgewiesene Umsatzsteuer je Zeitraum).',
    '- Korrekturen: Belege werden nie überschrieben. Eine Neufassung (z. B. geänderter Steuerausweis) wird als neue Datei mit Verweis auf die ersetzte Fassung abgelegt und im Archiv protokolliert.',
    '', '### 2.2 Eingangsbelege: Shirtigo',
    `- Abruf über die Shirtigo-Schnittstelle (${q.shirtigo ? 'verbunden' : 'derzeit nicht verbunden'}): Auftragsdaten (JSON) und Rechnungs-PDF werden unverändert archiviert. Die Zuordnung zur Shop-Bestellung erfolgt über die Shopify-Bestellnummer im Auftrag.`,
    '', '### 2.3 Weitere Belege (eingelesene PDFs)',
    `- Rechnungen anderer Lieferanten werden als PDF eingelesen (Texterkennung, Prüfung der Beträge durch den Nutzer) und unverändert archiviert; derzeit ${zahl(q.belege)} eingelesene Belege. Ausblenden statt Löschen: ein ausgeblendeter Beleg bleibt im Archiv.`,
    '- § 13b UStG: Leistungen ausländischer Anbieter werden erkannt, je Anbieter eingestuft und monatlich zusammengefasst; die Anmeldung wird abgehakt.',
    `- Papierbelege: ${oder(e.papier, 'Umgang mit Papierbelegen')}`,
    '', '### 2.4 Auswertungen',
    '- Übersicht mit EÜR-Kennzahlen je Jahr, Kleinunternehmer-Grenzen (§ 19 Abs. 1 UStG), Aufgaben und Fristen, ELSTER-Übersicht zum Abtippen. Es wird nichts automatisch an das Finanzamt übermittelt.',
    '- Jahresarchiv als ZIP je Jahr: alle Belege unverändert, Tabellen (CSV), EÜR-Kennzahlen, Auszug und vollständige Hash-Kette, Siegel, Prüfsummen, diese Dokumentation und der Jahresnachweis.',
    '', '## 3. Technische Systemdokumentation', '',
    `- Software: ${vendo}; Plugin Buchhaltung ${v.plugin || '–'}, Belegleser ${v.parser || '–'}, Node.js ${v.node || '–'}${v.electron ? `, Electron ${v.electron}` : ''}. Quelloffen (AGPL-3.0-or-later), Programmstand nachvollziehbar über die Versionsverwaltung.`,
    `- Belegarchiv: eigener Ordner außerhalb des Programmordners (${a.pfad || '–'}), Dateien nach Jahr, SHA-256-Prüfsumme im Dateinamen. ${zahl(a.eintraege)} Einträge, erster vom ${tagDe(a.erster)}.`,
    artenListe(a.arten),
    '- Unveränderbarkeit (GoBD Rz. 58 ff.): Jede abgelegte Datei erhält einen Eintrag im Index (index.jsonl) mit Zeit, Art, Prüfsumme und dem Hash des vorigen Eintrags (Hash-Kette). Eine nachträgliche Änderung einer Datei oder eines Eintrags fällt bei der Prüfung auf. Löschen ist im Programm nicht vorgesehen.',
    `- Dateischutz: ${stand.windows ? 'Windows-Zugriffsregeln (NTFS) verbieten für das eigene Konto Löschen und Ändern der Archivdateien. Das ist ein Schutz gegen Versehen; den Nachweis der Unveränderbarkeit führen Hash-Kette und Zeitstempel.' : 'ohne Windows-Zugriffsregeln (anderes Betriebssystem); den Nachweis führen Hash-Kette und Zeitstempel.'}`,
    `- Siegel: Der Kopf der Hash-Kette wird mit qualifizierten bzw. einfachen Zeitstempeln nach RFC 3161 versiegelt (${(stand.dienste || []).join(', ') || '–'}); Zeitstempel und Zertifikate liegen im Archiv. ${s ? `Bisher ${zahl(s.anzahl)} Siegel, zuletzt ${zeitDe(s.zuletzt)}; seitdem ${zahl(s.nochNichtVersiegelt)} Einträge noch unversiegelt.` : 'Stand der Siegel: noch nicht geprüft.'}`,
    `- Datenbank: PostgreSQL (lokal) enthält die veränderlichen Programmdaten (Einstellungen, Abgleichstand) und einen aus dem Archiv abgeleiteten Index für Auswertungen. Maßgeblich ist immer das Archiv; der Index wird wöchentlich gegen das Archiv geprüft und bei Abweichung neu aufgebaut. Derzeit: ${db.zustand || 'unbekannt'}.`,
    '- Kundendaten und Rechnungsdaten werden nicht an Hermes (KI-Assistent in Vendo) oder an KI-Anbieter übergeben. Die einzige Ausnahme ist eine anonyme Zusammenfassung „Ort und Anzahl Bestellungen“ für eine Kartenansicht.',
    '', '## 4. Betriebsdokumentation', '',
    `- Rechner: ${oder(e.rechner, 'Rechner und Standort')}`,
    `- Zugriff: ${oder(e.zugriff, 'Wer hat Zugang')}. Zugangsdaten zu Shopify und Shirtigo liegen verschlüsselt (Windows-Datenschutz bzw. Passwort-Tresor), nie im Klartext und nie in Protokollen.`,
    `- Datensicherung: verschlüsselt (AES-256-GCM) und inkrementell auf einen USB-Stick; alle Sicherungsstände bleiben erhalten. Letzte Sicherung: ${zeitDe(u.letzteSicherung)}${u.laufwerk ? ` (${u.laufwerk})` : ''}. Wiederherstellungsschlüssel ${u.schluesselBestaetigt ? 'erzeugt und als gedruckt bestätigt' : '**noch nicht bestätigt**'}.`,
    `- Aufbewahrung Stick: ${oder(e.stickOrt, 'Ort des Sicherungssticks')}; Wiederherstellungsblatt: ${oder(e.schluesselOrt, 'Ort des Wiederherstellungsblatts')}`,
    `- Wiederherstellungstest: wird jährlich in einen leeren Ordner durchgeführt und als Prüfbericht archiviert. Letzter Test: ${u.wiederherstellungstest ? `${zeitDe(u.wiederherstellungstest.zeit)}, ${u.wiederherstellungstest.ok ? 'erfolgreich' : '**fehlgeschlagen**'}` : '**noch keiner**'}.`,
    '- Programmänderungen: Neue Programmstände werden vor dem Einsatz mit automatisierten Tests (synthetische Daten) geprüft; Änderungen am Belegaufbau werden als Neufassung protokolliert, nicht rückwirkend.',
    '', '## 5. Internes Kontrollsystem', '',
    `- Wöchentliche Prüfung aller Archivdateien gegen Prüfsummen und Hash-Kette, der Siegel und der Datenbank. Letzte Prüfung: ${w?.zeit ? `${zeitDe(w.zeit)}, ${w.ok ? 'ohne Befund' : '**mit Befund**'}${w.archiv?.geprueft != null ? ` (${zahl(w.archiv.geprueft)} Dateien)` : ''}` : '**noch keine**'}.`,
    '- Jede eingelesene Rechnung wird vor der Übernahme angezeigt; Summen werden gegen die Positionen geprüft, Abweichungen als Hinweis markiert.',
    `- Jährlicher Regel-Check (Januar): Gesetzesstand der Regeln im Programm prüfen; jeder Check wird im Archiv protokolliert. ${Object.keys(stand.regelcheck || {}).length ? `Zuletzt: ${Object.entries(stand.regelcheck).sort().map(([j, am]) => `${j} am ${tagDe(am)}`).at(-1)}.` : '**Noch keiner protokolliert.**'}`,
    '- Grenzwert-Wächter für § 19 UStG (25.000 € Vorjahr, 100.000 € laufendes Jahr) und EU-Fernverkauf (10.000 €), Erinnerungen an Fristen und Sicherungen.',
    `- Prüfwert (Kopf der Hash-Kette) zum Abschreiben: \`${stand.pruefwert || '–'}\`. Ein früher notierter Prüfwert muss sich in der Kette wiederfinden.`,
    '', '## 6. Datenzugriff der Finanzverwaltung (§ 147 Abs. 6 AO)', '',
    '- Z1 (unmittelbarer Zugriff): Nur-Lesen-Ansicht im Programm (Übersicht, Bestellungen, Rechnungen, Steuer) am Rechner des Unternehmens.',
    '- Z2 (mittelbarer Zugriff): Auswertungen nach Vorgabe des Prüfers werden vom Unternehmen am Rechner erstellt.',
    '- Z3 (Datenträgerüberlassung): Jahresarchiv als ZIP mit maschinell auswertbaren Tabellen (CSV) und allen Belegen im Originalformat. Beschreibung der Tabellen:',
    '', 'Format aller Tabellen: UTF-8 mit BOM, Trennzeichen Semikolon, Zeilenende CRLF, erste Zeile Spaltennamen, Textfelder bei Bedarf in Anführungszeichen (RFC 4180), Beträge in Euro mit Dezimalkomma ohne Tausenderpunkt, Datum JJJJ-MM-TT, Wahrheitswerte ja/nein.', '',
    ...Object.entries(TABELLEN).flatMap(([datei, spalten]) => [`**${datei}**`, '', '| Spalte | Typ | Bedeutung |', '|---|---|---|', ...spalten.map(([n, t, b]) => `| ${n} | ${t} | ${b} |`), '']),
    'Eine index.xml nach dem GDPdU-Beschreibungsstandard wird derzeit nicht beigelegt (Annahme durch die Prüfsoftware nicht prüfbar); die Tabellen sind durch Kopfzeile und diese Beschreibung selbsterklärend.',
    '', '## 7. Aufbewahrung', '',
    '- Bücher und Aufzeichnungen 10 Jahre, Buchungsbelege und Rechnungen 8 Jahre (§ 147 Abs. 3 AO, § 14b UStG in der Fassung ab 2025). Die Frist beginnt mit dem Schluss des Kalenderjahres, in dem der Beleg entstanden ist (§ 147 Abs. 4 AO).',
    '- Elektronisch erhaltene Belege werden elektronisch im Original aufbewahrt. Das Archiv kennt kein Löschen; nach Fristablauf wird ausdrücklich und protokolliert ausgesondert.',
    '- Datenschutz: Löschanfragen von Kunden werden bis zum Fristende als Sperre vermerkt („gesperrt bis“), nicht gelöscht (Art. 17 Abs. 3 lit. b DSGVO).',
    ...(e.sonstiges ? ['', '## 8. Ergänzungen', '', e.sonstiges] : []), ''
  ]
  return zeilen.join('\n')
}

// ---------- Jahresnachweis ----------
// jahr: Jahr des Exports; arten: Anzahl Archivdateien je Art in diesem Jahr; euer: Kennzahlen; fehler: Befunde beim Export
function jahresnachweis({ jahr, stand = {}, arten = {}, euer = null, fehler = [], pruefwert = '' } = {}) {
  const w = stand.wartung || null
  const s = w?.siegel || null
  const u = stand.usb || {}
  const v = stand.versionen || {}
  return [
    `# Jahresnachweis ${jahr} – ${stand.firma?.firmenname || 'Unternehmen'}`, '',
    `Erstellt: ${zeitDe(stand.jetzt)} mit Plugin Buchhaltung ${v.plugin || '–'} (Belegleser ${v.parser || '–'}).`, '',
    '## Belege des Jahres im Archiv', '', artenListe(arten), '',
    '## Zahlen (EÜR, ohne Gewähr)', '',
    ...(euer ? [`- Einnahmen: ${euro(euer.einnahmen)}`, `- Ausgaben: ${euro(euer.ausgaben)}`, `- Gewinn: ${euro(euer.gewinn)}`] : ['- Keine EÜR-Zahlen vorhanden.']), '',
    '## Integrität', '',
    `- Letzte vollständige Prüfung: ${w?.zeit ? `${zeitDe(w.zeit)}, ${w.archiv?.ok ? 'Hash-Kette und Dateien ohne Befund' : `**${zahl(w.archiv?.anzahlFehler)} Befund(e)**`}` : '**noch keine**'}`,
    `- Siegel: ${s ? `${zahl(s.anzahl)}, zuletzt ${zeitDe(s.zuletzt)}, ${s.ok === false ? '**mit Befund**' : 'gültig'}; ${zahl(s.nochNichtVersiegelt)} Einträge seitdem unversiegelt` : 'noch nicht geprüft'}`,
    `- Prüfwert beim Export: \`${pruefwert || '–'}\``,
    `- Dateien beim Export gegen ihre Prüfsumme geprüft: ${fehler.length ? `**${fehler.length} Befund(e), siehe FEHLER.txt**` : 'alle passend'}`, '',
    '## Jährlicher Regel-Check', '', `- ${stand.regelcheck?.[String(jahr)] ? `durchgeführt am ${tagDe(stand.regelcheck[String(jahr)])}` : '**für dieses Jahr nicht protokolliert**'}`, '',
    '## Sicherung', '',
    `- Letzte USB-Sicherung: ${zeitDe(u.letzteSicherung)}`,
    `- Letzter Wiederherstellungstest: ${u.wiederherstellungstest ? `${zeitDe(u.wiederherstellungstest.zeit)}, ${u.wiederherstellungstest.ok ? 'erfolgreich' : '**fehlgeschlagen**'}` : '**noch keiner**'}`, ''
  ].join('\n')
}

module.exports = { verfahrensdokumentation, jahresnachweis, ergaenzungenNormalisieren, ergaenzungenHash, fehlend, ERGAENZUNGEN, FASSUNG }
