p='client.js'
s=open(p,encoding='utf-8').read()
n1=s.count(' 路 ')
n2=s.count("'路'")
print('space-lu',n1,'single-lu',n2)
s=s.replace(' 路 ',' · ').replace("'路'","'·'")
open(p,'w',encoding='utf-8',newline='').write(s)
print('done')
