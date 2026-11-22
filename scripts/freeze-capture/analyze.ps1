# Convert freeze.etl into a CSV that XiaoXi can analyze. ASCII only.
$etl = Join-Path $PSScriptRoot '..\..\scratch\freeze.etl'
$csv = Join-Path $PSScriptRoot '..\..\scratch\freeze-io.csv'
if (-not (Test-Path $etl)) { Write-Host ('Missing ' + $etl + ' - run stop.ps1 first'); exit 1 }
Write-Host 'Exporting, this may take a minute...'
tracerpt $etl -o $csv -of CSV -y 2>&1 | Select-Object -Last 3
if (Test-Path $csv) {
  $mb = [math]::Round((Get-Item $csv).Length / 1MB, 1)
  Write-Host ('Exported: ' + $csv + ' (' + $mb + ' MB)')
} else {
  Write-Host 'Export failed.'
}
