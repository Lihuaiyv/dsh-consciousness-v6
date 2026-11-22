# Stop WPR trace and save it. Run this in an Administrator PowerShell window.
# ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI, Chinese text breaks parsing.
$out = Join-Path $PSScriptRoot '..\..\scratch\freeze.etl'
Write-Host ('Stopping trace, writing to: ' + $out)
wpr -stop $out
if (Test-Path $out) {
  $mb = [math]::Round((Get-Item $out).Length / 1MB, 1)
  Write-Host ('Saved, size ' + $mb + ' MB. Tell XiaoXi: ETL is ready.')
} else {
  Write-Host 'No file written - the trace probably was not started.'
}
Read-Host 'Press Enter to close'
