import fs from 'node:fs'
const p = 'src/modules/passport.js'
let s = fs.readFileSync(p, 'utf8')
const before = s.length

// 1) 删死分支：stampRow 只产生 invalid / topic_key / topic_state，'topic_weak' 永远不成立
const dead = [
  "      if (s.source === 'topic_weak') {",
  '        // 弱标默认不进注入（只在体检/调试里看）；关着时继续找跨库证据',
  "        if (String(opt && opt.weak) !== 'on') return crossLayerNote(db, aid, row, opt)",
  "        return '（' + (from ? from + ' 说的；' : '') + '同主题后面还有一条更晚的说法）'",
  '      }',
  '',
].join('\n')
if (!s.includes(dead)) { console.error('dead block not found'); process.exit(1) }
s = s.replace(dead, '')

// 2) 注释对齐现实（旧字段在 stampRow 里不存在，别让后来人以为还有这档）
s = s.replace('// 只是同主题的（topic_weak）**不判旧**', '// 只是同主题的（weakLater）**不判旧**')
s = s.replace('// 状态词对（topic_state）/ 仅同主题（topic_weak）：只标，不挤。', '// 状态词对（topic_state）：只标，不挤。')

fs.writeFileSync(p, s, 'utf8')
console.log('removed chars:', before - s.length)
console.log('topic_weak left:', (s.match(/topic_weak/g) || []).length)
