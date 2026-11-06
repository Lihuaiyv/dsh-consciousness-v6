p='client.js'
s=open(p,encoding='utf-8').read()
print('nao count', s.count('\u8133'))
s=s.replace('\u8133','\u00d7')
open(p,'w',encoding='utf-8',newline='').write(s)
print('ok')
