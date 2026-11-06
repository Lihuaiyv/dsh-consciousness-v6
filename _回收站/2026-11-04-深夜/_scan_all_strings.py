import re
src = open('client.js', encoding='utf-8').read()
lines = src.split('\n')
def fix(s):
    try: return s.encode('gbk').decode('utf-8')
    except Exception: return None
# broad: try every non-comment string
in_block=False
for i,line in enumerate(lines,1):
    st=line.strip()
    if in_block:
        if '*/' in line: in_block=False
        continue
    if st.startswith('/*'):
        if '*/' not in line: in_block=True
        continue
    if st.startswith('//') or st.startswith('*'):
        continue
    for m in re.finditer(r"'([^'\\]*(?:\\.[^'\\]*)*)'|\"([^\"\\]*(?:\\.[^\"\\]*)*)\"", line):
        s = m.group(1) if m.group(1) is not None else m.group(2)
        if not s: continue
        r=fix(s)
        if r and len(r)>=2 and re.search(r'[\u4e00-\u9fff]', r):
            print(i, ascii(s), '=>', ascii(r))
