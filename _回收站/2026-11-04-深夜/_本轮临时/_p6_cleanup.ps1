$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path
$apply = ($args -contains '--apply')
$dest = Join-Path $root '_回收站\2026-11-04-深夜'
function Rel($p) { return $p.Substring($root.Length).TrimStart('\') }

$files = @()
$files += Get-ChildItem $root -File -Filter 'client.js.bak*' -ErrorAction SilentlyContinue
$files += Get-ChildItem $root -File | Where-Object { $_.Name -match '^index\.js\.(before-|good-|pre-manglefix-)' }
$files += Get-ChildItem $root -File -Filter '*.log' -ErrorAction SilentlyContinue
$files += Get-ChildItem $root -File | Where-Object { $_.Name -match '^_.*\.(py|mjs|cjs|out|err|txt)$' }
$files += Get-ChildItem (Join-Path $root 'src') -File -Filter 'kernel.js.corrupt-*' -ErrorAction SilentlyContinue
$files += Get-ChildItem (Join-Path $root 'src\modules\sangguan') -File -Filter '*.bak-*' -ErrorAction SilentlyContinue

$dirs = @()
foreach ($n in '_bak_kernel_p0_20261102','_bak_kernel_v2','_baseline','_rescue-20261101-2158','_audit') {
  $p = Join-Path $root $n
  if (Test-Path $p) { $dirs += Get-Item $p }
}

$all = @()
foreach ($f in $files) { if ($f.FullName -notlike (Join-Path $root '_回收站*')) { $all += $f } }
$sumFiles = ($all | Measure-Object Length -Sum)
$dirBytes = 0
foreach ($d in $dirs) { $s = Get-ChildItem $d.FullName -Recurse -File | Measure-Object Length -Sum; $dirBytes += $s.Sum }

Write-Output ("root: " + $root)
Write-Output ("files: {0} 个, {1:N1} MB" -f $all.Count, ($sumFiles.Sum/1MB))
Write-Output ("dirs : {0} 个, {1:N1} MB" -f $dirs.Count, ($dirBytes/1MB))
Write-Output '--- files (前 25) ---'
$all | Select-Object -First 25 | ForEach-Object { '  ' + (Rel $_.FullName) }
Write-Output '--- dirs ---'
$dirs | ForEach-Object { '  ' + $_.Name }
if (-not $apply) { Write-Output ''; Write-Output 'DRY-RUN：没有移动任何文件。确认后加 --apply 执行。'; exit 0 }

New-Item -ItemType Directory -Force -Path $dest | Out-Null
$moved = 0
foreach ($f in $all) {
  $to = Join-Path $dest (Rel $f.FullName)
  New-Item -ItemType Directory -Force -Path (Split-Path $to) | Out-Null
  Move-Item $f.FullName $to -Force
  $moved++
}
foreach ($d in $dirs) {
  $to = Join-Path $dest $d.Name
  Move-Item $d.FullName $to -Force
  $moved++
}
Write-Output ("moved: " + $moved + " → " + $dest)
