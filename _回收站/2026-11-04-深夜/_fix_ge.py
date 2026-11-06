p='client.js'
s=open(p,encoding='utf-8').read()
n=s.count('\u922e?')
print('ge count',n)
s=s.replace('\u922e?','\u2265')
old="isOpen ? '\u9231?' : '\u9231?'"
print('chev',s.count(old))
assert s.count(old)==1
s=s.replace(old,"isOpen ? '\u2303' : '\u2304'")
open(p,'w',encoding='utf-8',newline='').write(s)
print('ok')
