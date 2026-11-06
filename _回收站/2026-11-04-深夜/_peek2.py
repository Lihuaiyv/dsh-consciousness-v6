p='client.js'
lines=open(p,encoding='utf-8').read().split('\n')
for n in (6203,6207):
    print(n, ascii(lines[n-1]))
