import json, os, sqlite3, datetime
ws = json.load(open(os.path.expanduser('~/.dsh/storages/workspace.json'), encoding='utf-8'))
arch = set(map(str, (ws['global'].get('archivedSessionIds') or [])))
titles = {}
# session metadata? look in ~/.dsh/sessions
sdir = os.path.expanduser('~/.dsh/sessions')
if os.path.isdir(sdir):
    for f in os.listdir(sdir)[:5]:
        print('sessions dir entry:', f)
db = sqlite3.connect(r'C:\Users\ygys1\.dsh\consciousness\app.db')
db.row_factory = sqlite3.Row
now = datetime.datetime.now(datetime.timezone.utc)
print('now utc', now.isoformat())
rows = db.execute("select session_id, agent_id, state, last_seen_at, bound_at from bindings where state='bound' order by last_seen_at desc").fetchall()
for r in rows:
    seen = r['last_seen_at'] or ''
    try:
        t = datetime.datetime.fromisoformat(seen.replace('Z','+00:00'))
        age = (now - t).total_seconds()/3600
    except Exception:
        age = -1
    print(('ARCH ' if r['session_id'] in arch else '     '), r['agent_id'], r['session_id'][:44], 'last_seen=%s (%.1fh ago)' % (seen, age))
print('archived total', len(arch))
# any archived session now bound?
