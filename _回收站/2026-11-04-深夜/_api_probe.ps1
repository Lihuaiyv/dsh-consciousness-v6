$body = @{ method = 'GET'; path = '/v1/sessions/session-4bd87dca-7c26-4781-925b-24e92e82e679/agent'; body = @{}; token = 'user' } | ConvertTo-Json -Compress
$r = Invoke-RestMethod -Uri 'http://127.0.0.1:61246/dsh-consciousness/api' -Method Post -ContentType 'application/json' -Body $body
$r | ConvertTo-Json -Depth 6
