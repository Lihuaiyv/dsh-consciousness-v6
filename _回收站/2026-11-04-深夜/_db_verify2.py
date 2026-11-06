import sqlite3, json, time
db = sqlite3.connect(r'C:\Users\ygys1\.dsh\consciousness\app.db')
db.row_factory = sqlite3.Row
n = db.execute("select count(*) from bindings where state='bound'").fetchone()[0]
print('bound rows now:', n)
for r in db.execute("select session_id, agent_id, state, released_by, released_at from bindings where released_by='archived' order by released_at desc limit 5"):
    print(dict(r))
