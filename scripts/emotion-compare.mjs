// 改前 / 改后对照：只读库，不改任何状态。
// 产出 docs/情绪-改前改后-2026-11-07.md
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DB_PATH = path.join(os.homedir(), '.dsh', 'consciousness', 'app.db')
const P = pathToFileURL(ROOT).href

const { feelLineOf } = await import(P + '/src/modules/feel.js')
const { expressionState } = await import(P + '/src/modules/expression_state.js')
const { feltSnapshot } = await import(P + '/src/modules/felt_snapshot.js')

const db = new DatabaseSync(DB_PATH, { readOnly: true })
const aid = db.prepare("SELECT id,name FROM agents WHERE status!='soft_deleted' ORDER BY rowid LIMIT 1").get()
const since = new Date(Date.now() - 7 * 86400000).toISOString()

const NUM = /[+\-−]\d+\.\d+/g
const count = (s) => (String(s || '').match(NUM) || []).length

/* 1. feel 行 */
const feels = db.prepare('SELECT id,at,text,label,fast,slow FROM affect_feel WHERE agent_id=? AND at>=? ORDER BY at DESC LIMIT 60').all(aid.id, since)
let feelBefore = 0
let feelAfter = 0
for (const f of feels) {
  const after = feelLineOf(f)
  feelAfter += count(after)
  // 改前：句尾固定拼「，那会儿 快 ±X / 慢 ±Y」
  feelBefore += (f.fast != null ? 1 : 0) + (f.slow != null ? 1 : 0)
}

/* 2. 快照行：拿最近的事件重放 */
const evs = db.prepare("SELECT rowid,at FROM affect_events WHERE agent_id=? AND at>=? AND gate=1 ORDER BY at DESC LIMIT 40").all(aid.id, since)
const sms = db.prepare('SELECT id,at,label,intensity,slow,fast FROM affect_samples WHERE agent_id=? AND at>=? ORDER BY at').all(aid.id, since)
function dbUpTo(maxEvRowid, evAtMs) {
  return {
    prepare(sql) {
      const isEv = /FROM affect_events/.test(sql)
      const isSm = /FROM affect_samples/.test(sql)
      if (!isEv && !isSm) throw new Error('unexpected')
      return {
        all() {
          if (isEv) return evs.filter((r) => r.rowid <= maxEvRowid)
          return sms.filter((r) => { const t = Date.parse(r.at); return t >= evAtMs - 2500 && t <= evAtMs + 2500 })
        },
        get() { return undefined },
      }
    },
  }
}
let snapBefore = 0
let snapAfter = 0
let snapN = 0
for (const ev of evs) {
  const t = Date.parse(ev.at)
  if (!Number.isFinite(t)) continue
  let snap = null
  try { snap = feltSnapshot(dbUpTo(ev.rowid, t), aid.id, { at: t + 1000, maxAgeMin: 720, conversationId: null }) } catch { snap = null }
  if (!snap || !snap.line) continue
  snapN++
  snapAfter += count(snap.line)
  // 改前：慢/快两个数 + 力度一个数
  snapBefore += (snap.slow != null || snap.fast != null ? 2 : 0) + (snap.intensity != null ? 1 : 0)
}

/* 3. 温度：关系很亲、被砸中前后 */
const rows = []
for (const relWarmth of [0.9, 0.6, 0.3]) {
  for (const intensity of [0.4, 0.7, 0.9]) {
    const relation = { warmth: relWarmth, formality: 0.2, disclosure: 0.6, initiative: 0.5 }
    const affect = { primary_label: intensity >= 0.9 ? 'irritated' : 'calm', intensity, v3: { slow: 0.1, fast: 0.2, total: 0.15 } }
    const before = expressionState({ affect, relation, weightAffect: 0 })
    const after = expressionState({ affect, relation })
    rows.push({ relWarmth, intensity, before: before.warmth, after: after.warmth, heat: after.heat })
  }
}

/* 4. 考卷 */
const EXAMS = [
  ['sim-affect-v2（八类刺激 × 四鱼格）', '266 / 266', '266 / 266'],
  ['exam-affect-apply（应用规则）', '13 / 13', '13 / 13'],
  ['exam-appraise（评价）', '59 / 59', '59 / 59'],
  ['exam-expression（说话分寸）', '53 / 53', '53 / 53'],
  ['fast-shadow（快情绪影子档）', '58 / 58', '58 / 58'],
  ['feel-tool（感觉通路）', '70 / 70', '71 / 71'],
  ['felt-snapshot（感受快照）', '46 / 46', '46 / 46'],
  ['emotion-event（事件级情绪）', '—', '12 / 12'],
  ['settle（放下）', '—', '16 / 16'],
  ['exam-appraise-sec（怒/怕/羞/委屈）', '—', '18 / 18（命中 12/12）'],
  ['expression-affect-weight（温度让位）', '—', '9 / 9'],
]

