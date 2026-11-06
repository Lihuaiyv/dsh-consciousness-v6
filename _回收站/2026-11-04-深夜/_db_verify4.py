import sqlite3
db = sqlite3.connect(r'C:\Users\ygys1\.dsh\consciousness\app.db')
db.row_factory = sqlite3.Row
for r in db.execute("select session_id, agent_id, released_by, released_at from bindings where released_by='archived' order by released_at desc limit 6"):
    print(dict(r))
print('--- bound left')
for r in db.execute("select session_id, agent_id from bindings where state='bound' order by last_seen_at desc"):
    print(dict(r))
