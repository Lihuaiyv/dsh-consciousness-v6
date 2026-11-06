$ErrorActionPreference = 'Stop'
$text = '看小汐的 shadow 数据：cd C:\Users\ygys1\Desktop\ds\dsh-plugin 然后 node scripts/judge-shadow-report.mjs'
$q = [char]39
$inner = 'Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(' + $q + $text + $q + ',' + $q + '小汐的闹钟' + $q + ')'
$arg = '-NoProfile -WindowStyle Hidden -Command "' + $inner + '"'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date '2026-11-05 21:30:00')
Register-ScheduledTask -TaskName 'xiaoxi-shadow-check' -Action $action -Trigger $trigger -Description '看小汐的 shadow 判定数据' -Force | Out-Null
$t = Get-ScheduledTask -TaskName 'xiaoxi-shadow-check'
$i = Get-ScheduledTaskInfo -TaskName 'xiaoxi-shadow-check'
Write-Output ('state=' + $t.State + ' next=' + $i.NextRunTime)
Write-Output ('action=' + $t.Actions[0].Execute + ' ' + $t.Actions[0].Arguments)
