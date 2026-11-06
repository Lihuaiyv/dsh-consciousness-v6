import fs from 'node:fs'
const plan = [
  ['index.js', ['DIMS','speakTurn','selfInquiry','touchSession','bindingsOf','runningAgentIds','maxRunning','parseChatKey','qqSessionPrefix']],
  ['src/modules/archive.js', ['getParam','foldValueWeights']],
  ['src/modules/sangguan/api.js', ['shadowOf']],
  ['src/modules/sangguan/score.js', ['SIGMA_OPEN']],
  ['src/modules/values.js', ['tx']],
]
let total = 0
for (const [f, names] of plan) {
  let s = fs.readFileSync(f, 'utf8')
  let n = 0
  s = s.replace(/import\s*\{([^}]*)\}\s*from\s*(['"][^'"]+['"])/g, (m, body, src) => {
    const parts = body.split(',').map((x) => x.trim()).filter(Boolean)
    const kept = parts.filter((p) => {
      const bare = p.split(/\s+as\s+/)[0].trim()
      if (names.includes(bare)) { n++; return false }
      return true
    })
    if (kept.length === parts.length) return m
    return 'import { ' + kept.join(', ') + ' } from ' + src
  })
  if (n) { fs.writeFileSync(f, s, 'utf8'); console.log(f, '-> removed', n) }
  else console.log(f, '-> nothing removed')
  total += n
}
console.log('total removed:', total)
