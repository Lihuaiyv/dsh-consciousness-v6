# Xiaoxi auto backup: runs at logon, snapshots the DB into OneDrive every 6 hours.
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI, so avoid non-ASCII here.
# Log: %TEMP%\xiaoxi-backup-loop.log
param([switch]$Once)

$repo = Split-Path -Parent $PSScriptRoot
$node = 'D:\tools\nodejs\node.exe' # check-paths:allow portable node install path
$log  = Join-Path $env:TEMP 'xiaoxi-backup-loop.log'
$everyHours = 12

function Write-Log([string]$msg) {
  $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
  if ((Get-Item $log).Length -gt 65536) {
    $tail = Get-Content $log -Tail 200 -Encoding UTF8
    Set-Content -Path $log -Value $tail -Encoding UTF8
  }
}

Write-Log ('loop start; once=' + $Once + '; every=' + $everyHours + 'h')

do {
  try {
    if (-not (Test-Path $node)) { Write-Log 'node not found: ' + $node; break }
    $script = Join-Path $repo 'scripts\backup-cloud.mjs'
    $out = & $node $script 2>&1 | Out-String
    $hits = ($out -split "`r?`n") | Where-Object { $_ -match 'cloud backup done|zip:|verify failed|Error' } | Select-Object -Last 2
    if (-not $hits) { $hits = ($out -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 1) }
    Write-Log ('result: ' + (($hits -join ' | ').Trim()))
  } catch {
    Write-Log ('failed: ' + $_.Exception.Message)
  }
  if ($Once) { break }
  Start-Sleep -Seconds ($everyHours * 3600)
} while ($true)

Write-Log 'loop end'