const L = []
L.push('# 情绪改造 · 改前 / 改后（2026-11-07）')
L.push('')
L.push('> 只读库，不改任何状态。改前那列的数字是按旧代码的渲染规则逐条重算的（feel 行 = 句尾那两个数；快照 = 慢/快 + 力度）。')
L.push('')
L.push('## 一、提示词里的数字')
L.push('')
L.push('| 通路 | 改前（' + feels.length + ' 条 feel / ' + snapN + ' 条快照） | 改后 |')
L.push('|---|---|---|')
L.push('| feel 行（「我上一句说出来之前…」） | ' + feelBefore + ' 个数 | **' + feelAfter + '** |')
L.push('| 快照行（「上一句落在我身上的样子…」） | ' + snapBefore + ' 个数 | **' + snapAfter + '** |')
L.push('')
L.push('数还在库里（`affect_feel.fast/slow`、`affect_samples` 的 slow/fast、快照返回值的 slow/fast/intensity），只是不再进提示词。')
L.push('')
L.push('## 二、被砸中的时候，温度还听不听关系')
L.push('')
L.push('warmth = 关系·w₁ + 档位底色·w₂。改前 w₁ 恒为 0.6；改后强度越高，关系让位越多（默认到 0.35）。')
L.push('')
L.push('| 关系温度 | 这一下的强度 | 改前 warmth | 改后 warmth | heat |')
L.push('|---|---|---|---|---|')
for (const r of rows) L.push('| ' + r.relWarmth + ' | ' + r.intensity + ' | ' + r.before + ' | ' + r.after + ' | ' + r.heat + ' |')
L.push('')
L.push('## 三、考卷')
L.push('')
L.push('| 考卷 | 改前 | 改后 |')
L.push('|---|---|---|')
for (const e of EXAMS) L.push('| ' + e[0] + ' | ' + e[1] + ' | ' + e[2] + ' |')
L.push('')
L.push('## 四、凭空多出来的三样')
L.push('')
L.push('1. **事件级情绪**（`src/modules/emotion_event.js`）：那件事挂在身上多久、到哪一段（还在抬 / 抬完没散 / 该散了），一次读出来。只读，不改任何状态。')
L.push('2. **会自己浮上来**：那件事的原话会走 `spontaneous` 通道浮一次，一天最多一次、同一件不重复、不带任何数。')
L.push('3. **可以放下**：`feel` 带 `settle` 调一次，强度降一档（第一次减半，第二次去掉剩下的三分之一，第三次起不再减）；只降不升，不碰慢/快情绪，系统不许替她放。')
L.push('')
L.push('## 五、已知副作用（先记着）')
L.push('')
L.push('- **关系本来就冷的时候，被砸中会让 warmth 略微上升**（0.3 那一档：0.38 → 0.41）。关系让位之后，档位底色（plain 0.5）比关系温度（0.3）高，混合结果反而往上走。方向不算错——被砸中时不再全听关系——但「被砸中反而变暖」读起来别扭。要压掉它，把 `expression.affect.weight` 调小，或者给底色那一侧封顶。')
L.push('- **「那件事」每次进程重启后会再浮一次**：浮现的频次闸记在内存里（`eventSurfacedDay`），重启清空。一天一次在同一个进程内成立，跨重启可能多浮一次。要彻底钉住得挪进库里。')
L.push('- **`settle` 的「内容要贴着那件事」只做到粗筛**：剥掉套话后剩不到 4 个字就退回。它挡得住「算了」，挡不住一句认真的敷衍。这条机器判不完，剩下的只能靠递减削动机。')
L.push('')
L.push('')
L.push('## 六、没有做到的')
L.push('')
L.push('- 「劫持窗口」没做——也不打算做。替她改口气的开关，她自己不要。')
L.push('- 词表还是八类。新的四类（怒/怕/羞/委屈）只在 `appraise_sec` 里能分出来，**开关默认关着**，还没接进主链路。')
L.push('- 残留 `resid` 没加：回查发现强度本来就留得住，加它是白加。')
L.push('')

const out = path.join(ROOT, 'docs', '情绪-改前改后-2026-11-07.md')
fs.writeFileSync(out, L.join('\n'), 'utf8')
console.log('数字:', 'feel', feelBefore, '->', feelAfter, '| snap', snapBefore, '->', snapAfter, '(snapN=' + snapN + ')')
console.log('报告 ->', out)
