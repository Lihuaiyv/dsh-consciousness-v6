/**
 * 实体归一化（P2）
 *
 * 目的只有一个：让「同一件事的不同说法」能并到一起。
 * 「用户喜欢喝美式咖啡」和「主人爱喝美式」——字面几乎不重叠，但说的是同一个东西；
 * 有 entity 才能把这两条判成一件，而不是越记越多。
 *
 * 现在是规则抽取（引号 / 我叫X / 我的猫叫X / 我在做X），不做实体消歧、不做关系推理。
 */

import { now } from '../db.js'
import { nid } from '../kernel.js'

const STOP = new Set(['这个', '那个', '我们', '你们', '他们', '自己', '什么', '怎么', '东西', '事情', '问题'])

/** 英文虚词与代码里高频但无实指的词：抽出来只会污染实体表。 */
const STOP_EN = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'are', 'was', 'were', 'have', 'has', 'not', 'but',
  'all', 'can', 'will', 'would', 'should', 'about', 'into', 'than', 'then', 'when', 'what', 'which', 'who', 'how', 'why',
  'user', 'assistant', 'system', 'true', 'false', 'null', 'undefined', 'json', 'text', 'message', 'error', 'data', 'type',
])

/** 技术名：必须带大写 / 点 / 下划线 / 连字符才算——纯小写英文多半是普通词。 */
const TECH_NAME = /(?<![A-Za-z0-9_.-])([A-Za-z][A-Za-z0-9_.-]{2,30})(?![A-Za-z0-9_.-])/g

const PATTERNS = [
  /(?:我叫|叫我|称呼我|喊我)([\u4e00-\u9fffA-Za-z0-9]{1,12})/g,
  /(?:我的|养的|我家的)(?:猫|狗|宠物|兔子|鸟|仓鼠)(?:叫|名字叫|取名|是)([\u4e00-\u9fffA-Za-z0-9]{1,12})/g,
  /(?:我在做|我在写|我在搞|正在做|负责)([\u4e00-\u9fffA-Za-z0-9]{2,16})/g,
  /(?:我住|住在|家在)([\u4e00-\u9fff]{2,10})/g,
  // 「这个叫记忆仓库」「名字是 X」：显式命名的东西，人和非人都收
  /(?:叫|叫做|名为|名字是|名字叫)([\u4e00-\u9fffA-Za-z0-9_.-]{2,20})/g,
]

/**
 * 归一：去空白和其它标点，**保留 . _ -**（技术名要靠它们区分：
 * dsh-consciousness-v6 / retrieve.js / app.db），英文转小写。
 */
function clean(name) {
  return String(name || '')
    .replace(/[^\u4e00-\u9fffA-Za-z0-9._-]/gu, '')
    .trim()
    .slice(0, 24)
}

/** 归一：只去空白与标点，英文转小写；不做同义词归并（那需要模型）。 */
export function normalizeName(name) {
  const s = clean(name)
  return /^[A-Za-z0-9]+$/.test(s) ? s.toLowerCase() : s
}

/** 从一句话里抽实体名：引号的、书名号的、自我介绍的、宠物 / 项目 / 地点的、技术名。 */
export function extractEntityNames(text) {
  const src = String(text || '')
  const out = new Set()
  for (const m of src.matchAll(/[「“"'‘]([^」”"'’]{1,16})[」”"'’]/g)) {
    const v = normalizeName(m[1])
    if (v.length >= 2 && !STOP.has(v)) out.add(v)
  }
  for (const m of src.matchAll(/《([^》]{1,20})》/g)) {
    const v = normalizeName(m[1])
    if (v.length >= 2 && !STOP.has(v)) out.add(v)
  }
  for (const re of PATTERNS) {
    for (const m of src.matchAll(re)) {
      const v = normalizeName(m[1])
      if (v.length >= 2 && !STOP.has(v) && !/^\d+$/.test(v)) out.add(v)
    }
  }
  // 技术名：必须带大写 / 点 / 下划线 / 连字符——DSH、app.db、retrieve.js、dsh-consciousness-v6。
  // 纯小写普通词（text、message、data）不收，否则实体表会被代码词淹没。
  for (const m of src.matchAll(TECH_NAME)) {
    const raw = String(m[1] || '')
    if (!/[A-Z._-]/.test(raw)) continue
    const v = normalizeName(raw)
    if (v.length < 3 || STOP.has(v) || STOP_EN.has(v.toLowerCase())) continue
    out.add(v)
  }
  return [...out].slice(0, 8)
}

