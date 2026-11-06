import sqlite3, re
db=r'C:\Users\ygys1\.dsh\consciousness\app.db'
con=sqlite3.connect('file:'+db+'?mode=ro', uri=True)
con.text_factory=str
tabs=[r[0] for r in con.execute("select name from sqlite_master where type='table' order by name")]
print('tables', len(tabs))
susp=re.compile(r'[\ufffd\u9225\u922b\u923b\u923c\u923d\u9286\u951b\u9477\u9360\u93c7\u93c8\u93c9\u934f\u5bf0\u93b4\u87fa\u87fd\u7021\u6d93]')
for t in tabs:
    try:
        cols=[c[1] for c in con.execute(f'pragma table_info("{t}")')]
    except Exception as e:
        continue
    txtcols=[]
    for c in cols:
        # detect declared type
        typ=None
        for row in con.execute(f'pragma table_info("{t}")'):
            if row[1]==c: typ=row[2]; break
        if typ and ('TEXT' in typ.upper() or 'CHAR' in typ.upper() or 'CLOB' in typ.upper()):
            txtcols.append(c)
    if not txtcols: continue
    hits=0; examples=[]
    for c in txtcols:
        try:
            for row in con.execute(f'select "{c}" from "{t}" where "{c}" is not null limit 5000'):
                v=row[0]
                if isinstance(v,str) and susp.search(v):
                    hits+=1
                    if len(examples)<2: examples.append(v[:80])
        except Exception: pass
    if hits:
        print(t, hits, ascii(examples))
con.close()
