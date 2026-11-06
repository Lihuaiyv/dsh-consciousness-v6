import sqlite3, json
db = sqlite3.connect(r'C:\Users\ygys1\.dsh\consciousness\app.db')
db.row_factory = sqlite3.Row
for r in db.execute("select agent_id, next_at, last_at, last_ms, failures, mode from heartbeats"):
    print(dict(r))
