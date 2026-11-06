$body = @{ method = 'GET'; path = '/v1/agents'; body = @{}; token = 'user' } | ConvertTo-Json -Compress
$r = Invoke-RestMethod -Uri 'http://127.0.0.1:54881/dsh-consciousness/api' -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 8
$r | Where-Object { $_.status -ne 'soft_deleted' } | Select-Object name, status, runtime_state, bound_sessions | Format-Table -AutoSize
