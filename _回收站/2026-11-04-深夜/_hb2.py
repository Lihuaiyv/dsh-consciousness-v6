import sqlite3, time
db = sqlite3.connect(r'C:\Users\ygys1\.dsh\consciousness\app.db')
db.row_factory = sqlite3.Row
print('now ms', int(time.time()*1000))
for r in db.execute("select id, last_heartbeat_at, last_seen_at from agents where status='active'"):
    print(dict(r))
for r in db.execute("select agent_id, next_at, last_at from heartbeats"):
    print(dict(r))
