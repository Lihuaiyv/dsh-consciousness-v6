/**
 * 旧通道只提供候选，不改 π。冲突、反思、志向、日记、关系跨门槛、驱力缺口
 * 都先变成句子；证据仍只来自用户回合和能对上的行动结局。禁忌不读。
 */
import { getFlag, setFlag } from '../../kernel.js'
import { isEnabled, laneOn } from './config.js'
import { append } from './ledger.js'
import { loadState } from './projection.js'
import { theta } from './fold.js'
import { isTerminal } from './catalog.js'
import { noteSystem } from './fast.js'
import { stanceText, stanceGate } from './gates.js'

const relKey = (aid) => 'sangguan.intake.rel:' + aid
const memKey = (aid) => 'sangguan.intake.mem:' + aid
const actKey = (aid) => 'sangguan.intake.act:' + aid
const gapKey = (aid) => 'sangguan.intake.gap:' + aid
const diaryKey = (aid) => 'sangguan.intake.diary:' + aid

function readJson(db, key) {
  try {
    const v = JSON.parse(getFlag(db, key) || 'null')
    return v && typeof v === 'object' ? v : {}
  } catch { return {} }
}

function memoryText(db, id) {
  try {
    const r = db.prepare("SELECT text FROM memory_items WHERE id=? AND status='active' AND invalid_at IS NULL").get(id)
    return r ? String(r.text || '').trim() : ''
  } catch { return '' }
}

/** 反思 / 志向 / 未结冲突 → 候选句。同一记忆只出一次。 */
export function intakeCandidates(db, aid) {
  if (!isEnabled(db, aid)) return []
  const seen = readJson(db, memKey(aid))
  const out = []
  const mark = (id) => { seen[id] = 1 }
  try {
    // 只认志向。reflection 是 features 每轮 summarize 出来的「用户画像」（事实/偏好/边界），
    // 主语是用户，不是它的立场；日记同理是流水账。把它们原样搬进 L 层，
    // 页首就会变成「用户只问…未提供其他信息」——那不是人生观。
    const rows = laneOn(db, aid, 'L') ? [] : db.prepare("SELECT id, text, type FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND type='aspiration' ORDER BY created_at").all(aid)
    for (const r of rows) {
      if (seen[r.id]) continue
      mark(r.id)
      const text = stanceText(r.text, 80)
      if (!text) continue
      // 志向是记忆层判的，判错的时候会把「先做自启再上服务器」也叫志向；这里再问一句是不是立场
      if (stanceGate(text)) continue
      out.push({ layer: 'L', kind: 'chapter', text, ref: r.id })
    }
  } catch { /* 老库没有记忆表 */ }
  try {
    const rows = laneOn(db, aid, 'W') ? [] : db.prepare("SELECT id, a_id, b_id FROM conflicts WHERE agent_id=? AND state='open'").all(aid)
    for (const r of rows) {
      if (seen['c:' + r.id]) continue
      const a = memoryText(db, r.a_id)
      const b = memoryText(db, r.b_id)
      if (!a || !b) continue
      mark('c:' + r.id)
      // 冲突的两侧原来直接 slice 进 W 层，连立场都不问——「电脑关机插件没开」就是这么进来的。
      // 现在逐条过闸：不像立场的记 REJECT 由上层处理，这里先不收。
      for (const [txt, tag] of [[a, ':a'], [b, ':b']]) {
        if (stanceGate(txt)) continue
        out.push({ layer: 'W', kind: 'obs', text: txt.slice(0, 300), ref: r.id + tag })
      }
    }
  } catch { /* 没有冲突表 */ }
  try {
    const rows = laneOn(db, aid, 'L')
      ? []
      : db.prepare('SELECT id, text FROM diaries WHERE agent_id=? ORDER BY created_at').all(aid)
    for (const r of rows) {
      if (seen['d:' + r.id]) continue
      const text = String(r.text || '').trim()
      if (!text) continue
      mark('d:' + r.id)
      out.push({ layer: 'L', kind: 'chapter', text: text.slice(0, 300), ref: 'd:' + r.id })
    }
  } catch { /* 没有日记 */ }
  setFlag(db, memKey(aid), JSON.stringify(seen))
  return out
}

function notice(db, aid, ref, text, n) {
  if (noteSystem(db, aid, text, ref)) n.notices++
}

