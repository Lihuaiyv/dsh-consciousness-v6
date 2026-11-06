p='client.js'
s=open(p,encoding='utf-8').read()
old1="'\u7035?'"
old2="'\u05ae\u01f0'"
assert s.count(old1)==1, s.count(old1)
assert s.count(old2)==1, s.count(old2)
s=s.replace(old1,"'\u5bf9'").replace(old2,"'\u4e4b\u524d'")
open(p,'w',encoding='utf-8',newline='').write(s)
print('ok')
