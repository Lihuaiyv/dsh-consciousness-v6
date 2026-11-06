import re, os
def fix(s):
    try: return s.encode('gbk').decode('utf-8')
    except Exception: return None
def scan_file(p):
    out=[]
    try: lines=open(p,encoding='utf-8').read().split('\n')
    except Exception: return out
    in_block=False
    for i,line in enumerate(lines,1):
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
                out.append((i,s,r))
    return out
for root,dirs,files in os.walk('src'):
    for f in files:
        if not f.endswith('.js'): continue
        p=os.path.join(root,f)
        for i,s,r in scan_file(p):
            print(p, i, ascii(s), '=>', ascii(r))
