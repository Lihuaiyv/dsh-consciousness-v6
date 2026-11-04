/**
 * 常驻宪章：三列各挑一条代表，压成三行，≤400 token。
 *
 * 为什么只三条：每轮都带的东西，多一条就多一分被平均掉的风险。
 * 每列有核心用核心；没有核心就退到 e 最高的那条活跃命题（recall.coreIds 的取法），
 * 不再强求「非核心不可」——空着一列比拿一条保护带顶替更糟，这里取的是「这一列现在最像它自己的一句」。
 */
import { loadState } from './projection.js'
import { claimTexts, coreIds } from './recall.js'

const LEAD = { W: '你看世界的方式：', L: '你的人生观：', V: '你更看重：' }
const TOKEN_CAP = 400
const est = (t) => Math.ceil(String(t || '').length / 2)

/**
 * @returns {{lines:string[], text:string, tokens:number, ids:string[], skipped:string[]}}
 */
export function buildConstitution(db, aid, opt = {}) {
  const cap = opt.tokenCap || TOKEN_CAP
  const s = loadState(db, aid)
  const texts = claimTexts(db, aid)
  const lines = []
  const ids = []
  const skipped = []
  for (const id of coreIds(s)) {
    const c = s.claims[id]
    const t = texts.get(id)
    if (!c || !t) continue
    const lead = LEAD[c.layer]
    if (!lead) continue
    const line = lead + String(t).slice(0, opt.maxChars || 80)
    if (est(lines.join('\n') + '\n' + line) > cap) { skipped.push(id); continue }
    lines.push(line)
    ids.push(id)
  }
  const text = lines.join('\n')
  return { lines, text, tokens: est(text), ids, skipped }
}
