import json, os, sqlite3, datetime
home = os.path.expanduser('~/.dsh')
ws = json.load(open(home + '/storages/workspace.json', encoding='utf-8'))
arch = set(map(str, ws['global'].get('archivedSessionIds') or []))
db = sqlite3.connect(r'C:\Users\ygys1\.dsh\consciousness\app.db')
db.row_factory = sqlite3.Row
at = datetime.datetime.now(datetime.timezone.utc)
def parse(s):
    try: return datetime.datetime.fromisoformat(s.replace('Z','+00:00'))
    except Exception: return None
counts = {}
alive = {}
for r in db.execute("select agent_id, session_id, last_seen_at, bound_at, created_at from bindings where state='bound'"):
    sid = r['session_id']; aid = r['agent_id']
    a = parse(r['last_seen_at'] or r['bound_at'] or r['created_at'] or '')
    isarch = sid in arch
    if isarch and a and (at - a).total_seconds() >= 6*3600:
        continue
    counts[aid] = counts.get(aid,0)+1
    alive.setdefault(aid, []).append((sid, isarch, a.isoformat() if a else None))
print('total bound rows:', db.execute("select count(*) from bindings where state='bound'").fetchone()[0])
for aid, n in counts.items():
    print(aid, n)
    for x in alive[aid]: print('   ', x)
