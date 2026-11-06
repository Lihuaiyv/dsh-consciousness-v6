p='client.js'
s=open(p,encoding='utf-8').read()
print('count', s.count('\u922b?'))
s=s.replace('\u922b?','\u2192')
open(p,'w',encoding='utf-8',newline='').write(s)
print('ok')
