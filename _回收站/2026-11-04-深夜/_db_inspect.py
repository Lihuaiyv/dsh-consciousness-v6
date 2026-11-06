import sqlite3, json
db = sqlite3.connect(r'C:\Users\ygys1\.dsh\consciousness\app.db')
db.row_factory = sqlite3.Row
tables = [r[0] for r in db.execute("select name from sqlite_master where type='table'")]
print('tables:', tables)
print('--- bindings ---')
for r in db.execute("select session_id, agent_id, state, source, bound_at, last_seen_at, released_at, released_by from bindings order by last_seen_at desc limit 30"):
    print(dict(r))
print('--- agents ---')
for r in db.execute("select id, name, status, runtime_state, created_at from agents"):
    print(dict(r))
