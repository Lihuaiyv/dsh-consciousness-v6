# Start WPR FileIO trace. Run this in an Administrator PowerShell window.
# ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI, Chinese text breaks parsing.
Write-Host 'Cancelling any old trace...'
& wpr -cancel 2>&1 | Out-Null
Write-Host 'Starting FileIO trace (raw output below):'
$out = & wpr -start FileIO -filemode 2>&1
$code = $LASTEXITCODE
$out | ForEach-Object { Write-Host ('  ' + $_) }
Write-Host ('wpr exit code: ' + $code)
Write-Host ''
$status = & wpr -status 2>&1
$status | ForEach-Object { Write-Host ('  ' + $_) }
Read-Host 'Press Enter to close'
