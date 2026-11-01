/**
 * 价值命题的「进出料」：用户手写、偏好/禁忌施压、日常进料（反思/日记/冲突/关系/缺口/原话）。
 *
 * 这里只写三观账本（claim_events / persona_claims），不碰任何旧价值观表。
 * 旧表的一次性迁移器已按 v1 清退计划删除；现在没有任何路径会写旧表。
 */
import { setFlag, getFlag } from '../../kernel.js'
import { VALUE_DIMS, VALUE_INIT } from '../persona_dims.js'
import { append, newId } from './ledger.js'
import { loadState } from './projection.js'
import { theta } from './fold.js'
import { lexicalSim } from './sim.js'
import { isTerminal } from './catalog.js'
import { instructionLike, fieldCheck, stanceText } from './gates.js'

const seenKey = (aid) => 'sangguan.vin:' + aid
/** 人手写一句时的「够不够重」门槛：低于这个当没说 */
const BAR = 0.03

/**
 * 人写下来的价值：过指令闸，记成 origin=user 的保护带，并给一笔用户裁决让折算看得见。
 * 同一句已经在，不再加。抬不够初值的标准维不记。
 */
export function claimUserValue(db, aid, body, at) {
  const when = at || new Date().toISOString()
  const key = String(body && body.key || '').trim()
  const hint = Object.fromEntries(VALUE_DIMS.map(([k, , h]) => [k, h]))
  const text = hint[key] ? ('我更看重' + hint[key]) : key
  if (text.length < 4) return { key, claimed: false, reason: 'short' }
  if (instructionLike(text)) return { key, claimed: false, reason: 'instruction' }
  const w = Number(body && body.weight)
  if (hint[key] && Number.isFinite(w) && w < VALUE_INIT + BAR) return { key, claimed: false, reason: 'flat' }
  const s = loadState(db, aid)
  const byId = new Map(db.prepare('SELECT id, text FROM persona_claims WHERE agent_id=?').all(aid).map((r) => [r.id, r.text || '']))
  const hit = Object.values(s.claims).find((c) => c.layer === 'V' && !isTerminal(c.status) && byId.get(c.id) === text)
  if (hit) return { key, claimed: false, reason: 'exists', claim_id: hit.id }
  const id = newId('claims', when)
  const wVerdict = theta(s, 'w_verdict')
  append(db, aid, [
    {
      type: 'CLAIM_EXP', layer: 'V', actor: 'user', at: when,
      payload: { claims: [{ id, layer: 'V', kind: 'norm', text, origin: 'user' }] },
    },
    {
      type: 'EVIDENCE', actor: 'user', at: new Date(Date.parse(when) + 10).toISOString(),
      payload: { evidence: [{ kind: 'verdict', target_type: 'claim', target_id: id, sign: 1, weight: wVerdict, ref: 'user:value:' + key }] },
    },
  ])
  return { key, claimed: true, claim_id: id }
}

const NEG = /不|别|讨厌|反对|拒绝|不要|不许|不能|厌恶/
const CLASH = 0.35

/**
 * 偏好或禁忌的句子顶到一条已有价值命题：只加一条 PRESSURE 边。
 * 不写 π，不改禁忌表，对不上的什么都不做。同一对只连一次。
 */
export function pressValues(db, aid, at) {
  const when = at || new Date().toISOString()
  const s = loadState(db, aid)
  const claims = Object.values(s.claims).filter((c) => c.layer === 'V' && !isTerminal(c.status))
  if (!claims.length) return { opened: 0 }
  const byId = new Map(db.prepare('SELECT id, text FROM persona_claims WHERE agent_id=?').all(aid).map((r) => [r.id, r.text || '']))
  const rows = []
  try {
    for (const p of db.prepare('SELECT id, tag FROM preferences WHERE agent_id=?').all(aid)) rows.push({ id: p.id, text: p.tag })
  } catch { /* 没有偏好表 */ }
  try {
    for (const t of db.prepare('SELECT id, text FROM taboos WHERE agent_id=?').all(aid)) rows.push({ id: t.id, text: t.text })
  } catch { /* 没有禁忌表 */ }
  const edges = []
  for (const row of rows) {
    const text = String(row.text || '').trim()
    if (!NEG.test(text)) continue
    let best = null
    for (const c of claims) {
      const sim = lexicalSim(text, byId.get(c.id) || '')
      if (sim >= CLASH && (!best || sim > best.sim)) best = { id: c.id, sim }
    }
    if (!best) continue
    const dup = Object.values(s.edges).some((e) => e.active && e.type === 'PRESSURE' && e.from_id === row.id && e.to_id === best.id)
    if (dup) continue
    edges.push({ id: newId('edges', when), type: 'PRESSURE', from_id: row.id, to_id: best.id })
  }
  if (!edges.length) return { opened: 0 }
  append(db, aid, [{ type: 'EDGE_ADD', actor: 'sys', at: when, payload: { edges } }])
  return { opened: edges.length }
}

