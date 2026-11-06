import json, glob, os
out = []
for p in glob.glob(os.path.expanduser('~/.dsh/storages/session_projcache/sessions/*.json')):
    try:
        j = json.load(open(p, encoding='utf-8'))
        rows = ((j.get('record') or {}).get('rows') or {})
        t = (rows.get('title') or {}).get('val') or ''
        if '极端' in t:
            out.append(os.path.basename(p) + '\t' + t)
    except Exception:
        pass
open(r'C:\Users\ygys1\Desktop\ds\dsh-plugin\_extreme_titles.txt','w',encoding='utf-8').write('\n'.join(out) or '(none)')
print(len(out))
