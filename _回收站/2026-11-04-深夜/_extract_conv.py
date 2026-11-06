import json
p = r'C:\Users\ygys1\Desktop\ds\dsh-plugin\_arch_conv.jsonl'
out = []
for line in open(p, encoding='utf-8'):
    line=line.strip()
    if not line: continue
    try: j = json.loads(line)
    except Exception: continue
    t = j.get('type')
    if t == 'user/message':
        c = j.get('content') or j.get('message') or j
        out.append('### USER\n' + json.dumps(c, ensure_ascii=False)[:4000])
    elif t == 'assistant/message':
        c = j.get('content') or j.get('message') or j
        txt = json.dumps(c, ensure_ascii=False)
        out.append('### ASSISTANT\n' + txt[:1500])
open(r'C:\Users\ygys1\Desktop\ds\dsh-plugin\_arch_conv_text.txt','w',encoding='utf-8').write('\n\n'.join(out))
print('lines', len(out))
