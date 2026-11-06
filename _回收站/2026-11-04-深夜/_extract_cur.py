import json
p = r'C:\Users\ygys1\Desktop\ds\dsh-plugin\_cur_conv.jsonl'
out = []
for line in open(p, encoding='utf-8'):
    line=line.strip()
    if not line: continue
    try: j = json.loads(line)
    except Exception: continue
    if j.get('type') == 'user/message':
        d = (j.get('data') or {}).get('content') or []
        txt = ' '.join(str(c.get('text') or '') for c in d if isinstance(c, dict))
        if txt.strip():
            out.append(txt.strip())
open(r'C:\Users\ygys1\Desktop\ds\dsh-plugin\_cur_users.txt','w',encoding='utf-8').write('\n\n---\n\n'.join(out))
print('users', len(out))
