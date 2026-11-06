import re
lines=open('client.js',encoding='utf-8').read().split('\n')
def fix(s):
    try: return s.encode('gbk').decode('utf-8')
    except Exception: return None
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
    for m in re.finditer(r"'([^'\\]*(?:\\.[^'\\]*)*)'|\"([^\"\\]*(?:\\.[^\"\\]*)*)\"", line):
        s=m.group(1) if m.group(1) is not None else m.group(2)
        if not s: continue
        r=fix(s)
        if r is None: continue
        if not r.strip(): continue
        # only show if result is printable and not same, and source has non-ascii
        if r==s: continue
        if not all(ch=='\n' or 32<=ord(ch)<0x3000 or 0x4e00<=ord(ch)<=0x9fff for ch in r): continue
        print(i, ascii(s), '=>', ascii(r))
