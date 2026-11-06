import re, unicodedata
src=open('client.js',encoding='utf-8').read().split('\n')
def fix(s):
    try: return s.encode('gbk').decode('utf-8')
    except Exception: return None
# allowed non-CJK symbols commonly used in UI
allow=set('·—…“”‘’「」『』（）《》，。！？：；、★☆◆◇●○▼▸▲△↑↓⁺⁻πσ×÷→←≈≤≥±℃°%‰')
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
        if not s: continue
        bad=[]
        for ch in s:
            o=ord(ch)
            if o<128: continue
            if 0x4e00<=o<=0x9fff: continue
            if ch in allow: continue
            bad.append(ch)
        if bad or '\ufffd' in s:
            print(i, 'BAD', ascii(''.join(bad)), '|', ascii(s), '| fix=', ascii(fix(s)))
