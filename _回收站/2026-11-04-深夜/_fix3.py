import io
p='client.js'
s=open(p,encoding='utf-8').read()
lines=s.split('\n')
def setline(n, old_sub, new_line):
    i=n-1
    assert old_sub in lines[i], (n, ascii(lines[i][:120]))
    lines[i]=new_line
setline(6061, "\u704f", "              h('div', { style: { fontSize: 14, fontWeight: 600 } }, '尚未立论'),")
setline(8500, "\u752f", "          h('span', { className: 'dshc-sub' }, '带几轮历史'),")
setline(8504, "\u93c9", "          h('span', { className: 'dshc-sub' }, '条记忆'),")
open(p,'w',encoding='utf-8',newline='').write('\n'.join(lines))
print('ok')
