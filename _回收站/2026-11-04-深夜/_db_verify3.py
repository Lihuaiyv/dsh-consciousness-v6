import sqlite3, time
db = sqlite3.connect(r'C:\Users\ygys1\.dsh\consciousness\app.db')
db.row_factory = sqlite3.Row
print('now', time.strftime('%H:%M:%S'))
print('bound rows:', db.execute("select count(*) from bindings where state='bound'").fetchone()[0])
for r in db.execute("select agent_id, last_heartbeat_at from agents where status='active'"):
    print(dict(r))
for r in db.execute("select session_id, released_by, released_at from bindings where released_by='archived' order by released_at desc limit 3"):
    print(dict(r))
