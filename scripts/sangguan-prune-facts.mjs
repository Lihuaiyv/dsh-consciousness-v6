/**
 * P5 清库：把「不是立场」的命题从三观里清出去。
 *
 * 只认三条：
 *   1. 只清保护带（核心不动，核心要走升维）
 *   2. 只清抽取/合成来的（origin=user 是人手写的，不动）
 *   3. 用 stanceGate 判：没有取向词、又提到工程语汇或写成待办的，算不是立场
 *
 * 清的方式是写 CLAIM_RETIRE（账本只增，不删行）；reasons 记在 payload 里，可回查。
 * 默认 dry-run，只有 --yes 才真写；写之前先把库复制一份。
 *
 * 用法：
 *   node scripts/sangguan-prune-facts.mjs                 # dry-run（默认）
 *   node scripts/sangguan-prune-facts.mjs --yes           # 真写
 *   node scripts/sangguan-prune-facts.mjs --aid agt_xxx   # 只清一个 agent
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const flag = (k) => argv.includes(k)
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }

const dbPath = opt('--db', path.join(os.homedir(), '.dsh', 'consciousness', 'app.db'))
const onlyAid = opt('--aid', null)
const idsArg = opt('--ids', null)
const ids = idsArg ? idsArg.split(',').map((x) => x.trim()).filter(Boolean) : null
const reason = opt('--reason', ids ? '按三列判据不合格' : 'not_stance：这句不是它对世界的看法')
const lanesMode = flag('--lanes')
const keepArg = opt('--keep', null)
const keep = keepArg ? keepArg.split(',').map((x) => x.trim()).filter(Boolean) : []
const yes = flag('--yes')

process.env.DSH_HOME = flag('--db') ? path.dirname(dbPath) : path.join(os.homedir(), '.dsh')
const { openDb } = await import('../src/db.js')
const { loadState } = await import('../src/modules/sangguan/projection.js')
const { stanceGate } = await import('../src/modules/sangguan/gates.js')
const { retireClaim } = await import('../src/modules/sangguan/retire.js')
const { isCoreKind, isTerminal } = await import('../src/modules/sangguan/catalog.js')
const { laneCheck } = await import('../src/modules/sangguan/gates.js')
const { metaOf } = await import('../src/modules/sangguan/meta.js')

const db = openDb(dbPath)
const at = new Date().toISOString()
const lines = []
const plan = []

let agents = []
try { agents = db.prepare('SELECT id,name FROM agents').all() } catch { agents = [] }
for (const a of agents) {
  if (onlyAid && a.id !== onlyAid) continue
  let s = null
  try { s = loadState(db, a.id) } catch { continue }
  let texts = new Map()
  try { texts = new Map(db.prepare('SELECT id,text FROM persona_claims WHERE agent_id=?').all(a.id).map((r) => [r.id, r.text || ''])) } catch { /* 空库 */ }
  for (const c of Object.values(s.claims)) {
    if (isTerminal(c.status) || c.status !== 'active') continue
    if (isCoreKind(c.layer, c.kind)) continue
    if (c.origin === 'user') continue
    if (ids) {
      if (ids.includes(c.id)) plan.push({ aid: a.id, agent: a.name || a.id, id: c.id, layer: c.layer, kind: c.kind, origin: c.origin, text: (texts.get(c.id) || '').slice(0, 90) })
      continue
    }
    const text = texts.get(c.id) || ''
    if (!text) continue
    // --lanes：按三列各自的判据重判（旧条目没有 meta，W/L 会直接判不合格）
    if (lanesMode) {
      if (keep.includes(c.id)) continue
      const reason = laneCheck({ layer: c.layer, kind: c.kind, text, meta: metaOf(c) }, { W: true, L: true, V: true })
      if (reason) plan.push({ aid: a.id, agent: a.name || a.id, id: c.id, layer: c.layer, kind: c.kind, origin: c.origin, text, reason })
      continue
    }
    if (!stanceGate(text)) continue
    plan.push({ aid: a.id, agent: a.name || a.id, id: c.id, layer: c.layer, kind: c.kind, origin: c.origin, text })
  }
  // 悬空 ν：命题被收回后，指向它的、还没到期的预见要先作废，否则「预见与回流」会指向一条退休的命题
  for (const p of plan) {
    p.nus = Object.values(s.nus).filter((n) => n.claim_id === p.id && n.outcome === 'pending').map((n) => n.id)
  }
}

lines.push('库：' + dbPath)
lines.push('模式：' + (yes ? '真写（先作废悬空 ν，再 CLAIM_RETIRE）' : 'dry-run（只看不写）'))
lines.push('待清 ' + plan.length + ' 条')
for (const p of plan) {
  const nu = p.nus && p.nus.length ? '　ν 待作废 ' + p.nus.length + ' 条' : ''
  lines.push('  [' + p.layer + '/' + p.kind + '/' + p.origin + '] ' + p.id + '  ' + String(p.text).slice(0, 90) + nu)
}

if (yes && plan.length) {
  const bak = dbPath + '.bak-prune-' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
  fs.copyFileSync(dbPath, bak)
  for (const suf of ['-wal', '-shm']) { try { fs.copyFileSync(dbPath + suf, bak + suf) } catch { /* ignore */ } }
  lines.push('已备份：' + bak)
  let ok = 0
  let voided = 0
  const bad = []
  for (const p of plan) {
    try {
      // retireClaim 内部同一批次：先把没到期的预见作废，再收回命题。失败整批回滚，不留半条。
      const r = retireClaim(db, p.aid, p.id, { at, reason: p.reason || reason, actor: 'user' })
      voided += r.voided.length
      if (r.retired) ok++
    } catch (e) { bad.push(p.id + ' ' + (e.code || e.message)) }
  }
  lines.push('已清退 ' + ok + ' 条；作废预见 ' + voided + ' 条；失败 ' + bad.length)
  for (const b of bad) lines.push('  失败：' + b)
}

const out = path.join(process.cwd(), '_prune.txt')
fs.writeFileSync(out, lines.join('\n'), 'utf8')
console.log(lines.join('\n'))
console.log('\n写入 ' + out)
db.close()