/** 关系跨门槛、驱力缺口：只写发生了什么，同一方向只报一次。 */
export function intakeNotices(db, aid) {
  const n = { notices: 0 }
  if (!isEnabled(db, aid)) return n
  const rel = readJson(db, relKey(aid))
  try {
    const p = db.prepare("SELECT name, closeness, trust, dependence FROM rel_person WHERE agent_id=? AND tier='owner' AND status='active'").get(aid)
    if (p) {
      const name = p.name || '对方'
      if (Number(p.closeness) >= 0.55 && !rel.close) { rel.close = 1; notice(db, aid, 'rel:close', '跟' + name + '的亲近跨过了往常的线', n) }
      if (Number(p.trust) >= 0.55 && !rel.trust) { rel.trust = 1; notice(db, aid, 'rel:trust', '跟' + name + '的信任跨过了往常的线', n) }
      if (Number(p.dependence) >= 0.35 && !rel.dep) { rel.dep = 1; notice(db, aid, 'rel:dep', name + '对这里的依赖跨过了往常的线', n) }
    }
  } catch { /* 没有人物账本 */ }
  setFlag(db, relKey(aid), JSON.stringify(rel))

  const gap = readJson(db, gapKey(aid))
  try {
    const d = db.prepare('SELECT c, a, r, e, setpoint FROM drive_state WHERE agent_id=?').get(aid)
    if (d) {
      let sp = {}
      try { sp = JSON.parse(d.setpoint || '{}') || {} } catch { sp = {} }
      const spOf = (K, k) => {
        const v = Number(sp[K] ?? sp[k])
        return Number.isFinite(v) ? v : 0.6
      }
      const hole = (sat, K, k) => Math.max(0, spOf(K, k) - (Number(sat) || 0.5))
      const bits = [
        ['C', 'c', '成就这一维一直空着', 0.15],
        ['A', 'a', '自主这一维一直空着', 0.15],
        ['R', 'r', '关系这一维一直空着', 0.15],
        ['E', 'e', '眼前的刺激一直空着', 0.2],
      ]
      for (const [K, k, text, bar] of bits) {
        if (hole(d[k], K, k) > bar && !gap[k]) { gap[k] = 1; notice(db, aid, 'gap:' + k, text, n) }
      }
    }
  } catch { /* 没有驱力 */ }
  setFlag(db, gapKey(aid), JSON.stringify(gap))
  return n
}

/** 行动结局对得上已有 ν 才写成 act。对不上就丢掉，不新建命题。 */
export function intakeActs(db, aid, at) {
  const out = { written: 0, rejected: 0 }
  if (!isEnabled(db, aid)) return out
  const done = readJson(db, actKey(aid))
  let rows = []
  try { rows = db.prepare('SELECT id, payload, status FROM action_log WHERE agent_id=?').all(aid) } catch { return out }
  const s = loadState(db, aid)
  for (const r of rows) {
    if (done[r.id] || r.status !== 'done') continue
    done[r.id] = 1
    let p = {}
    try { p = JSON.parse(r.payload || '{}') || {} } catch { p = {} }
    const nuId = p.nu_id
    if (!nuId) { out.rejected++; continue }
    const nu = s.nus[nuId]
    if (!nu || nu.outcome !== 'pending') { out.rejected++; continue }
    const claim = s.claims[nu.claim_id]
    if (!claim || isTerminal(claim.status)) { out.rejected++; continue }
    const sign = p.sign === -1 ? -1 : 1
    try {
      append(db, aid, [{
        type: 'EVIDENCE', actor: 'sys', at,
        payload: { evidence: [{ kind: 'act', target_type: 'nu', target_id: nuId, sign, weight: theta(s, 'w_act'), ref: 'act:' + r.id }] },
      }])
      out.written++
    } catch { out.rejected++ }
  }
  setFlag(db, actKey(aid), JSON.stringify(done))
  return out
}

/** 说话用的令牌耗尽时，提问推迟。不新开一种冷却。 */
export function askBlocked(db, aid) {
  try {
    const row = db.prepare('SELECT tokens FROM drive_state WHERE agent_id=?').get(aid)
    if (!row) return false
    const tokens = JSON.parse(row.tokens || '{}')
    return Number(tokens.c4) <= 0
  } catch { return false }
}
