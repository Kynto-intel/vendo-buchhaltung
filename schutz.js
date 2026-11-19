'use strict'
// Windows-Schutz für das Belegarchiv (Plan 7.5, Schritt 1.2).
// Setzt für das eigene Windows-Konto NTFS-Verweigerungen (Deny), damit Archivdateien nicht gelöscht, geändert,
// umbenannt oder entsperrt werden können – Lesen und neue Dateien anlegen bleiben möglich.
//   dateien      → Löschen, Schreiben, Anhängen, Attribute ändern verweigert
//   nurLoeschen  → nur Löschen verweigert (index.jsonl muss weiter wachsen können; Node braucht zum Anhängen Schreibrecht)
//   ordner       → Ordner löschen und Inhalte löschen verweigert (ohne Vererbung)
// Bewusst nicht über icacls: icacls verweigert bei Deny-Regeln immer auch „Synchronize“ und blockiert damit das Lesen.
// Der Besitzer kann Deny-Regeln grundsätzlich wieder entfernen – das ist ein Schutz gegen Versehen und Programme,
// kein Tresor. Unveränderbarkeit belegen Hash-Kette und Zeitstempel.

const path = require('node:path')
const { spawnSync } = require('node:child_process')

const SKRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$auftrag = $env:VENDO_SCHUTZ | ConvertFrom-Json
$sid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User
$deny = [System.Security.AccessControl.AccessControlType]::Deny
$keine = [System.Security.AccessControl.InheritanceFlags]::None
$ohne = [System.Security.AccessControl.PropagationFlags]::None
$R = [System.Security.AccessControl.FileSystemRights]
$arten = @{
  dateien = $R::Delete -bor $R::WriteData -bor $R::AppendData -bor $R::WriteAttributes -bor $R::WriteExtendedAttributes
  nurLoeschen = $R::Delete
  ordner = $R::Delete -bor $R::DeleteSubdirectoriesAndFiles
}
$ergebnis = [ordered]@{ ok = @(); fehler = @(); geschuetzt = @(); ungeschuetzt = @() }
function Eigene($acl) { @($acl.Access | Where-Object { $_.AccessControlType -eq 'Deny' -and $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]) -eq $sid }) }
foreach ($art in @('dateien', 'nurLoeschen', 'ordner')) {
  foreach ($p in @($auftrag.$art)) {
    if (-not $p) { continue }
    try {
      $acl = Get-Acl -LiteralPath $p
      $soll = $arten[$art]
      $vorhanden = $R::Synchronize -band 0
      foreach ($r in (Eigene $acl)) { $vorhanden = $vorhanden -bor $r.FileSystemRights }
      $hat = (($vorhanden -band $soll) -eq $soll)
      if ($auftrag.modus -eq 'pruefen') {
        if ($hat) { $ergebnis.geschuetzt += $p } else { $ergebnis.ungeschuetzt += $p }
        continue
      }
      if ($auftrag.modus -eq 'entsperren') {
        foreach ($r in (Eigene $acl)) { [void]$acl.RemoveAccessRule($r) }
        Set-Acl -LiteralPath $p -AclObject $acl
      } elseif (-not $hat) {
        $regel = New-Object System.Security.AccessControl.FileSystemAccessRule -ArgumentList $sid, $soll, $keine, $ohne, $deny
        $acl.AddAccessRule($regel)
        Set-Acl -LiteralPath $p -AclObject $acl
      }
      $ergebnis.ok += $p
    } catch {
      $ergebnis.fehler += ($p + ': ' + $_.Exception.Message)
    }
  }
}
[Console]::Out.Write(($ergebnis | ConvertTo-Json -Compress -Depth 3))
`

// Jeder PowerShell-Lauf hat ein Zeitlimit (60 s) und braucht je Pfad etwa 15 ms (gemessen 29.10.2026). Große Mengen – z. B.
// das ganze Archiv nach der Migration – werden darum in Pakete geteilt und die Ergebnisse zusammengeführt.
const PAKET = 12_000 // Zeichen Pfade je Lauf ≈ 100 Pfade ≈ 1–2 s
function pakete(auftrag) {
  const liste = []
  let paket = null
  let laenge = 0
  for (const art of ['dateien', 'nurLoeschen', 'ordner']) {
    for (const p of auftrag[art]) {
      if (!paket || laenge + p.length > PAKET) { paket = { dateien: [], nurLoeschen: [], ordner: [] }; liste.push(paket); laenge = 0 }
      paket[art].push(p)
      laenge += p.length + 4
    }
  }
  return liste
}

function ausfuehren(modus, { dateien = [], nurLoeschen = [], ordner = [] } = {}) {
  const leer = { ok: [], fehler: [], geschuetzt: [], ungeschuetzt: [] }
  const alle = [...dateien, ...nurLoeschen, ...ordner]
  if (!alle.length) return { ...leer, erfolgreich: true }
  if (alle.some((p) => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('Schutz: nur absolute Pfade erlaubt.')
  if (process.platform !== 'win32') return { ...leer, fehler: ['Dateischutz gibt es nur unter Windows.'], erfolgreich: false }

  const erg = { ok: [], fehler: [], geschuetzt: [], ungeschuetzt: [] }
  for (const auftrag of pakete({ dateien, nurLoeschen, ordner })) {
    const teil = einLauf(modus, auftrag)
    for (const k of Object.keys(erg)) erg[k].push(...teil[k])
  }
  return { ...erg, erfolgreich: erg.fehler.length === 0 && (modus !== 'pruefen' || erg.ungeschuetzt.length === 0) }
}

function einLauf(modus, { dateien, nurLoeschen, ordner }) {
  const leer = { ok: [], fehler: [], geschuetzt: [], ungeschuetzt: [] }
  const lauf = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SKRIPT, 'utf16le').toString('base64')], {
    env: { ...process.env, VENDO_SCHUTZ: JSON.stringify({ modus, dateien, nurLoeschen, ordner }) },
    encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 10 * 1024 * 1024
  })
  if (lauf.error || lauf.status !== 0) {
    const grund = lauf.error?.message || String(lauf.stderr || '').trim().split('\n')[0] || `Exit-Code ${lauf.status}`
    return { ...leer, fehler: [`PowerShell: ${grund}`], erfolgreich: false }
  }
  let antwort
  try { antwort = JSON.parse(lauf.stdout) } catch { return { ...leer, fehler: ['PowerShell: unlesbare Antwort'], erfolgreich: false } }
  const liste = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]) // ConvertTo-Json macht aus Ein-Element-Listen Einzelwerte
  const erg = { ok: liste(antwort.ok), fehler: liste(antwort.fehler), geschuetzt: liste(antwort.geschuetzt), ungeschuetzt: liste(antwort.ungeschuetzt) }
  return { ...erg, erfolgreich: erg.fehler.length === 0 && (modus !== 'pruefen' || erg.ungeschuetzt.length === 0) }
}

const schuetzen = (ziele) => ausfuehren('schuetzen', ziele)
const pruefen = (ziele) => ausfuehren('pruefen', ziele)
// Nur für Tests und spätere, ausdrücklich bestätigte Vorgänge (z. B. Löschen nach Ablauf der Aufbewahrungsfrist)
const entsperren = (ziele) => ausfuehren('entsperren', ziele)

module.exports = { schuetzen, pruefen, entsperren }
