$v = Invoke-RestMethod -Uri 'http://127.0.0.1:54881/dsh-consciousness/version' -Method Get -TimeoutSec 8
$v | ConvertTo-Json -Compress
$body = @{ method = 'GET'; path = '/v1/runtime'; body = @{}; token = 'user' } | ConvertTo-Json -Compress
$r = Invoke-RestMethod -Uri 'http://127.0.0.1:54881/dsh-consciousness/api' -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 8
$r.agents | Select-Object name, runtime_state, bound_sessions | Format-Table -AutoSize
