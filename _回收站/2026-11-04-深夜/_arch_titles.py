import json, os, glob
home = os.path.expanduser('~/.dsh')
ws = json.load(open(home + '/storages/workspace.json', encoding='utf-8'))
arch = list(map(str, ws['global'].get('archivedSessionIds') or []))
out = []
for sid in arch:
    p = home + '/storages/session_projcache/sessions/' + sid + '.json'
    title = ''
    try:
        j = json.load(open(p, encoding='utf-8'))
        for k in ['title','name']:
            v = ((((j.get('record') or {}).get('rows') or {}).get(k) or {}).get('val'))
            if isinstance(v, str) and v.strip(): title = v.strip(); break
    except Exception:
        pass
    out.append(f'{sid}\t{title}')
open(r'C:\Users\ygys1\Desktop\ds\dsh-plugin\_arch_titles.txt','w',encoding='utf-8').write('\n'.join(out))
print('written', len(out))
