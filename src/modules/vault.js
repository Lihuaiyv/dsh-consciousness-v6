/**
 * 记忆仓库（前端首页用）
 *
 * 回答三个问题：
 *   ① 五个分区各占多少（条数 / 字节 / 占比）
 *   ② 文件存在哪、导出来长什么样（按年 / 月分文件夹，跟人写日记一个结构）
 *   ③ 能不能一键打开那个文件夹
 *
 * 导出只写文件，不改库；写出来的东西是给人看的，不是给程序读的。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { TOTAL_BUDGET } from './pack.js'

export const DEFAULT_ROOT = path.join(os.homedir(), '.dsh', 'consciousness', 'docs')

/** 可读版格式版本：客户端用它判断后端是不是旧进程（旧的不许重新导出，免得覆盖新格式）。 */
export const VAULT_VER = 2

/** 保存位置存在 flags 里（键 docs.root），没设过就用默认。 */
export function getDocsRoot(db) {
  try {
    const r = db.prepare("SELECT value FROM flags WHERE key='docs.root'").get()
    if (r && r.value) return String(r.value)
  } catch { /* 老库没有 flags */ }
  return DEFAULT_ROOT
}

/** 改保存位置：建目录、记进 flags；返回规范化后的绝对路径。 */
export function setDocsRoot(db, dir) {
  const raw = String(dir || '').trim()
  if (!raw) throw new Error('路径不能为空')
  const p = path.resolve(raw)
  if (p.length < 4) throw new Error('路径不合法')
  fs.mkdirSync(p, { recursive: true })
  db.prepare("INSERT INTO flags(key,value) VALUES('docs.root',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(p)
  return p
}

function bytesOf(db, sql, args = []) {
  try {
    const r = db.prepare(sql).get(...args)
    return { rows: Number(r && r.n ? r.n : 0), bytes: Number(r && r.b ? r.b : 0) }
  } catch { return { rows: 0, bytes: 0 } }
}

/** 各模块「预计能存多少」：占比 = 现在条数 / 这个上限，不是占总字节的比例。 */
export const CAPACITY = {
  T0: 120,        // 桌面硬顶（文档 §2 T0）
  T1: 5000,       // 事实：千级/年，按五年算
  T2: 1000,       // 纪要：百级/年
  T3: 3650,       // 日记：一天一篇，按十年算
  T4: 100000,     // 原文：十万级
  FA: 5000,       // 事实存根：与事实一一对应
}

function pct(part, cap) {
  return cap > 0 ? Math.round((part / cap) * 1000) / 10 : 0
}

/** 五个分区 + 事实档案的体量。字节按文本长度估，够用不精确。 */
export function warehouse(db, aid, opt = {}) {
  const t0p = bytesOf(db, 'SELECT COUNT(*) n, COALESCE(SUM(LENGTH(value)),0) b FROM persona WHERE agent_id=?', [aid])
  // preferences 的列叫 tag 不叫 text：写错会被 bytesOf 静默吞掉，T0 永远显示 0
  const t0x = bytesOf(db, 'SELECT COUNT(*) n, COALESCE(SUM(LENGTH(tag)),0) b FROM preferences WHERE agent_id=?', [aid])
  const t0t = bytesOf(db, 'SELECT COUNT(*) n, COALESCE(SUM(LENGTH(text)),0) b FROM taboos WHERE agent_id=?', [aid])
  const t1 = bytesOf(db, "SELECT COUNT(*) n, COALESCE(SUM(LENGTH(text)),0) b FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL", [aid])
  const t2 = bytesOf(db, 'SELECT COUNT(*) n, COALESCE(SUM(LENGTH(COALESCE(title,\'\'))+LENGTH(COALESCE(summary,\'\'))),0) b FROM episodes WHERE agent_id=?', [aid])
  const t3 = bytesOf(db, 'SELECT COUNT(*) n, COALESCE(SUM(LENGTH(text)),0) b FROM diaries WHERE agent_id=?', [aid])
  const t4 = bytesOf(db, 'SELECT COUNT(*) n, COALESCE(SUM(LENGTH(text)),0) b FROM raw_turns WHERE agent_id=?', [aid])
  const fa = bytesOf(db, 'SELECT COUNT(*) n, COALESCE(SUM(LENGTH(text)),0) b FROM fact_archive WHERE agent_id=?', [aid])

  const parts = [
    { key: 'T0', label: '短期 · 桌面', rows: t0p.rows + t0x.rows + t0t.rows, bytes: t0p.bytes + t0x.bytes + t0t.bytes, hint: '人格 / 偏好 / 禁忌，每轮都带' },
    { key: 'T1', label: '长期 · 抽屉', rows: t1.rows, bytes: t1.bytes, hint: '原子事实，按句召回' },
    { key: 'T2', label: '书签', rows: t2.rows, bytes: t2.bytes, hint: '一次会话 / 一天的压缩' },
    { key: 'T3', label: '日记', rows: t3.rows, bytes: t3.bytes, hint: '一天一篇，第一人称' },
    { key: 'T4', label: '对话档案', rows: t4.rows, bytes: t4.bytes, hint: '完整对话，只追加' },
    { key: 'FA', label: '事实档案', rows: fa.rows, bytes: fa.bytes, hint: '事实出生时的原样，只追加；S2/S3 时随 T4 一起查' },
  ]
  const total = parts.reduce((s, p) => s + p.bytes, 0)
  const caps = { ...CAPACITY, ...(opt.caps || {}) }
  for (const p of parts) {
    p.cap = Number(caps[p.key] || 0)
    p.pct = pct(p.rows, p.cap)     // 占「自己这个模块」容量的百分比
    p.kb = Math.round((p.bytes / 1024) * 10) / 10
  }

  let dbBytes = 0
  try {
    let p = opt.dbPath
    if (!p) {
      const row = db.prepare('PRAGMA database_list').all().find((x) => x.name === 'main')
      p = row && row.file
    }
    if (p) dbBytes = fs.statSync(p).size
  } catch { dbBytes = 0 }

  const root = String(opt.root || getDocsRoot(db))
  let exported = null
  try {
    if (fs.existsSync(root)) {
      const st = fs.statSync(root)
      exported = { root, exists: true, updated_at: st.mtime.toISOString() }
    }
  } catch { exported = null }

  // 每轮注入的真实用量（sys.inject_tokens），这是这套系统里唯一有真配额的数
  let inject = null
  try {
    const budget = Number(opt.budget) > 0 ? Number(opt.budget) : TOTAL_BUDGET
    const r = db.prepare("SELECT COUNT(*) n, ROUND(AVG(value)) avg, MAX(value) mx FROM metric_samples WHERE agent_id=? AND key='sys.inject_tokens'").get(aid)
    if (r && Number(r.n) > 0) inject = { n: Number(r.n), avg: Number(r.avg), max: Number(r.mx), budget }
  } catch { inject = null }

  return { v: VAULT_VER, at: new Date().toISOString(), total_bytes: total, total_kb: Math.round((total / 1024) * 10) / 10, db_bytes: dbBytes, parts, inject, docs: exported || { root, exists: false } }
}

/** 时间序列要读的表：[表名, 字节表达式]，口径和 warehouse() 一致 */
const HIST_TABLES = [
  ['preferences', 'LENGTH(tag)'],
  ['taboos', 'LENGTH(text)'],
  ['memory_items', 'LENGTH(text)'],
  ['episodes', "LENGTH(COALESCE(title,''))+LENGTH(COALESCE(summary,''))"],
  ['diaries', 'LENGTH(text)'],
  ['raw_turns', 'LENGTH(text)'],
  ['fact_archive', 'LENGTH(text)'],
]

/**
 * 记忆量按天累计（前端画曲线用）。
 * 每天给：期初 open / 收盘 close（字节）、当天新增 add_b、失效 del_b、条数。
 * 只数文本本身，和仓库卡片上的总量同口径。
 */
export function history(db, aid, opt = {}) {
  const days = Math.max(7, Math.min(400, Number(opt.days) || 365))
  const today = new Date()
  const startDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - (days - 1) * 86400000)
    .toISOString().slice(0, 10)
  const startIso = startDay + 'T00:00:00.000Z'
  const one = (sql, ...args) => {
    try { return db.prepare(sql).get(aid, ...args) } catch { return null }
  }
  const many = (sql) => {
    try { return db.prepare(sql).all(aid, startIso) } catch { return [] }
  }

  let baseBytes = 0
  let baseRows = 0
  // 人格没有 created_at，整块算期初
  const p0 = one('SELECT COALESCE(SUM(LENGTH(value)),0) b, COUNT(*) n FROM persona WHERE agent_id=?')
  if (p0) { baseBytes += Number(p0.b) || 0; baseRows += Number(p0.n) || 0 }

  for (const [t, expr] of HIST_TABLES) {
    let sql = 'SELECT COALESCE(SUM(' + expr + '),0) b, COUNT(*) n FROM ' + t + ' WHERE agent_id=? AND created_at<?'
    const args = [startIso]
    // 抽屉里的条目会失效：期初只算窗口开始时还活着的
    if (t === 'memory_items') { sql += ' AND (invalid_at IS NULL OR invalid_at>=?)'; args.push(startIso) }
    const o = one(sql, ...args)
    if (o) { baseBytes += Number(o.b) || 0; baseRows += Number(o.n) || 0 }
  }

  const byDay = new Map()
  const bump = (day, key, b, n) => {
    if (!day) return
    const o = byDay.get(day) || { add_b: 0, add_n: 0, del_b: 0, del_n: 0 }
    o[key + '_b'] += b
    o[key + '_n'] += n
    byDay.set(day, o)
  }
  for (const [t, expr] of HIST_TABLES) {
    const rows = many('SELECT substr(created_at,1,10) d, COALESCE(SUM(' + expr + '),0) b, COUNT(*) n FROM ' + t + ' WHERE agent_id=? AND created_at>=? GROUP BY d')
    for (const r of rows) bump(r.d, 'add', Number(r.b) || 0, Number(r.n) || 0)
  }
  const gone = many('SELECT substr(invalid_at,1,10) d, COALESCE(SUM(LENGTH(text)),0) b, COUNT(*) n FROM memory_items WHERE agent_id=? AND invalid_at IS NOT NULL AND invalid_at>=? GROUP BY d')
  for (const r of gone) bump(r.d, 'del', Number(r.b) || 0, Number(r.n) || 0)

  let bytes = baseBytes
  let rows = baseRows
  const series = []
  const t0 = Date.parse(startIso)
  for (let i = 0; i < days; i++) {
    const day = new Date(t0 + i * 86400000).toISOString().slice(0, 10)
    const e = byDay.get(day) || { add_b: 0, add_n: 0, del_b: 0, del_n: 0 }
    const open = bytes
    bytes += e.add_b - e.del_b
    rows += e.add_n - e.del_n
    series.push({ day, open, close: bytes, rows, add_b: e.add_b, del_b: e.del_b, add_n: e.add_n })
  }
  // 曲线形状来自 add/del；绝对高度用「现在的总量」锚一下，好和卡片上的数字对得上
  let nowBytes = 0
  const pn = one('SELECT COALESCE(SUM(LENGTH(value)),0) b FROM persona WHERE agent_id=?')
  if (pn) nowBytes += Number(pn.b) || 0
  for (const [t, expr] of HIST_TABLES) {
    const sql = t === 'memory_items'
      ? 'SELECT COALESCE(SUM(' + expr + '),0) b FROM ' + t + " WHERE agent_id=? AND status='active' AND invalid_at IS NULL"
      : 'SELECT COALESCE(SUM(' + expr + '),0) b FROM ' + t + ' WHERE agent_id=?'
    const o = one(sql)
    if (o) nowBytes += Number(o.b) || 0
  }
  // 校准会把窗口开始前的日子压低，别让曲线掉到 0 以下
  const shift = nowBytes - bytes
  if (shift) {
    for (const p of series) {
      p.open = Math.max(0, p.open + shift)
      p.close = Math.max(0, p.close + shift)
    }
  }
  bytes = nowBytes

  return { days, start_day: startDay, total_kb: Math.round((bytes / 1024) * 10) / 10, series }
}

