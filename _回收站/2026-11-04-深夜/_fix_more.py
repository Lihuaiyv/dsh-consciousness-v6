p='client.js'
s=open(p,encoding='utf-8').read()
repls=[
 ("'\u9360\u6ec4\ue0bd'", "'喜欢'"),
 ("'\u93b4\ue045\ue11b '", "'截止 '"),
 ("join(' 路 ') + ' 路 鏈?tokens '", "join(' · ') + ' · 月 tokens '"),
 ("'\u93c7\u5b58\u68ed'", "'更早'"),
 ("'\u5bf0\u546e\u58d2 '", "'待批 '"),
 ("'\u934f\u30e5\u7c31 '", "'入库 '"),
 ("'\u5bf0\u6940\u578e'", "'得分'"),
]
for old,new in repls:
    n=s.count(old)
    print(ascii(old), 'count', n)
    assert n==1, (old,n)
    s=s.replace(old,new)
open(p,'w',encoding='utf-8',newline='').write(s)
print('ok')
