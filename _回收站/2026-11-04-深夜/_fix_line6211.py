p='client.js'
lines=open(p,encoding='utf-8').read().split('\n')
i=6211-1
print(ascii(lines[i]))
lines[i]="          tech ? h(Tech, null, C.claim.id + ' · ' + C.claim.layer + '/' + C.claim.kind + ' · π ' + C.claim.pi + ' · e ' + C.claim.e + ' · 纪元 ' + C.claim.epoch + '\\n'"
open(p,'w',encoding='utf-8',newline='').write('\n'.join(lines))
print('done')
