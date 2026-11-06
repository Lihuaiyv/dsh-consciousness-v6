import re
src = open('client.js', encoding='utf-8').read()
lines = src.split('\n')
def fix(s):
    try:
        return s.encode('gbk').decode('utf-8')
    except Exception:
        return None
susp = re.compile(r'[銆锛鈥鈼鈽鈻鑷灏氭湭绔嬭鎰忚璁剧鏂囧鍜杩鐨姝娓棣閫鎺鍙鐣欏瓨鏁扮]')
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
        if not s or not susp.search(s): continue
        r = fix(s)
        print(i, ascii(s), '=>', ascii(r))
