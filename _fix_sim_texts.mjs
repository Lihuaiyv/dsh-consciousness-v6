import fs from 'node:fs'
function patch(p, subs) {
  let s = fs.readFileSync(p, 'utf8')
  let n = 0
  for (const [a, b] of subs) {
    if (!s.includes(a)) { console.error('MISS in', p, ':', a); continue }
    s = s.split(a).join(b)
    n++
  }
  fs.writeFileSync(p, s, 'utf8')
  console.log(p, '->', n, '/', subs.length)
}
patch('test/judge-sim.test.mjs', [
  ['检索最后定成乙了 [S]', '检索最后定成乙方案了，下周开始执行 [S]'],
  ['部署改到今天下午就上了 [S]', '部署改到今天下午就上线，已经跑完 [S]'],
  ['咖啡偏好是冰美式', '咖啡偏好一直是冰美式，不喜欢加糖'],
  ['周末想去爬山', '周末想去爬山，找条不太累的路线'],
  ['文档要精简到三页', '文档要精简到三页以内，别堆细节'],
  ['文档还补了一张流程图 [P]', '文档还补了一张流程图，说明流程 [P]'],
  ['想学游泳，但一直没找到合适的班', '想学游泳，但一直没找到合适的班，拖了半年'],
  ['喜欢安静的环境，人多会累', '喜欢安静的环境，人一多就累'],
  ['语气这块再软一点会更好', '语气这块再软一点会更好，别太硬'],
  ['检索表现想再升级一下', '检索表现想再升级一下，换个方案'],
])
patch('test/time-awareness.test.mjs', [
  ['检索最后定成乙了', '检索最后定成乙方案，下周开始执行'],
])
