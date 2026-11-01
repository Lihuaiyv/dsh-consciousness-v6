param(
  [Parameter(Mandatory = $true)][string]$RequestFile,
  [Parameter(Mandatory = $true)][string]$ResultFile
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName Microsoft.VisualBasic

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshcWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
"@

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

$out = [ordered]@{
  ok      = $false
  mode    = $null
  code    = $null
  message = ''
  target  = ''
  sent    = $false
  window  = $null
  steps   = @()
  probe   = $null
  at      = (Get-Date).ToString('o')
}

function Save-Result {
  $json = $out | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($ResultFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Fail([string]$code, [string]$message) {
  $out.ok = $false
  $out.code = $code
  $out.message = $message
  Save-Result
  exit 0
}

function Step([string]$name, [string]$detail) {
  $out.steps += [ordered]@{ name = $name; detail = $detail; at = (Get-Date).ToString('HH:mm:ss.fff') }
}

try {
  $raw = [System.IO.File]::ReadAllText($RequestFile, [System.Text.Encoding]::UTF8)
  $req = $raw | ConvertFrom-Json
} catch {
  Fail 'BAD_REQUEST' ('请求文件读不了：' + $_.Exception.Message)
}

$mode = if ($req.mode) { [string]$req.mode } else { 'send' }
$target = if ($req.target) { [string]$req.target } else { '' }
$text = if ($req.text) { [string]$req.text } else { '' }
$launch = if ($null -ne $req.launch) { [bool]$req.launch } else { $true }
$allowKeys = if ($null -ne $req.allow_keys_fallback) { [bool]$req.allow_keys_fallback } else { $false }
$dryRun = if ($null -ne $req.dry_run) { [bool]$req.dry_run } else { $false }
$out.target = $target

function Get-WeChatProc {
  return Get-Process -Name 'Weixin', 'WeChat' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
}

$proc = Get-WeChatProc
if (-not $proc -and $launch) {
  $candidates = @(
    'D:\Tencent\Weixin\Weixin.exe',
    'C:\Program Files\Tencent\Weixin\Weixin.exe',
    'C:\Program Files\Tencent\WeChat\WeChat.exe',
    "$env:LOCALAPPDATA\Programs\Tencent\Weixin\Weixin.exe"
  )
  $exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $exe -and $req.exe) { $exe = [string]$req.exe }
  if ($exe) {
    Step 'launch' $exe
    Start-Process -FilePath $exe | Out-Null
    for ($i = 0; $i -lt 40; $i++) {
      Start-Sleep -Milliseconds 500
      $proc = Get-WeChatProc
      if ($proc) { break }
    }
  }
}
if (-not $proc) {
  Fail 'WECHAT_NOT_RUNNING' '没找到微信窗口：微信可能没启动，或还没登录。先手动打开并登录微信。'
}

$wpid = [uint32]$proc.Id
$hwnd = [IntPtr]$proc.MainWindowHandle

function Get-WindowEl([uint32]$processId) {
  $root = $AE::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $processId)
  $w = $root.FindFirst($TS::Children, $cond)
  if ($w) { return $w }
  $all = $root.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($x in $all) {
    if ($x.Current.ProcessId -eq $processId) { return $x }
  }
  return $null
}

function Get-ByType($root, $type) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $type)
  return $root.FindAll($TS::Descendants, $cond)
}

function Get-Rect($el) {
  try { return $el.Current.BoundingRectangle } catch { return [System.Windows.Rect]::Empty }
}

function Set-Foreground([IntPtr]$h, [uint32]$processId) {
  try { [DshcWin32]::SetForegroundWindow($h) | Out-Null } catch { }
  Start-Sleep -Milliseconds 150
  try { [Microsoft.VisualBasic.Interaction]::AppActivate([int]$processId) | Out-Null } catch { }
  Start-Sleep -Milliseconds 200
}

function Test-Foreground([uint32]$processId) {
  $h = [DshcWin32]::GetForegroundWindow()
  $p = [uint32]0
  [DshcWin32]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
  return ($p -eq $processId)
}

function Click-El($el) {
  $r = Get-Rect $el
  if ($r.IsEmpty -or $r.Width -le 0) { return $false }
  $x = [int]($r.X + $r.Width / 2)
  $y = [int]($r.Y + $r.Height / 2)
  [DshcWin32]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 80
  [DshcWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [DshcWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 200
  return $true
}

function Set-ElText($el, [string]$value) {
  $vp = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
      $vp.SetValue($value)
      return 'valuepattern'
    }
  } catch { }
  Click-El $el | Out-Null
  try { [System.Windows.Forms.Clipboard]::SetText($value) } catch { Set-Clipboard -Value $value }
  Start-Sleep -Milliseconds 120
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  Start-Sleep -Milliseconds 60
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  return 'paste'
}

