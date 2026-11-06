import re
lines=open('client.js',encoding='utf-8').read().split('\n')
def dec(s):
    out=[]
    for part in re.split(r'([?]+)', s):
        if not part: continue
        if set(part)=={'?'}:
            out.append('□')
            continue
        try: out.append(part.encode('gbk').decode('utf-8'))
        except Exception:
            # try per-char best effort
            buf=''
            for ch in part:
                try: buf+=ch.encode('gbk').decode('utf-8',errors='ignore')
                except Exception: buf+=ch
            out.append(buf)
    return ''.join(out)
# show selected comment-ish lines that decode to meaningful chinese
picks=[3,4,5,1064,1240,1244,1790,1824,2337,2892,3851,4433,4615,4629,4905,6586,6664,6999,7935,8140,8217,8243,8408,8435,8553,8571,8578,8988,9039,9087]
for n in picks:
    if n-1>=len(lines): continue
    l=lines[n-1]
    if not ('//' in l or '/*' in l or l.strip().startswith('*')): continue
    d=dec(l)
    print('---',n)
    print(d[:220])
