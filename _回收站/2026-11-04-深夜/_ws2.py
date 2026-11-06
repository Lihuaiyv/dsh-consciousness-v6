import json, os
p = os.path.expanduser('~/.dsh/storages/workspace.json')
ws = json.load(open(p, encoding='utf-8'))
print('global keys:', list(ws['global'].keys()))
t = ws['tables']
print('tables type:', type(t), 'keys:', list(t.keys()) if isinstance(t, dict) else len(t))
for k, v in (t.items() if isinstance(t, dict) else []):
    print('--', k, type(v), (len(v) if hasattr(v,'__len__') else ''))
    if isinstance(v, dict):
        for kk, vv in list(v.items())[:3]:
            print('   ', kk, '=>', str(vv)[:300])
