import json, os
p = os.path.expanduser('~/.dsh/storages/workspace.json')
ws = json.load(open(p, encoding='utf-8'))
print(type(ws), list(ws.keys())[:10])
g = ws.get('global') or {}
arch = g.get('archivedSessionIds') or []
print('archived count:', len(arch))
sess = ws.get('sessions') or {}
print('sessions type:', type(sess), 'n=', len(sess))
items = sess.items() if isinstance(sess, dict) else enumerate(sess)
for k, v in list(items)[:40]:
    if isinstance(v, dict):
        print(k, '|', v.get('title') or v.get('name') or '', '| archived=', k in arch or v.get('archived'), '| updated=', v.get('updatedAt') or v.get('updated_at') or '')
    else:
        print(k, '|', str(v)[:80])
