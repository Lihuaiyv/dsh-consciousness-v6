p='client.js'
lines=open(p,encoding='utf-8').read().split('\n')
def rep(n, old, new):
    i=n-1
    assert old in lines[i], (n, ascii(lines[i]))
    lines[i]=lines[i].replace(old,new,1)
rep(112, "'\u22650.15', 'LoCoMo'", "'\u22640.15', 'LoCoMo'")
rep(120, "'\u22650.15', 'GoEmotions / MELD'", "'\u22640.15', 'GoEmotions / MELD'")
rep(133, "'\u226580ms', 'SRE p95'", "'\u226480ms', 'SRE p95'")
open(p,'w',encoding='utf-8',newline='').write('\n'.join(lines))
print('ok')
