import sqlite3, json
db = sqlite3.connect(r'C:\Users\ygys1\.dsh\consciousness\app.db')
db.row_factory = sqlite3.Row
rows = db.execute("select session_id, role, substr(text,1,80) t, created_at from raw_turns where text like '%极端%' order by created_at desc limit 30").fetchall()
out = [dict(r) for r in rows]
open(r'C:\Users\ygys1\Desktop\ds\dsh-plugin\_extreme_raw.json','w',encoding='utf-8').write(json.dumps(out, ensure_ascii=False, indent=1))
print(len(out))
