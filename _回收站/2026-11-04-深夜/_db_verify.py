import sqlite3, json
db = sqlite3.connect(r'C:\Users\ygys1\.dsh\consciousness\app.db')
db.row_factory = sqlite3.Row
rows = db.execute("select session_id, agent_id, state, released_at, released_by from bindings where state='bound' order by last_seen_at desc").fetchall()
print('still bound:', len(rows))
for r in rows: print(dict(r))
print('released by archived:', db.execute("select count(*) from bindings where state='released' and released_by='archived'").fetchone()[0])
recent = db.execute("select session_id, agent_id, released_at, released_by from bindings where released_by='archived' order by released_at desc limit 6").fetchall()
for r in recent: print(dict(r))
