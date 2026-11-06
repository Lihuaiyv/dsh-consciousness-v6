import re, os
susp=re.compile(r'[\u9225\u922b\u923b\u923c\u923d\u9286\u951b\u9477\u9360\u93c7\u93c8\u93c9\u934f\u5bf0\u93b4\u93b0\u87fa\u87fd\u7021\u6d93]')
def scan_file(p):
    try: lines=open(p,encoding='utf-8').read().split('\n')
    except Exception: return
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
            if s and susp.search(s):
                print(p, i, ascii(s[:120]))
for root,dirs,files in os.walk('src'):
    for f in files:
        if f.endswith('.js'): scan_file(os.path.join(root,f))
scan_file('index.js')
