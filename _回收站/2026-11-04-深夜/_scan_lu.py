import re
src=open('client.js',encoding='utf-8').read().split('\n')
in_block=False
for i,line in enumerate(src,1):
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
        if s and '路' in s:
            print(i, ascii(s))
