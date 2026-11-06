import json, os
home = os.path.expanduser('~/.dsh')
ws = json.load(open(home + '/storages/workspace.json', encoding='utf-8'))
arch = set(map(str, ws['global'].get('archivedSessionIds') or []))
out = []
for sid in arch:
    p = home + '/storages/session_projcache/sessions/' + sid + '.json'
    try:
        j = json.load(open(p, encoding='utf-8'))
        rows = ((j.get('record') or {}).get('rows') or {})
        title = (rows.get('title') or {}).get('val') or ''
        ti = rows.get('titleInput') or {}
        s = json.dumps(ti, ensure_ascii=False)
        if '极端' in s or '极端' in title:
            out.append(sid + ' | ' + title + ' | ' + s[:200])
    except Exception:
        pass
open(r'C:\Users\ygys1\Desktop\ds\dsh-plugin\_arch_extreme.txt','w',encoding='utf-8').write('\n'.join(out) or '(none)')
print(len(out))
