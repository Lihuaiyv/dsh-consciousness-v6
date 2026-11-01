import { now } from '../db.js'
import { err, nid, agent, active } from '../kernel.js'
import { seedAffect } from './affect.js'
import { seedDrive } from './drive.js'
import { tickRitual as tickRitualLedger, syncLegacyToLedger } from './relations.js'
import { seedRuleBindings } from './artifacts.js'
import { AXIS_KEYS, AXIS_DEFAULTS, NEUTRAL, shrinkAxes, isAxisPath, axesView, setAxisManual, releaseAxis } from './traits.js'

/**
 * 手写区的字数上限。这些字每轮都会进系统提示，所以按「最坏情况注入」定预算：
 * tone+address+catchphrase+banned+card = 93 字 ≈ 66 token。
 * 客户端按 GET /persona/selfview 的 limits 渲染计数器；这里才是真源。
 */
export const STYLE_LIMITS = Object.freeze({
  'style.tone': 8,
  'style.address': 4,
  'style.catchphrase': 6,
  'style.banned': 15,
  'style.card': 60,
})

export const LIMITS = Object.freeze({
  style: STYLE_LIMITS,
  valueKey: 24,
  relationName: 12,
  preferenceTag: 16,
  tabooText: 60,
})

function charLen(v) {
  return Array.from(String(v == null ? '' : v)).length
}

function requireText(v, max, label) {
  const s = String(v == null ? '' : v).trim()
  if (!s) err(400, 'INVALID_ARGUMENT', label + '必填')
  if (charLen(s) > max) err(400, 'INVALID_ARGUMENT', label + '最多 ' + max + ' 字')
  return s
}

/** 只种人格表；完整出生态走 seedState（编排，不直写外域表） */
export function seedPersona(db, aid) {
  for (const k of AXIS_KEYS) db.prepare('INSERT OR REPLACE INTO persona VALUES(?,?,?,?,?)').run(aid, 'axis.' + k, String(AXIS_DEFAULTS[k] ?? NEUTRAL), 'auto', now())
  // 价值观真源是 persona_values（growValues / setValue）；不再种无人读的 values.weight
}

export function seedState(db, aid) {
  seedPersona(db, aid)
  seedAffect(db, aid)
  seedDrive(db, aid)
  seedRuleBindings(db, aid)
}

/** query：root 禁忌文本（供七闸，禁止外域直读 taboos） */
export function listRootTaboos(db, aid) {
  return db.prepare("SELECT text FROM taboos WHERE agent_id=? AND level='root'").all(aid)
}

export function getPersona(db, aid) {
  agent(db, aid)
  return db.prepare('SELECT * FROM persona WHERE agent_id=? ORDER BY path').all(aid).map((r) => {
    let value = r.value
    try { value = JSON.parse(r.value) } catch { /* keep raw */ }
    return { path: r.path, value, origin: r.origin, updated_at: r.updated_at }
  })
}

/** 设置页「情绪 · 敏感度」整块：五条轴 + 当前 σ 的实际效果 + 滑杆要用的曲线 */
export function personaAxes(db, aid) {
  agent(db, aid)
  return axesView(db, aid)
}

export function setPersona(db, aid, path, body, role) {
  if (role !== 'user') err(403, 'FORBIDDEN', '只有 user 可以手写鱼格')
  active(db, aid)
  if (body.value === undefined) err(400, 'INVALID_ARGUMENT', 'value 必填')
  // 五条性格轴：0~1 的连续值，写 manual（不再自动漂）；body.origin='auto' 表示交回给经历
  if (isAxisPath(path)) {
    const key = String(path).slice(5)
    if (body.origin === 'auto') {
      const out = releaseAxis(db, aid, key)
      return { path, key, value: out.value, origin: 'auto' }
    }
    const v = Number(body.value)
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      err(400, 'INVALID_ARGUMENT', '性格轴要在 0~1 之间（敏感度 0 = 完全钝，1 = 一点就着）')
    }
    const out = setAxisManual(db, aid, key, v)
    return { path, key, value: out.after, before: out.before, origin: 'manual' }
  }
  if (path.startsWith('style.') && !STYLE_LIMITS[path]) {
    err(400, 'INVALID_ARGUMENT', '未知的鱼格字段：' + path)
  }
  const max = STYLE_LIMITS[path]
  if (max && charLen(body.value) > max) {
    err(400, 'INVALID_ARGUMENT', path + ' 最多 ' + max + ' 字（这些字每轮都会进提示词）')
  }
  db.prepare('INSERT OR REPLACE INTO persona VALUES(?,?,?,?,?)').run(aid, path, JSON.stringify(body.value), 'manual', now())
  return { path, value: body.value, origin: 'manual', limit: max || null }
}

export function setPersonaAuto(db, aid, path, value, why) {
  active(db, aid)
  db.prepare('INSERT OR REPLACE INTO persona VALUES(?,?,?,?,?)').run(aid, path, JSON.stringify(value), 'auto', now())
  return { path, value, origin: 'auto', why: why || '' }
}

/** 长期没变化时，把自动区缓慢拉回基线 0.5（每次 2%） */
export function shrinkPersona(db, aid) {
  return shrinkAxes(db, aid)
}

// ---------------- 关系 / 价值观 / 偏好 / 禁忌（从 features 收回本域） ----------------

