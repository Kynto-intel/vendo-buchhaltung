# AGENTS.md

Regeln für Coding-Agenten in diesem Repository. Zuerst lesen: `README.md`, `CONTRIBUTING.md`,
`docs/agentic-engineering.md`, dann die betroffenen Dateien, ihre Aufrufstellen und Tests.

## Aufbau

- Derselbe Code läuft als Vendo-Plugin und eigenständig im Browser. `haupt.js` (Hintergrundteil, CommonJS) und
  `ansicht.js` (Oberfläche, ES-Modul ohne Build-Schritt) sind auf beiden Wegen dieselben Dateien.
- `host.js` kapselt das Umfeld: `vendo()` (Electron) und `eigenstaendig()` (lokaler Server). **Kein Electron-Aufruf
  außerhalb von `host.js`.** Neue Umfeld-Funktionen für beide Wege umsetzen.
- `standalone/`: `server.js` (nur 127.0.0.1, Sitzungs-Token, Passwort-Tresor), Browser-ctx (`client.js`),
  JSON-Speicher, optionale Datenbank.
- Plugin-Daten nur über `ctx.datenLaden`/`ctx.datenSpeichern`.

## Unverrückbar

- Belege im Archiv werden nie verändert oder gelöscht (nur ausgeblendet); jede Ablage hängt an der Hash-Kette.
- Geheimnisse (Tokens, persönliche Angaben, Schlüssel) nur verschlüsselt über `host.tresor`; nie an die Oberfläche,
  in Logs, Tests oder Commits.
- Nach außen nur die API-Abfragen mit den eigenen Zugängen und beim Versiegeln ein Hashwert.
- Nie echte Belege, Namen, Steuernummern, IBANs oder Zugangsdaten in Code, Tests, Fixtures, Issues oder Commits.
- Keine neuen Abhängigkeiten ohne Begründung; keinen fremden Code übernehmen, ohne Herkunft und Lizenz zu vermerken.
- Kein Commit, Push oder Merge auf `main` ohne Freigabe eines Menschen.

## Arbeiten

1. Prüfbare Annahme formulieren, nur den zuständigen Bereich ändern.
2. Neue Funktion mit Verhaltenstest; Fehlerbehebung zuerst mit fehlschlagendem Test. Nur erfundene Testdaten
   (`tests/fixtures/`), externe Dienste als Stubs.
3. `npm test` ausführen. Oberfläche zusätzlich im Browser prüfen: `npm start -- --daten <Temp-Ordner>`.
4. `git diff --check`; prüfen, dass keine privaten Dateien oder echten Daten in der Änderung sind.
5. Ehrlich berichten: was geändert, was geprüft, was **nicht** geprüft wurde. Übersprungen ist nicht bestanden.
6. KI-Mitarbeit im Commit mit `Co-Authored-By:` kennzeichnen.

Oberfläche, Meldungen und Doku auf Deutsch. Bei Fragen zu Steuer, GoBD oder Aufbewahrung nicht raten, sondern die
Entscheidung einem Menschen überlassen.