function pad(n) { return String(n).padStart(2, '0') }
function ym(day) { return { y: String(day).slice(0, 4), m: String(day).slice(5, 7) } }

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}

/**
 * 把日记 / 纪要 / 事实 / 原文导成「人能读」的文件夹：
 *   docs/日记/2026/10/2026-10-28.md
 *   docs/纪要/2026/10/2026-10-28.md
 *   docs/事实/事实.md
 *   docs/原文/2026/10/2026-10-28.md
 */
/** 日记开头那一句「今天怎么样」：用人话说，不写数值和档位。 */
const MOOD_ZH = {
  joy: '开心', peaceful: '平和', curious: '好奇', calm: '平静',
  confused: '懵', lost: '低落', irritated: '烦躁', frustrated: '挫败',
}
const FACE = {
  joy: ['(｡•ᴗ•｡)', '(*´▽`*)', '(๑˃̵ᴗ˂̵)'],
  peaceful: ['( ˘ω˘ )', '(￣o￣) zzZ', '( ´ ▽ ` )'],
  curious: ['(・・?', '(・o・)', '(¬‿¬)'],
  calm: ['(￣▽￣)', '( ・_・)', '(￣ω￣)'],
  confused: ['(・_・?)', '(´・ω・`)', '(°ロ°)'],
  lost: ['(´-`)', '(´；ω；`)', '(＿＿)'],
  irritated: ['(￣へ￣)', '(＃￣ω￣)', '(￢_￢)'],
  frustrated: ['(>_<)', '(；´д｀)', '(╯°□°)╯'],
}

