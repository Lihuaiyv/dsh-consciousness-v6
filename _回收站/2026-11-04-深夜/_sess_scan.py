import json, os, glob
root = os.path.expanduser('~/.dsh/sessions')
hits = []
for p in glob.glob(root + '/*/*.json') + glob.glob(root + '/*/*.jsonl'):
    try:
        txt = open(p, encoding='utf-8', errors='ignore').read()
    except Exception:
        continue
    if '极端' in txt:
        hits.append(p)
print(len(hits))
for p in hits[:20]:
    print(p)
