# Buchhaltung

[![Tests](https://github.com/Kynto-intel/vendo-buchhaltung/actions/workflows/tests.yml/badge.svg)](https://github.com/Kynto-intel/vendo-buchhaltung/actions/workflows/tests.yml)

Lokale Buchhaltung für kleine Online-Shops (Kleinunternehmer und Regelbesteuerung): holt Shopify-Bestellungen und
erzeugt daraus Umsatzbelege, holt Shirtigo-Bestellungen mit Original-Rechnung, liest eigene PDF-Rechnungen lokal aus
(Textebene oder Texterkennung, ohne Upload) und legt alles in ein Belegarchiv mit Hash-Kette, Zeitstempel-Siegeln und
verschlüsselter USB-Sicherung. Dazu Gewinn je Bestellung, Umsatz je Jahr, Kleinunternehmergrenzen, § 13b,
EÜR-Übersicht, ELSTER-Übersicht zum Abtippen und ein Jahresarchiv als ZIP mit automatisch erzeugter
Verfahrensdokumentation (GoBD) und Jahresnachweis. Für den Datenschutz: Entwurf des Verzeichnisses der
Verarbeitungstätigkeiten, Auskunft je Person als ZIP und Löschanfragen als Sperre bis zum Ende der Aufbewahrungsfrist.

Alle Daten bleiben auf dem eigenen Rechner. Nach außen gehen nur die Abfragen bei Shopify und Shirtigo (mit den eigenen
Zugängen) und beim Versiegeln ein Prüfwert (Hash) an zwei Zeitstempeldienste – nie Belegdaten.

![Buchhaltung im Browser: Kennzahlen, Filter und eingelesene Rechnungen (Beispiel mit erfundenen Daten)](docs/oberflaeche.png)

*Beispiel mit erfundenen Daten: eigenständiger Betrieb im Browser, Reiter „Rechnungen“.*

> Keine Steuerberatung. Die Übersichten helfen beim Ausfüllen, ersetzen aber keine Prüfung durch eine Fachperson.

## Zwei Wege, ein Code

| | in Vendo | eigenständig |
|---|---|---|
| Start | Vendo-Plugin, läuft im Hauptprozess | `npm start` im Plugin-Ordner, Oberfläche im Browser |
| Umfeld (`host.js`) | `vendo()`: Electron | `eigenstaendig()`: lokaler Server |
| Daten | Vendos PostgreSQL (`ctx.daten`) | `buchhaltung.json` im Datenordner (atomar geschrieben) |
| Geheimnisse | Windows-Speicher (DPAPI) | Passwort-Tresor: scrypt + AES-256-GCM |
| Öffnen, Speichern unter | Windows-Programme, Dateidialog | Download im Browser, Kopie in `exporte/` |
| Shopify-Zugang | aus Hermes (System-Tab in Vendo) | in der Oberfläche eintragen (verschlüsselt) |

`haupt.js` (Hintergrundteil) und `ansicht.js` (Oberfläche) sind auf beiden Wegen dieselben Dateien. Alles, was vom
Umfeld abhängt, steht in `host.js`; außerhalb davon gibt es keinen Electron-Aufruf.

## Eigenständig starten

Voraussetzung: Node.js 20 oder neuer.

```
npm install
npm start
```

Der Server lauscht nur auf `127.0.0.1` (Standard-Port 8130) und öffnet den Browser mit einer Adresse wie
`http://127.0.0.1:8130/#t=…`. Das `#t=…` ist ein zufälliges Sitzungs-Token, das bei jedem Start neu entsteht; ohne
dieses Token nimmt der Server keine Aufrufe an. Beim ersten Start wird ein Passwort festgelegt. Es verschlüsselt
persönliche Angaben, Zugänge und den Wiederherstellungsschlüssel und lässt sich nicht zurücksetzen.

Ohne Browser-Start: `npm run server` (die Adresse steht im Terminal).

| Einstellung | Wirkung |
|---|---|
| `--daten <ordner>` oder `BUCHHALTUNG_DATEN` | Datenordner (Standard: `Buchhaltung` im Benutzerordner) |
| `--port <zahl>` oder `BUCHHALTUNG_PORT` | Port (Standard 8130, `0` = freier Port) |
| `--browser` | Browser nach dem Start öffnen (bei `npm start` an) |
| `BUCHHALTUNG_PASSWORT` | Tresor beim Start entsperren (z. B. für Tests; sonst im Browser eingeben) |
| `BUCHHALTUNG_DB_URL` | optional PostgreSQL für den Auswertungs-Index (`postgres://…`, braucht das Paket `pg`) |

Im Datenordner liegen `buchhaltung.json` (Plugin-Daten), `tresor.json` (Salz und Prüfwert, kein Passwort),
`archiv/` (Belegarchiv), `belege/` (Arbeitsordner mit Monatsordnern), `arbeit/` (ausgelesene Texte), `bilder/`
(Produktbilder für Belege) und `exporte/` (Jahresarchive). Den Datenordner bitte mitsichern; das Belegarchiv ist
aufbewahrungspflichtig.

### Sicherheit des lokalen Servers

- nur `127.0.0.1`, fremde `Host`-Kopfzeilen werden abgewiesen (Schutz gegen DNS-Rebinding)
- jede API-Anfrage braucht das Sitzungs-Token im Kopf `X-Sitzung`, JSON als Inhalt und keine fremde `Origin`;
  andere Webseiten im selben Browser können deshalb keine Aufrufe auslösen
- ohne entsperrten Tresor beantwortet der Server nur Zustand und Entsperren
- Downloads nur über einmalige Zufallsadressen, die nach zehn Minuten verfallen
- strenge Content-Security-Policy, keine Einbettung in fremde Seiten
- keine zusätzlichen Abhängigkeiten für den Server (nur Node.js-Bordmittel)

## Zugänge

- **Shopify:** eigene App im Shopify-Admin mit Admin-API-Zugriffstoken (`shpat_…`), Leserechte für Bestellungen und Produkte.
  Eigenständig im Menü „Shopify verbinden“ eintragen. In Vendo kommt der Zugang aus Hermes
  (`SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_STORE`; das Hermes-Profil gibt Vendo über `VENDO_HERMES_PROFIL` vor).
- **Shirtigo:** API-Token aus dem Shirtigo-Cockpit im Menü „Shirtigo verbinden“.

Beide Tokens werden nur verschlüsselt gespeichert und nie an die Oberfläche zurückgegeben.

## Nur unter Windows

- **Archivschutz (NTFS):** Archivdateien bekommen Verweigerungsregeln gegen Löschen und Ändern (`schutz.js`). Auf anderen
  Systemen werden sie nur schreibgeschützt abgelegt.
- **USB-Sicherung:** Die Suche nach Wechseldatenträgern läuft über PowerShell (`usb.js`). Auf anderen Systemen zeigt die
  Oberfläche einen Hinweis statt der Sicherung.

Die Zeitstempel-Siegel brauchen auf jedem System OpenSSL 3 (unter Windows z. B. aus Git for Windows, sonst `openssl` im
Pfad oder `VENDO_OPENSSL`).

## Aufbau

| Datei | Aufgabe |
|---|---|
| `plugin.json`, `ansicht.js`, `stil.css`, `haupt.js` | Vendo-Plugin-Vertrag (Oberfläche, Hintergrundteil) |
| `host.js` | Umfeld: Vendo (Electron) oder eigenständig (Server, Passwort-Tresor) |
| `standalone/` | `server.js`, Browser-ctx (`client.js`, `index.html`, `basis.css`), JSON-Speicher, optionale Datenbank |
| `archiv.js`, `schutz.js`, `zeitstempel.js`, `usb.js`, `schluessel.js` | Belegarchiv mit Hash-Kette, Schutz, Siegel, Sicherung |
| `bestellungen.js`, `shopify.js`, `shirtigo*.js`, `beleg*.js` | Abgleich mit Shopify und Shirtigo, Umsatzbeleg als PDF |
| `parser.js`, `textlayer.js` | PDF-Rechnungen lokal auswerten |
| `angaben*.js`, `persoenlich.js`, `profil.js` | Meine Angaben, Steuerstatus je Zeitraum, persönliche Angaben |
| `steuer.js`, `uebersicht.js`, `jahresarchiv.js`, `datenbank-index.js` | Steuer, EÜR, Jahresarchiv, Index |
| `verfahren.js`, `dsgvo.js` | Verfahrensdokumentation und Jahresnachweis, Datenschutz (Verzeichnis, Auskunft, Sperre) |

## Tests

```
npm test
```

Nur erfundene Testdaten (`tests/fixtures/`). Die Tests für den Archivschutz laufen nur unter Windows; die Datenbank-Tests
nutzen eine Test-Datenbank unter `VENDO_DB_URL` (Standard `postgres://postgres:nurtest@127.0.0.1:55432/vendo_test`) und
werden übersprungen, wenn sie nicht erreichbar ist. Zwei Tests, die Vendo selbst brauchen (Datenbank-Kern,
Electron-Oberfläche), liegen im Vendo-Repository. GitHub Actions führt `npm test` bei jedem Push und Pull Request
unter Windows aus; die Tests mit echten NTFS-Rechten werden dort übersprungen, weil die Verweigerungsregeln auf den
GitHub-Rechnern nicht greifen. Sie laufen nur lokal.

## FAQ

<details>
<summary><strong>Wird die Buchhaltung mit KI entwickelt?</strong></summary>

Ja, zu einem großen Teil mit Coding-Agenten (derzeit Claude Code) – aber nicht ungeprüft: Jede Änderung bringt Tests
mit erfundenen Daten mit, der Agent prüft die Oberfläche selbst und berichtet, was geprüft ist und was nicht. Committet
und veröffentlicht wird erst nach der Freigabe durch einen Menschen. Eine fachliche Prüfung durch eine Steuerberatung
ersetzt das nicht. Wie das genau abläuft, mit einem echten Beispiel: [Agentic Engineering](docs/agentic-engineering.md).
</details>

<details>
<summary><strong>Verlassen meine Daten den Rechner?</strong></summary>

Nein. Belege, Bestellungen und Angaben bleiben lokal. Nach außen gehen nur die Abfragen bei Shopify und Shirtigo mit
deinen eigenen Zugängen und beim Versiegeln ein Hashwert an zwei Zeitstempeldienste.
</details>

<details>
<summary><strong>Nutzt die Browser-Version die Daten aus Vendo?</strong></summary>

Nein, absichtlich nicht. Sie hat einen eigenen Datenordner. Würden Vendo und der Browser gleichzeitig dasselbe
Belegarchiv beschreiben, wäre die Prüfkette in Gefahr; außerdem sind Vendos Geheimnisse mit dem Windows-Speicher
verschlüsselt, den nur Vendo öffnen kann.
</details>

## Dokumentation

- [Agentic Engineering](docs/agentic-engineering.md): wie die Buchhaltung mit Coding-Agenten entsteht
- [Mitwirken](CONTRIBUTING.md): Fehler melden, Entwickeln, Tests, Pull Requests, KI-Werkzeuge
- [AGENTS.md](AGENTS.md): Regeln für Coding-Agenten

## Mitwirken

Fehler und Ideen gern als Issue, Beiträge als Pull Request – mit oder ohne KI-Werkzeuge. Den Ablauf beschreibt
[CONTRIBUTING.md](CONTRIBUTING.md). Bitte nie echte Belege oder Zugangsdaten anhängen.

## Herkunft

Entstanden als Plugin von [Vendo](https://github.com/Kynto-intel/vendo); dort liegt es unter `plugins/buchhaltung/`
und wird von dort aus weiterentwickelt.

## Lizenz

AGPL-3.0-or-later, siehe `LICENSE` und `LIZENZ.md`.