$win = Get-WindowEl $wpid
if (-not $win) {
  Fail 'WECHAT_WINDOW_NOT_FOUND' '微信进程在，但读不到窗口（可能最小化到托盘）。把微信主窗口打开再试。'
}
$winClass = ''
$winName = ''
try { $winClass = [string]$win.Current.ClassName } catch { }
try { $winName = [string]$win.Current.Name } catch { }
$out.window = [ordered]@{ name = $winName; class = $winClass; pid = $wpid }

if ($winClass -match 'Login') {
  if ($mode -eq 'probe') {
    $out.ok = $true
    $out.mode = 'probe'
    $out.message = '微信停在登录窗口，还没有登录'
    $out.probe = [ordered]@{ logged_in = $false; nodes = @() }
    Save-Result
    exit 0
  }
  Fail 'WECHAT_NOT_LOGGED_IN' '微信停在登录窗口：先扫码登录，再让它自己发。'
}

$edits = @(Get-ByType $win ([System.Windows.Automation.ControlType]::Edit))
$buttons = @(Get-ByType $win ([System.Windows.Automation.ControlType]::Button))
$items = @(Get-ByType $win ([System.Windows.Automation.ControlType]::ListItem))

if ($mode -eq 'probe') {
  $nodes = @()
  foreach ($e in $edits) {
    $r = Get-Rect $e
    $nodes += [ordered]@{
      kind = 'edit'; name = $e.Current.Name; id = $e.Current.AutomationId
      x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height; off = $e.Current.IsOffscreen
    }
  }
  $i = 0
  foreach ($b in $buttons) {
    if ($i -ge 30) { break }
    $nodes += [ordered]@{ kind = 'button'; name = $b.Current.Name; id = $b.Current.AutomationId }
    $i++
  }
  $i = 0
  foreach ($it in $items) {
    if ($i -ge 30) { break }
    $nodes += [ordered]@{ kind = 'listitem'; name = $it.Current.Name; id = $it.Current.AutomationId }
    $i++
  }
  $out.ok = $true
  $out.mode = 'probe'
  $out.message = '窗口可读'
  $out.probe = [ordered]@{ nodes = $nodes; logged_in = $true }
  Save-Result
  exit 0
}

if ($dryRun) {
  $out.ok = $true
  $out.mode = 'dry-run'
  $out.message = '只探测，不发送'
  Save-Result
  exit 0
}

if (-not $target.Trim()) { Fail 'WECHAT_NO_TARGET' '没给收件人（target 为空）。' }
if (-not $text.Trim()) { Fail 'WECHAT_NO_TEXT' '要发的内容是空的。' }

Set-Foreground $hwnd $wpid
if (-not (Test-Foreground $wpid)) {
  Fail 'WECHAT_NOT_FOREGROUND' '微信没能切到前台（可能被别的窗口挡住/最小化）。先手动点一下微信窗口再试。'
}
Step 'foreground' 'ok'

# ---------- 1) 找搜索框 ----------
$searchEl = $null
foreach ($e in $edits) {
  $r = Get-Rect $e
  if ($e.Current.IsOffscreen -or $r.Width -lt 120 -or $r.Height -lt 16) { continue }
  $nm = [string]$e.Current.Name
  $id = [string]$e.Current.AutomationId
  if ($nm -match '搜索|Search' -or $id -match 'search') { $searchEl = $e; break }
}
if (-not $searchEl) {
  $cands = @()
  foreach ($e in $edits) {
    $r = Get-Rect $e
    if ($e.Current.IsOffscreen -or $r.Width -lt 120 -or $r.Height -lt 16) { continue }
    $cands += [pscustomobject]@{ el = $e; y = $r.Y; area = $r.Width * $r.Height }
  }
  if ($cands.Count -gt 0) {
    $searchEl = ($cands | Sort-Object y, @{ Expression = 'area'; Descending = $true } | Select-Object -First 1).el
  }
}

$hit = $null
$usedKeys = $false
$typedSearch = $false

