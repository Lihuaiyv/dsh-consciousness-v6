lines=open('client.js',encoding='utf-8').read().split('\n')
for n in [110,112,113,116,120,133,1868,1869,1870,1871]:
    print(n, ascii(lines[n-1]))