/** 同一天永远同一个结果，换天才换，别每次导出都变。 */
function seeded(seed) {
  let h = 7
  for (const ch of String(seed || '')) h = (h * 31 + ch.charCodeAt(0)) | 0
  return Math.abs(h)
}
function pick(list, seed) { return list[seeded(seed) % list.length] }

function pickFace(label, seed) {
  return pick(FACE[label] || ['(・_・?)'], 'face:' + seed)
}

const DRIVE_LINE = {
  D0: ['没什么特别想要的', '不太想动，安安静静就好', '只想把日子过慢一点'],
  D1: ['有点想找点事做', '想给自己找点小事', '心里有点痒，想做点什么'],
  D2: ['挺想找人说话', '想和人聊两句', '有点想被谁问一句'],
  D3: ['特别想做点什么，坐不太住', '有股劲没处使，很想动手', '很想马上做点什么'],
}

/** 同一个状态也换几种说法，别每天都一个句式。 */
const TPL = [
  (m, d) => '今天' + m + (d ? '，' + d : '') + '。',
  (m, d) => '今天' + m + '。' + (d ? d + '。' : ''),
  (m, d) => '一整天都' + m + '。' + (d ? d + '。' : ''),
  (m, d) => '说不上为什么，今天' + m + '。' + (d ? d + '。' : ''),
]

