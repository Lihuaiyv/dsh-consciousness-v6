import json, io
p = r'C:\Users\ygys1\Desktop\ds\dsh-plugin\_arch_conv.jsonl'
msgs = []
for line in open(p, encoding='utf-8'):
    line=line.strip()
    if not line: continue
    try: j = json.loads(line)
    except Exception: continue
    msgs.append(j)
print('records', len(msgs))
kinds = {}
for j in msgs: kinds[j.get('type') or j.get('kind')] = kinds.get(j.get('type') or j.get('kind'),0)+1
print(kinds)
text = open(p, encoding='utf-8').read()
for kw in ['极端','牌子','归档','松绑']:
    print(kw, text.count(kw))
