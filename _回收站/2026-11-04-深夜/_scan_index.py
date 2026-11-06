import re
for p in ['index.js']:
    src=open(p,encoding='utf-8').read().split('\n')
    def fix(s):
        try: return s.encode('gbk').decode('utf-8')
        except Exception: return None
    in_block=False
    print('===',p)
    for i,line in enumerate(src,1):
        st=line.strip()
        if in_block:
            if '*/' in line: in_block=False
            continue
        if st.startswith('/*'):
            if '*/' not in line: in_block=True
            continue
        if st.startswith('//') or st.startswith('*'): continue
        for m in re.finditer(r"'([^'\\]*(?:\\.[^'\\]*)*)'|\"([^\"\\]*(?:\\.[^\"\\]*)*)\"|`([^`]*)`", line):
            s=next((g for g in m.groups() if g is not None), None)
            if not s: continue
            r=fix(s)
            if r and re.search(r'[\u4e00-\u9fff]',r) and len(r)>=2:
                print(i, ascii(s), '=>', ascii(r))
            else:
                bad=[ch for ch in s if 0xe000<=ord(ch)<=0xf8ff or ch=='\ufffd']
                if bad: print(i,'ODD',ascii(s),ascii(bad))