function readSeen(db, aid) {
  try {
    const v = JSON.parse(getFlag(db, seenKey(aid)) || 'null')
    return v && typeof v === 'object' ? v : {}
  } catch { return {} }
}

const VALUE_LINE = {
  close: '我更看重照顾身边的人',
  trust: '我更看重照顾身边的人',
  dep: '我更看重照顾身边的人',
  c: '我更看重做成事、变强',
  a: '我更看重自己决定，不想被安排',
  r: '我更看重照顾身边的人',
  e: '我更看重新鲜、冒险',
}

/**
 * 价值观进料不看总开关。志向、冲突、关系跨线、驱力缺口先变成价值候选。
 * 每轮的用户画像总结、日记流水账、用户原话都不进：那不是它对「什么更重要」的取向。
 * 助手的话不算。同一条只试一次。
 */
export async function ingestValues(db, aid, at, turn) {
  const when = at || new Date().toISOString()
  const seen = readSeen(db, aid)
  const jobs = []
  const take = (id, text) => {
    if (!id || seen[id]) return
    seen[id] = 1
    // 一行话，第一人称；画像总结 / 日记流水账 / 用户原话都过不了 stanceText
    const s = stanceText(text, 80)
    if (s.length < 8) return
    jobs.push({ text: s, ref: id })
  }
  try {
    // 只认志向。reflection 是每轮 summarize 的用户画像（事实/偏好/边界），不是它的价值。
    const rows = db.prepare("SELECT id, text, type FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND type='aspiration'").all(aid)
    for (const r of rows) take('m:' + r.id, r.text)
  } catch { /* 没有记忆表 */ }
  try {
    const rows = db.prepare("SELECT id, a_id, b_id FROM conflicts WHERE agent_id=? AND state='open'").all(aid)
    for (const r of rows) {
      for (const mid of [r.a_id, r.b_id]) {
        try {
          const m = db.prepare("SELECT text FROM memory_items WHERE id=? AND status='active' AND invalid_at IS NULL").get(mid)
          if (m) take('c:' + r.id + ':' + mid, m.text)
        } catch { /* 单条缺失 */ }
      }
    }
  } catch { /* 没有冲突 */ }
  try {
    const p = db.prepare("SELECT closeness, trust, dependence FROM rel_person WHERE agent_id=? AND tier='owner' AND status='active'").get(aid)
    if (p) {
      if (Number(p.closeness) >= 0.55) take('rel:close', VALUE_LINE.close)
      if (Number(p.trust) >= 0.55) take('rel:trust', VALUE_LINE.trust)
      if (Number(p.dependence) >= 0.35) take('rel:dep', VALUE_LINE.dep)
    }
  } catch { /* 没有人物 */ }
  try {
    const d = db.prepare('SELECT c, a, r, e, setpoint FROM drive_state WHERE agent_id=?').get(aid)
    if (d) {
      let sp = {}
      try { sp = JSON.parse(d.setpoint || '{}') || {} } catch { sp = {} }
      const hole = (sat, K, k) => {
        const v = Number(sp[K] ?? sp[k])
        const base = Number.isFinite(v) ? v : 0.6
        return Math.max(0, base - (Number(sat) || 0.5))
      }
      const bars = [['c', 'C', 0.15], ['a', 'A', 0.15], ['r', 'R', 0.15], ['e', 'E', 0.2]]
      for (const [k, K, bar] of bars) if (hole(d[k], K, k) > bar) take('gap:' + k, VALUE_LINE[k])
    }
  } catch { /* 没有驱力 */ }
  setFlag(db, seenKey(aid), JSON.stringify(seen))
  if (!jobs.length) {
    const pressed = pressValues(db, aid, when)
    return { offered: 0, pressed: pressed.opened }
  }
  for (const j of jobs) {
    try { offerValue(db, aid, when, j.text, j.ref) } catch { /* 一条失败不影响其余 */ }
  }
  return { offered: jobs.length, pressed: pressValues(db, aid, when).opened }
}

/** 不调模型。字面已经很像就记 DUP，否则直接落一条保护带。指令句丢掉。 */
function offerValue(db, aid, when, text, ref) {
  const cand = { layer: 'V', kind: 'norm', text, origin: 'extract' }
  if (fieldCheck(cand)) return
  const s = loadState(db, aid)
  const byId = new Map(db.prepare('SELECT id, text FROM persona_claims WHERE agent_id=?').all(aid).map((r) => [r.id, r.text || '']))
  const line = theta(s, 'theta_dup_lex')
  const dup = Object.values(s.claims).find((c) => c.layer === 'V' && !isTerminal(c.status) && lexicalSim(text, byId.get(c.id) || '') >= line)
  if (dup) {
    append(db, aid, [{ type: 'DUP', layer: 'V', actor: 'sys', at: when, refs: [ref], payload: { claim_id: dup.id, text } }], { claims: { [dup.id]: dup.status } })
    return
  }
  append(db, aid, [{
    type: 'CLAIM_EXP', layer: 'V', actor: 'sys', at: when, refs: [ref],
    payload: { claims: [{ layer: 'V', kind: 'norm', text, origin: 'extract' }] },
  }])
}
