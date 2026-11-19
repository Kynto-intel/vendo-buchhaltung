# Mitwirken

Schön, dass du mitmachen willst. Programmieren ist keine Voraussetzung: Fehlermeldungen, Ideen und Hinweise auf
fachliche Fehler (Steuer, GoBD, Aufbewahrung) helfen genauso.

> **Keine echten Daten.** Niemals echte Belege, Bestellungen, Namen, Steuernummern, IBANs, Tokens oder Zugangsdaten in
> Issues, Pull Requests, Tests oder Bildschirmfotos. Immer erfundene Werte verwenden.

## Fehler und Ideen melden

Ein Issue mit diesen Punkten:

- **Anlass:** Was ist passiert oder was fehlt?
- **Stand:** Mit welcher Version, auf welchem System (Windows, macOS, Linux), eigenständig oder in Vendo?
- **Vorschlag:** Was sollte stattdessen passieren?
- **Bezug:** Bei fachlichen Fragen die Quelle (Gesetz, BMF-Schreiben, GoBD-Randziffer).

Sicherheitslücken bitte **nicht** als öffentliches Issue melden, sondern über *Security → Report a vulnerability* in
diesem Repository.

## Etwas übernehmen

1. Zu einem Issue kommentieren, dass du es übernimmst – oder erst ein Issue anlegen, wenn es noch keins gibt.
2. Eigenen Branch anlegen (im Fork), nie direkt auf `main`.
3. Ein Thema pro Pull Request.

## Entwickeln

Voraussetzung: Node.js 20 oder neuer (getestet mit 24), Git.

```
npm install
npm test
npm start -- --daten <Test-Ordner>
```

Für die Oberfläche immer einen eigenen Test-Datenordner verwenden. Der Archivordner ist unter Windows gegen Löschen
geschützt; Test-Ordner lassen sich mit `schutz.entsperren` aus `schutz.js` wieder freigeben (so machen es auch die Tests).

Regeln für den Code:

- Electron nur in `host.js`; neue Umfeld-Funktionen dort für **beide** Wege (Vendo und eigenständig) umsetzen.
- Plugin-Daten nur über `ctx.datenLaden`/`ctx.datenSpeichern`, nie eigene Dateien daneben.
- Belege im Archiv werden nie verändert oder gelöscht.
- Geheimnisse nur über den Tresor (`host.tresor`) speichern, nie an die Oberfläche zurückgeben.
- Keine neuen Abhängigkeiten ohne Begründung im Pull Request.
- Oberfläche und Meldungen auf Deutsch; nutzergesteuerte Texte immer mit `ctx.maskieren` einsetzen.

## Tests

- Tests mit `node:test` in `tests/`, Testdaten in `tests/fixtures/` – nur erfundene Werte.
- Neue Funktion: Verhaltenstest dazu. Fehlerbehebung: zuerst ein Test, der den Fehler zeigt.
- Externe Dienste (Shopify, Shirtigo, Zeitstempel) im Test durch Stubs ersetzen, kein Netz.
- Vor dem Push: `npm test` lokal grün. GitHub Actions führt die Tests bei jedem Pull Request erneut aus.
- Was du nicht prüfen konntest (z. B. ein anderes Betriebssystem), schreibst du in die Beschreibung.

## Commits und Pull Requests

- Titel des Pull Requests: `Bereich: was sich ändert (#Issue)`, z. B. `Archiv: Prüfwert im Export anzeigen (#12)`.
- Commits gern als Conventional Commits auf Deutsch, z. B. `fix(parser): Rechnungsdatum mit Punkt am Ende erkennen`.
- **Commit-E-Mail:** Bitte die GitHub-noreply-Adresse verwenden (`git config user.email "…@users.noreply.github.com"`),
  sonst lehnt GitHub den Push bei aktiviertem E-Mail-Schutz ab und deine private Adresse wäre öffentlich.
- Mit dem Beitrag stimmst du zu, dass er unter der Lizenz des Projekts steht (AGPL-3.0-or-later).

## Mit KI-Werkzeugen

KI-Werkzeuge sind ausdrücklich erlaubt – dieses Projekt entsteht selbst größtenteils so (siehe
[Agentic Engineering](docs/agentic-engineering.md)). Dabei gilt:

- Agenten bekommen [`AGENTS.md`](AGENTS.md) als Einstieg (Claude Code liest es über `CLAUDE.md`).
- Kennzeichne KI-Mitarbeit mit einer `Co-Authored-By:`-Zeile im Commit und einem Satz in der Beschreibung des Pull
  Requests (welches Werkzeug, wobei).
- Verantwortlich bist du: Lies, was der Agent geändert hat, und prüfe die Oberfläche selbst.
- Gib einem Agenten nie echte Belege oder Zugangsdaten.

## Wie Beiträge angenommen werden

Der Maintainer prüft jeden Pull Request mit vier Fragen:

1. **Passt es?** Gehört es zu einer lokalen Buchhaltung für kleine Shops?
2. **Ist es fachlich richtig?** Bei Steuer, Archiv und Aufbewahrung mit Quelle.
3. **Ist es einfach genug?** Die kleinste Änderung, die das Problem löst.
4. **Hält es die Regeln ein?** Tests grün, keine echten Daten, Regeln oben.

Änderungen an Steuerlogik, Belegarchiv, Prüfkette oder Verschlüsselung brauchen immer das ausdrückliche Okay des
Maintainers. Die Buchhaltung wird zusätzlich als Plugin in [Vendo](https://github.com/Kynto-intel/vendo) entwickelt;
angenommene Beiträge übernimmt der Maintainer auch dorthin.
