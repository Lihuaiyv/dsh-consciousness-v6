$body = @{ method = 'GET'; path = '/v1/sessions/session-4bd87dca-7c26-4781-925b-24e92e82e679/agent'; body = @{}; token = 'user' } | ConvertTo-Json -Compress
try {
  $r = Invoke-RestMethod -Uri 'http://127.0.0.1:54881/dsh-consciousness/api' -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 10
  $r | ConvertTo-Json -Depth 6
} catch { 'ERR ' + $_.Exception.Message }
$body2 = @{ method = 'GET'; path = '/v1/runtime'; body = @{}; token = 'user' } | ConvertTo-Json -Compress
try {
  $r2 = Invoke-RestMethod -Uri 'http://127.0.0.1:54881/dsh-consciousness/api' -Method Post -ContentType 'application/json' -Body $body2 -TimeoutSec 10
  $r2.agents | Select-Object name, runtime_state, bound_sessions | Format-Table -AutoSize
} catch { 'ERR2 ' + $_.Exception.Message }