function diaryLine(ctx, moodRaw, day) {
  let label = ''
  let intensity = 0
  if (ctx && ctx.affect && ctx.affect.label) {
    label = String(ctx.affect.label)
    intensity = Number(ctx.affect.intensity) || 0
  } else if (moodRaw) {
    const parts = String(moodRaw).trim().split(/\s+/)
    label = parts[0] || ''
    intensity = Number(parts[1]) || 0
  }
  const q = intensity >= 0.65 ? '特别' : intensity >= 0.35 ? '挺' : '有点'
  const suffix = q === '挺' ? '的' : ''
  const band = ctx && ctx.drive && ctx.drive.band ? String(ctx.drive.band) : ''
  const drive = DRIVE_LINE[band] ? pick(DRIVE_LINE[band], 'drive:' + day) : ''
  const face = pickFace(label, day)
  if (!MOOD_ZH[label]) return '今天说不上什么心情。' + (drive ? drive + '。' : '') + face
  return pick(TPL, 'tpl:' + day)(q + MOOD_ZH[label] + suffix, drive) + face
}

export function exportDocs(db, aid, opt = {}) {
  const root = String(opt.root || getDocsRoot(db))
  const out = { root, files: 0, days: 0 }

  // 日记：按月一个文件（以前是一天一个）
  const diaries = db.prepare('SELECT day,text,mood,source,version,context FROM diaries WHERE agent_id=? ORDER BY day').all(aid)
  const byMonth = new Map()
  for (const d of diaries) {
    const key = String(d.day).slice(0, 7)
    const arr = byMonth.get(key) || []
    arr.push(d)
    byMonth.set(key, arr)
  }
  for (const [month, list] of byMonth) {
    const y = month.slice(0, 4)
    const body = list.map((d) => {
      let ctx = null
      try { ctx = d.context ? JSON.parse(d.context) : null } catch { ctx = null }
      // 不写「心情 xx 0.36 · 驱力 D0」这种机器话，换成一句像人会写的话
      const line = diaryLine(ctx, d.mood, d.day)
      const text = String(d.text || '')
        .trim()
        .replace(/^\d{4}[-年/.]\s*\d{1,2}[-月/.]\s*\d{1,2}[^\n]*\n+/, '') // 去掉正文里重复的日期行
        .trim()
      return '## ' + d.day + '\n\n' + line + '\n\n' + text
    }).join('\n\n')
    writeFile(path.join(root, '日记', y, month + '.md'), '# ' + month + '\n\n' + body + '\n')
    out.files++
  }
  out.days = diaries.length

  // 对话档案：一天一个文件
  const raws = db.prepare('SELECT day,role,text,created_at FROM raw_turns WHERE agent_id=? ORDER BY day, created_at').all(aid)
  const rawByDay = new Map()
  for (const r of raws) {
    const arr = rawByDay.get(r.day) || []
    arr.push(r)
    rawByDay.set(r.day, arr)
  }
  for (const [day, list] of rawByDay) {
    const { y, m } = ym(day)
    const body = list.map((r) => '**' + (r.role === 'user' ? '你' : '我') + '**：' + String(r.text || '').replace(/\s+/g, ' ')).join('\n\n')
    writeFile(path.join(root, '对话档案', y, m, day + '.md'), '# ' + day + ' 对话\n\n' + body + '\n')
    out.files++
  }

  // 事实档案：一份文件，事实出生时的原样（只追加）
  const facts = db.prepare('SELECT text,type,created_at FROM fact_archive WHERE agent_id=? ORDER BY created_at DESC').all(aid)
  const factBody = facts.map((f) => '- [' + String(f.created_at || '').slice(0, 10) + '] ' + String(f.text || '').replace(/\s+/g, ' ')).join('\n')
  writeFile(path.join(root, '事实档案', '事实档案.md'), '# 事实档案（' + facts.length + ' 条）\n\n' + factBody + '\n')
  out.files++

  out.updated_at = new Date().toISOString()
  return out
}

/** 在文件管理器里打开目录或定位到某个文件（只允许导出根目录以内）。 */
export function openFolder(target, opt = {}) {
  const root = path.resolve(String(opt.root || DEFAULT_ROOT))
  const dir = path.resolve(String(target || root))
  const inside = dir === root || dir.startsWith(root + path.sep)
  if (!inside) return { ok: false, reason: '只能打开导出目录里面的路径' }
  if (!fs.existsSync(dir)) return { ok: false, reason: '文件还不存在，先导出一次' }
  const isFile = fs.statSync(dir).isFile()
  try {
    if (process.platform === 'win32') spawn('explorer.exe', isFile ? ['/select,', dir] : [dir], { detached: true, stdio: 'ignore' }).unref()
    else if (process.platform === 'darwin') spawn('open', isFile ? ['-R', dir] : [dir], { detached: true, stdio: 'ignore' }).unref()
    else spawn('xdg-open', [isFile ? path.dirname(dir) : dir], { detached: true, stdio: 'ignore' }).unref()
    return { ok: true, dir, file: isFile }
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) }
  }
}

export { pad }