function touch(db, row) {
  try {
    db.prepare('UPDATE entities SET hits=hits+1, updated_at=? WHERE id=?').run(now(), row.id)
  } catch { /* 记账失败不影响 */ }
  return { id: row.id, name: row.name, kind: row.kind, created: false }
}

/** 拿到实体 id；没有就建一个。别名（aliases JSON）也能命中。 */
export function resolveEntity(db, aid, name, kind = 'thing') {
  const key = normalizeName(name)
  if (!key) return null
  try {
    const byName = db.prepare('SELECT * FROM entities WHERE agent_id=? AND name=?').get(aid, key)
    if (byName) return touch(db, byName)
    // 名字互相包含（小周 / 周周 / 周）+ 长度差不大 → 记成别名，下次直接命中。
    // 这是 aliases 唯一的写入点：之前只读不写，别名机制一直空转。
    try {
      const all = db.prepare('SELECT * FROM entities WHERE agent_id=? ORDER BY hits DESC LIMIT 300').all(aid)
      for (const r of all) {
        if (!r.name || r.name.length < 2 || key.length < 2) continue
        const related = r.name.includes(key) || key.includes(r.name)
        if (!related || Math.abs(r.name.length - key.length) > 4) continue
        let list = []
        try { list = JSON.parse(r.aliases || '[]') } catch { list = [] }
        if (!Array.isArray(list)) list = []
        if (!list.map(normalizeName).includes(key)) {
          list.push(key)
          try { db.prepare('UPDATE entities SET aliases=? WHERE id=?').run(JSON.stringify(list.slice(0, 8)), r.id) } catch { /* 别名写失败就当没写 */ }
        }
        return touch(db, r)
      }
    } catch { /* 别名表读失败就当没有 */ }
    const rows = db.prepare('SELECT * FROM entities WHERE agent_id=? AND aliases IS NOT NULL').all(aid)
    for (const r of rows) {
      let list = []
      try { list = JSON.parse(r.aliases || '[]') } catch { list = [] }
      if (Array.isArray(list) && list.map(normalizeName).includes(key)) return touch(db, r)
    }
    const id = nid('ent_')
    const at = now()
    db.prepare('INSERT INTO entities(id,agent_id,name,kind,aliases,hits,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)')
      .run(id, aid, key, kind, null, at, at)
    return { id, name: key, kind, created: true }
  } catch { return null }
}

/** 一句话里的第一个实体（抽取时用来给事实打 entity_id）。
 *  先按句式抽新名；抽不到就看已知实体里哪个名字出现在句中——「团子今天不太吃饭」也得认出来。 */
export function entityForText(db, aid, text) {
  const names = extractEntityNames(text)
  if (names.length) return resolveEntity(db, aid, names[0])
  const src = String(text || '')
  try {
    const rows = db.prepare('SELECT * FROM entities WHERE agent_id=? ORDER BY hits DESC LIMIT 200').all(aid)
    for (const r of rows) {
      if (r.name && src.includes(r.name)) return touch(db, r)
    }
  } catch { /* 老库没有实体表时按没有实体处理 */ }
  return null
}

export function listEntities(db, aid, limit = 50) {
  return db.prepare('SELECT id,name,kind,hits,created_at,updated_at FROM entities WHERE agent_id=? ORDER BY hits DESC, updated_at DESC LIMIT ?')
    .all(aid, Math.max(1, Math.min(200, Number(limit) || 50)))
}

/** 同一个实体下的所有事实（回答「关于团子我知道什么」）。 */
export function factsOfEntity(db, aid, entityId, limit = 20) {
  return db.prepare(`SELECT id,text,type,importance,heat FROM memory_items
    WHERE agent_id=? AND entity_id=? AND status='active' AND invalid_at IS NULL
    ORDER BY heat DESC LIMIT ?`).all(aid, entityId, Math.max(1, Math.min(100, Number(limit) || 20)))
}

/**
 * 存量回填：按（放宽后的）抽取规则把已有记忆重新认一遍实体，挂上 entity_id。
 * 只补 entity_id 为空的行——已经归属好的不动，避免覆盖更准的归属。
 * 一次性 job；返回这次挂上了多少条。
 */
export function backfillEntities(db, aid) {
  let rows = []
  try {
    rows = db.prepare("SELECT id,text FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND entity_id IS NULL").all(aid)
  } catch { return 0 }
  let n = 0
  for (const r of rows) {
    try {
      const ent = entityForText(db, aid, r.text || '')
      if (!ent) continue
      db.prepare('UPDATE memory_items SET entity_id=? WHERE id=?').run(ent.id, r.id)
      n++
    } catch { /* 单条失败跳过，不影响其余 */ }
  }
  return n
}
