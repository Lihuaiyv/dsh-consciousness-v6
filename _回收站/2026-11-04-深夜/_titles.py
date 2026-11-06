import json, os, sqlite3
home = os.path.expanduser('~/.dsh')
def title(sid):
    p = home + '/storages/session_projcache/sessions/' + sid + '.json'
    try:
        j = json.load(open(p, encoding='utf-8'))
        raw = (((j.get('record') or {}).get('rows') or {}).get('title') or {}).get('val')
        return raw or ''
    except Exception as e:
        return '(no-title)'
db = sqlite3.connect(r'C:\Users\ygys1\.dsh\consciousness\app.db')
db.row_factory = sqlite3.Row
ws = json.load(open(home + '/storages/workspace.json', encoding='utf-8'))
arch = set(map(str, ws['global'].get('archivedSessionIds') or []))
for r in db.execute("select session_id, agent_id, state, last_seen_at from bindings where state='bound' order by last_seen_at desc"):
    sid = r['session_id']
    print(('ARCH' if sid in arch else '    '), r['agent_id'], sid, '|', title(sid)[:60])
