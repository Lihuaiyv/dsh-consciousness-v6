# 小汐的光点：右下角一颗小小的白点，说话前亮成光晕再落回去。
# 注意：不开抗锯齿——抗锯齿边缘会和透明键（洋红）混出一圈紫边。
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$rt = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\runtime'))
$flag = Join-Path $rt 'voice-glow.txt'
$side = 96
$baseR = 2          # 平时半径：小小的白点
$peakR = 22         # 亮起来的光晕半径

$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle = 'None'
$f.StartPosition = 'Manual'
$f.ShowInTaskbar = $false
$f.TopMost = $true
$f.Size = New-Object System.Drawing.Size($side, $side)
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$f.Location = New-Object System.Drawing.Point(($wa.Right - $side - 28), ($wa.Bottom - $side - 28))
$f.BackColor = [System.Drawing.Color]::Magenta
$f.TransparencyKey = [System.Drawing.Color]::Magenta
$f.Add_Click({ $f.Close() })

$global:form = $f
$global:flag = $flag
$global:glow = 0.0
$global:last = ''

$f.Add_Paint({
  param($s, $e)
  $g = [double]$global:glow
  $cx = [double]$side / 2
  $r = [double]$baseR + ([double]$peakR - [double]$baseR) * $g
  # 不开抗锯齿：抗锯齿的半透明边缘会和洋红透明键混成紫边
  $e.Graphics.SmoothingMode = 'None'

  $white = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)
  $brush = New-Object -TypeName System.Drawing.SolidBrush -ArgumentList $white
  $e.Graphics.FillEllipse($brush, [float]($cx - $r), [float]($cx - $r), [float](2 * $r), [float](2 * $r))
  $brush.Dispose()
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 90
$timer.Add_Tick({
  try {
    if (Test-Path $global:flag) {
      $t = (Get-Item $global:flag).LastWriteTimeUtc.Ticks
      if ("$t" -ne $global:last) {
        $global:last = "$t"
        $global:glow = 1.0
      }
    }
    if ($global:glow -gt 0) { $global:glow = [Math]::Max(0, $global:glow - 0.03) }
    $script:f.Refresh()
  } catch { }
})
$timer.Start()

[System.Windows.Forms.Application]::Run($f)
