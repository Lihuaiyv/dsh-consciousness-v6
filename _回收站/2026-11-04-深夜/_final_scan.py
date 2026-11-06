import re
lines=open('client.js',encoding='utf-8').read().split('\n')
def fix(s):
    try: return s.encode('gbk').decode('utf-8')
    except Exception: return None
bad=0
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
        if r and len(r)>=2 and re.search(r'[\u4e00-\u9fff]',r):
            bad+=1; print('FIXABLE',i,ascii(s),'=>',ascii(r))
        if any(0xe000<=ord(ch)<=0xf8ff or ch=='\ufffd' for ch in s):
            bad+=1; print('ODD',i,ascii(s))
        if '?' in s and any(ord(ch)>127 for ch in s):
            bad+=1; print('QMARK',i,ascii(s))
print('visible-string issues:',bad)
