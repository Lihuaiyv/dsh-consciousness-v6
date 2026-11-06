lines=open('client.js',encoding='utf-8').read().split('\n')
for n in [3710,6247,6519,7964,8723]:
    print(n, ascii(lines[n-1]))
