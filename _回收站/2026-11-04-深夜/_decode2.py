import re
lines=open('client.js',encoding='utf-8').read().split('\n')
def dec(s):
    t=''.join('?' if (0xE000<=ord(c)<=0xF8FF or ord(c)==0xFFFD) else c for c in s)
    try:
        b=t.encode('gbk',errors='replace')
        return b.decode('utf-8',errors='replace')
    except Exception as e:
        return 'ERR '+str(e)
for n in [3,4,5,1064,1240,1244,1790,1824,2337,2892,3851,4433,4615,4629,4905,8140,8217,8243,8408,8435,8553,8571,8578,8988,9039,9087]:
    l=lines[n-1]
    print('---',n)
    print(dec(l)[:240])
