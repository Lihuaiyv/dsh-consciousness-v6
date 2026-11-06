import re
def scan(p):
    src=open(p,encoding='utf-8').read().split('\n')
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
            weird=[]
            for ch in s:
                o=ord(ch)
                if 0xe000<=o<=0xf8ff: weird.append(ch)
                elif o==0xfffd: weird.append(ch)
                elif 0x9000<=o<=0x9fff: weird.append(ch)
            if '?' in s and any(ord(c)>127 for c in s):
                weird.append('?')
            if weird:
                print(i, ascii(''.join(weird)), '|', ascii(s[:160]))
for p in ['client.js','index.js']:
    scan(p)
