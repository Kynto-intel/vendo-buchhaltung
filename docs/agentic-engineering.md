# Agentic Engineering in diesem Projekt

Die Buchhaltung wird zu einem großen Teil von Coding-Agenten geschrieben (derzeit Claude Code). Ein Mensch entscheidet,
was gebaut wird, prüft das Ergebnis und gibt jede Änderung frei. Diese Seite beschreibt, wie das konkret abläuft – auch
damit man einschätzen kann, wie belastbar der Code ist.

> Agenten machen Fehler, die alle Tests bestehen. Für Steuer, Archiv und Aufbewahrung zählt deshalb immer die Freigabe
> durch einen Menschen. Eine fachliche Prüfung durch eine Steuerberatung ersetzt das alles nicht.

## Wer macht was

| Rolle | Aufgabe |
|---|---|
| **Mensch (Maintainer)** | entscheidet, was gebaut wird; beantwortet fachliche Fragen; prüft das Ergebnis in der Oberfläche; gibt Commit, Push und Veröffentlichung frei |
| **Agent** | liest Regeln und Code, schreibt Code, Tests und Doku, führt die Tests aus, prüft die Oberfläche selbst, berichtet ehrlich, was geprüft ist und was nicht |
| **Automatik** | GitHub Actions führt bei jedem Push und Pull Request alle Tests aus (`.github/workflows/tests.yml`) |

## Der Ablauf

1. **Auftrag.** Der Maintainer beschreibt eine Aufgabe in einem Start-Prompt: Ziel, Grenzen, welche Dateien zuerst zu
   lesen sind, wie geprüft wird. Größere Vorhaben werden in Phasen geteilt; nach jeder Phase hält der Agent den Stand
   fest und schreibt den Start-Prompt für die nächste Sitzung.
2. **Lesen vor Schreiben.** Der Agent liest [`AGENTS.md`](../AGENTS.md), die betroffenen Dateien, ihre Aufrufstellen
   und die vorhandenen Tests. Er formuliert eine prüfbare Annahme und ändert nur den zuständigen Bereich.
3. **Bauen mit Tests.** Neue Funktionen kommen mit Verhaltenstests; ein Fehler wird zuerst mit einem fehlschlagenden
   Test belegt. Testdaten sind immer erfunden (`tests/fixtures/`), externe Dienste werden durch Stubs ersetzt.
4. **Selbst prüfen.** Alle Tests laufen (`npm test`). Was die Oberfläche betrifft, prüft der Agent im Browser mit einem
   Temp-Datenordner und erfundenen Daten – nicht nur, ob die Tests grün sind. Zum Schluss: `git diff --check` und eine
   Suche, ob private Dateien oder echte Daten in die Änderung geraten sind.
5. **Bericht.** Der Agent sagt, was er geändert hat, welche Prüfungen gelaufen sind und welche **nicht** (z. B. „auf
   Linux nicht getestet“). Ein Test, der übersprungen wurde, gilt nicht als bestanden.
6. **Freigabe.** Der Maintainer sieht sich die Änderung an. Erst nach seinem Okay wird committet, erst auf seine
   ausdrückliche Anweisung gepusht.

## Ein Beispiel: der eigenständige Betrieb im Browser

Die Buchhaltung lief zuerst nur als Plugin in der Desktop-App [Vendo](https://github.com/Kynto-intel/vendo). Der Auftrag
war, sie zusätzlich eigenständig im Browser laufen zu lassen, ohne dass sich in Vendo etwas ändert.

- **Bestandsaufnahme:** Der Agent fand alle Stellen, an denen der Code Electron direkt aufrief (Dateien öffnen,
  Verschlüsselung, „Speichern unter“), und die fest verdrahteten Namen.
- **Umbau:** Alles Umfeldabhängige wanderte in `host.js` mit zwei Umsetzungen (Vendo und eigenständig). Dazu kamen
  der lokale Server mit Sitzungs-Token und ein Passwort-Tresor für Geheimnisse.
- **Prüfung:** Die bestehenden Tests blieben grün; neue Tests prüfen unter anderem, dass der Server ohne Token nichts
  annimmt, dass Geheimnisse nie im Klartext gespeichert werden und dass private Arbeitsdateien nicht ins Repository
  geraten können. Danach wurde die Oberfläche im Browser bedient und die Buchhaltung in Vendo live nachgeprüft.
- **Was ein Mensch entscheiden musste:** ob der eigenständige Betrieb Vendos Datenbank mitbenutzen soll. Technisch
  wäre das möglich gewesen, aber zwei Programme, die gleichzeitig dasselbe Belegarchiv beschreiben, gefährden die
  Prüfkette. Entschieden wurde: getrennte Datenbestände.
- **Was trotzdem schiefging:** Der erste Push in dieses Repository wurde von GitHub abgelehnt, weil der Commit eine
  private E-Mail-Adresse enthielt. Der Commit wurde vor der Veröffentlichung korrigiert; seitdem steht die Regel in
  [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Leitplanken für Agenten

Die Regeln stehen an wenigen Stellen und werden, wo es geht, durch Tests abgesichert statt nur beschrieben:

- **Belegarchiv:** Belege werden nie verändert oder gelöscht, nur ausgeblendet; jede Ablage hängt an der Hash-Kette.
- **Geheimnisse:** Tokens und persönliche Angaben nur verschlüsselt speichern und nie an die Oberfläche zurückgeben.
- **Umfeld:** Electron nur in `host.js`; Plugin-Daten nur über `ctx`; keine neuen Abhängigkeiten ohne Begründung.
- **Daten:** Nach außen gehen nur die API-Abfragen mit den eigenen Zugängen und beim Versiegeln ein Hashwert.
- **Tests:** unter anderem ein Test, der private Arbeitsdateien, feste Namen und Electron-Aufrufe außerhalb von
  `host.js` aufspürt (`tests/buchhaltung-standalone.test.js`).

`AGENTS.md` ist der Einstieg für Agenten, `CLAUDE.md` verweist darauf.

## Mitmachen

Wer mitbauen will – mit oder ohne KI –, findet den Ablauf in [`CONTRIBUTING.md`](../CONTRIBUTING.md).
