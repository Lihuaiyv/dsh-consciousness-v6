# -*- coding: utf-8 -*-
from pathlib import Path
import json
import subprocess
import urllib.request

print('=== ports ===')
print(subprocess.run(['cmd', '/c', 'netstat -ano | findstr ":6700 :6099"'], capture_output=True, text=True, encoding='utf-8', errors='replace').stdout or '(none)')

rt = Path(r'C:\Users\ygys1\.dsh\qq-bridge\qq-runtime.json')
j = json.loads(rt.read_text(encoding='utf-8'))
print('runtime botOnline=', j.get('botOnline'), 'sessions=', j.get('sessionCount'), 'pid=', j.get('pid'), 'updated=', j.get('updatedAt'))

# WebUI
try:
  r = urllib.request.urlopen('http://127.0.0.1:6099/webui', timeout=2)
  print('webui', r.status)
except Exception as e:
  print('webui', type(e).__name__, e)

# debug log last lines with errors
log = Path(r'C:\Users\ygys1\.dsh\qq-bridge\qq-bridge-debug.log')
lines = log.read_text(encoding='utf-8', errors='replace').splitlines()
print('=== debug interesting ===')
for L in lines[-80:]:
  if any(k in L.lower() for k in ['error', 'fail', 'busy', 'offline', 'online', 'connect', 'ws ', 'login', 'msg from', 'assistant']):
    print(L)

# inbox last
inbox = Path(r'C:\Users\ygys1\.dsh\qq-bridge\qq-inbox.jsonl')
if inbox.exists():
  ls = inbox.read_text(encoding='utf-8', errors='replace').strip().splitlines()
  print('=== inbox last 3 ===')
  for L in ls[-3:]:
    print(L[:300])
