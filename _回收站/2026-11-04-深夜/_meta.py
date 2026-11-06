import json, os
p = os.path.expanduser('~/.dsh/storages/session_projcache/sessions/session-4bd87dca-7c26-4781-925b-24e92e82e679.json')
j = json.load(open(p, encoding='utf-8'))
rows = (j.get('record') or {}).get('rows') or {}
out = {
  'title': (rows.get('title') or {}).get('val'),
  'sessionListMetadata': rows.get('sessionListMetadata'),
  'turnBoundary': rows.get('turnBoundary'),
}
open(r'C:\Users\ygys1\Desktop\ds\dsh-plugin\_meta_out.json','w',encoding='utf-8').write(json.dumps(out, ensure_ascii=False, indent=1))
print('ok')