export function seedRelations(db, aid) {
  const rows = [
    ['主人', 'owner', 0.55, 0.6, 0.2, 1],
    ['熟人', 'acquaintance', 0.25, 0.4, 0.05, 0],
    ['陌生人', 'stranger', 0.1, 0.3, 0.0, 0],
  ]
  for (const [name, kind, c, t, d, root] of rows) {
    if (db.prepare('SELECT 1 FROM relations WHERE agent_id=? AND name=?').get(aid, name)) continue
    db.prepare('INSERT INTO relations VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(nid('rel_'), aid, name, kind, c, t, d, root, null, now(), now())
  }
}

export function listRelations(db, aid) {
  agent(db, aid)
  return db.prepare('SELECT * FROM relations WHERE agent_id=? ORDER BY root DESC, closeness DESC').all(aid)
}

export function upsertRelation(db, aid, body) {
  active(db, aid)
  const name = requireText(body.name, LIMITS.relationName, '名字')
  const id = body.id || nid('rel_')
  const old = body.id ? db.prepare('SELECT * FROM relations WHERE id=? AND agent_id=?').get(body.id, aid) : null
  const v = (x, d) => (x === undefined ? d : Number(x))
  const kind = body.kind || old?.kind || 'acquaintance'
  const closeness = v(body.closeness, old?.closeness ?? 0.2)
  const trust = v(body.trust, old?.trust ?? 0.2)
  const dependence = v(body.dependence, old?.dependence ?? 0)
  const notes = body.notes ?? old?.notes ?? null
  const root = body.root ? 1 : old?.root || 0
  db.prepare('INSERT OR REPLACE INTO relations VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, aid, name, kind, closeness, trust, dependence, root, notes, old?.created_at || now(), now())
  // 活账本才是注入 / 面板真源；旧表只镜像
  try {
    syncLegacyToLedger(db, aid, {
      name, kind: root ? 'owner' : kind, closeness, trust, dependence, notes, legacy_id: id,
    })
  } catch { /* 账本失败不回滚旧表：读方仍有兜底 */ }
  return { id }
}

export function deleteRelation(db, id) {
  const r = db.prepare('SELECT * FROM relations WHERE id=?').get(id)
  if (!r) err(404, 'NOT_FOUND', '关系不存在')
  if (r.root) err(409, 'RED_LINE', 'root 关系不能删除')
  db.prepare('DELETE FROM relations WHERE id=?').run(id)
  return { id, deleted: true }
}

export function listValues(db, aid) {
  agent(db, aid)
  return db.prepare('SELECT * FROM persona_values WHERE agent_id=? ORDER BY weight DESC').all(aid)
}

export function setValue(db, aid, body) {
  active(db, aid)
  const key = requireText(body.key, LIMITS.valueKey, '价值观键')
  const w = Math.max(0, Math.min(1, Number(body.weight ?? 0.1)))
  db.prepare('INSERT OR REPLACE INTO persona_values VALUES(?,?,?,?,?)')
    .run(aid, key, w, JSON.stringify(body.evidence || []), now())
  return { key, weight: w }
}

export function listPreferences(db, aid) {
  agent(db, aid)
  return db.prepare('SELECT * FROM preferences WHERE agent_id=? ORDER BY aversion DESC').all(aid)
}

export function addPreference(db, aid, body) {
  active(db, aid)
  const tag = requireText(body.tag, LIMITS.preferenceTag, '偏好标签')
  const id = nid('prf_')
  db.prepare('INSERT INTO preferences VALUES(?,?,?,?,?,?)')
    .run(id, aid, tag, Math.max(0, Math.min(1, Number(body.aversion ?? 0))), body.origin || 'auto', now())
  return { id }
}

export function listTaboos(db, aid) {
  agent(db, aid)
  return db.prepare('SELECT * FROM taboos WHERE agent_id=? ORDER BY created_at').all(aid)
}

/**
 * 删一条偏好。
 * 「只增不减」说的是它自己长出来的那部分：origin=auto 一律不许删；
 * 人写进去的（origin=manual）可以收回——先认来源，再动手。
 */
export function removePreference(db, aid, id) {
  agent(db, aid)
  const row = db.prepare('SELECT * FROM preferences WHERE id=? AND agent_id=?').get(id, aid)
  if (!row) err(404, 'NOT_FOUND', '这条偏好不存在')
  if (row.origin === 'auto') err(409, 'LOCKED', '「' + row.tag + '」是它自己长出来的，删不掉')
  db.prepare('DELETE FROM preferences WHERE id=?').run(id)
  return { id, deleted: true, tag: row.tag }
}

export function addTaboo(db, aid, body) {
  active(db, aid)
  const text = requireText(body.text, LIMITS.tabooText, '禁忌内容')
  const id = nid('tab_')
  db.prepare('INSERT INTO taboos VALUES(?,?,?,?,?,?)')
    .run(id, aid, text, body.level === 'root' ? 'root' : 'soft', body.origin || 'manual', now())
  return { id }
}
// ---------------- 关系的时间效应（6 号 R09） ----------------
/** R09：转发到人物账本（rel_person）；旧 relations 只镜像。 */
export function tickRitual(db, aid) {
  return tickRitualLedger(db, aid)
}