import json
p='package.json'
raw=open(p,encoding='utf-8').read()
# print description line
for line in raw.split('\n'):
    if '"description"' in line:
        print(ascii(line))
        v=line.split(':',1)[1].strip().rstrip(',')
        print(ascii(v))
        # try per-run gbk decode
        print(ascii(v.encode('gbk', errors='replace').decode('utf-8', errors='replace')))
