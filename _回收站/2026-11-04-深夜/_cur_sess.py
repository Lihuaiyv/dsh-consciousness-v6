import json, os
p = os.path.expanduser('~/.dsh/storages/session_projcache/sessions/session-acb6aed3-c82d-4af9-bad0-45862431dfb7.json')
j = json.load(open(p, encoding='utf-8'))
rec = j.get('record') or {}
print('keys', list(rec.keys()))
rows = rec.get('rows') or {}
print('row keys', list(rows.keys()))
t = rows.get('title') or {}
print('title:', t.get('val'))
# dump any message-ish arrays
s = json.dumps(j, ensure_ascii=False)
print('len', len(s))
open(r'C:\Users\ygys1\Desktop\ds\dsh-plugin\_cur_session_dump.json','w',encoding='utf-8').write(s)