if ($searchEl) {
  $how = Set-ElText $searchEl $target
  $typedSearch = $true
  Step 'search' ('uia ' + $how)
  Start-Sleep -Milliseconds 900

  # ---------- 2) 只点完全对得上的那个，避免发错人 ----------
  $names = @()
  foreach ($it in $items) {
    if ($it.Current.IsOffscreen) { continue }
    $nm = ([string]$it.Current.Name).Trim()
    if (-not $nm) { continue }
    $names += $nm
    if ($nm -eq $target.Trim()) { $hit = $it; break }
  }
  if (-not $hit) {
    foreach ($it in $items) {
      if ($it.Current.IsOffscreen) { continue }
      $nm = ([string]$it.Current.Name).Trim()
      if ($nm.StartsWith($target.Trim() + ' ') -or $nm.StartsWith($target.Trim() + '(') -or $nm.StartsWith($target.Trim() + '（')) { $hit = $it; break }
    }
  }
  if ($hit) {
    Click-El $hit | Out-Null
    Step 'target' ('clicked ' + ([string]$hit.Current.Name))
    Start-Sleep -Milliseconds 900
  } else {
    $hint = if ($names.Count) { '。搜到的候选：' + (($names | Select-Object -First 5) -join ' / ') } else { '' }
    Step 'target' ('not-found' + $hint)
  }
} else {
  Step 'search' 'uia-not-found'
}

# ---------- 3) UIA 找不到就整体降级到键盘流程（要么全做，要么不做） ----------
if (-not $hit) {
  if (-not $allowKeys) {
    Fail 'WECHAT_SEARCH_NOT_FOUND' '找不到可点的搜索框/联系人（微信版本界面差异）。为免发错人，这次不发。可在设置里打开「键盘兜底」再试，或改用企业微信通道。'
  }
  $usedKeys = $true
  Step 'keys' 'start'
  if (-not $typedSearch) {
    try { [System.Windows.Forms.Clipboard]::SetText($target) } catch { Set-Clipboard -Value $target }
    [System.Windows.Forms.SendKeys]::SendWait('^f')
    Start-Sleep -Milliseconds 500
    [System.Windows.Forms.SendKeys]::SendWait('^a')
    Start-Sleep -Milliseconds 80
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 900
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Start-Sleep -Milliseconds 900
    Step 'keys' 'search+open'
  } else {
    # 已经输入过关键词但没有可点的结果：用 Enter 打开第一个结果
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Start-Sleep -Milliseconds 900
    Step 'keys' 'open-first'
  }
}

# ---------- 4) 找输入框（键盘流程不做，直接粘贴） ----------
if (-not $usedKeys) {
  $inputEl = $null
  $searchRuntime = ($searchEl.GetRuntimeId() -join ',')
  $cands = @()
  foreach ($e in $edits) {
    $r = Get-Rect $e
    if ($e.Current.IsOffscreen -or $r.Width -lt 160 -or $r.Height -lt 20) { continue }
    if (($e.GetRuntimeId() -join ',') -eq $searchRuntime) { continue }
    $nm = [string]$e.Current.Name
    if ($nm -match '搜索|Search') { continue }
    $cands += [pscustomobject]@{ el = $e; y = $r.Y; area = $r.Width * $r.Height }
  }
  if ($cands.Count -gt 0) {
    $inputEl = ($cands | Sort-Object @{ Expression = 'area'; Descending = $true }, y | Select-Object -First 1).el
  }
  if ($inputEl) {
    Click-El $inputEl | Out-Null
    Step 'input' 'clicked'
  } else {
    if (-not $allowKeys) {
      Fail 'WECHAT_INPUT_NOT_FOUND' '找不到消息输入框（微信界面差异）。为免把内容发错地方，这次不发。'
    }
    $usedKeys = $true
    Step 'input' 'uia-not-found, keys'
  }
}

# ---------- 5) 粘贴并发送 ----------
try { [System.Windows.Forms.Clipboard]::SetText($text) } catch { Set-Clipboard -Value $text }
Start-Sleep -Milliseconds 150
if (-not (Test-Foreground $wpid)) { Fail 'WECHAT_NOT_FOREGROUND' '输入时微信不在前台，已中止（避免把内容发到别的窗口）。' }
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 250

$clickedSend = $false
foreach ($b in $buttons) {
  $nm = [string]$b.Current.Name
  if ($nm -match '^\s*(发送|Send)') {
    if (Click-El $b) { $clickedSend = $true; break }
  }
}
if (-not $clickedSend) {
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Step 'send' 'enter'
} else {
  Step 'send' 'button'
}

Start-Sleep -Milliseconds 200
$out.ok = $true
$out.mode = if ($usedKeys) { 'keys' } else { 'uia' }
$out.sent = $true
$out.message = '已发送给「' + $target + '」' + ($(if ($usedKeys) { '（键盘兜底：没有点选校验，建议自己看一眼）' } else { '' }))
Save-Result
exit 0
