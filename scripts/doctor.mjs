#!/usr/bin/env node
/**
 * 意识体体检：把「改动到底上线了没」和「状态自不自洽」压成一张表。
 *
 *   node scripts/doctor.mjs                       # 默认 127.0.0.1:58087 + ~/.dsh
 *   node scripts/doctor.mjs --url http://127.0.0.1:58088
 *   node scripts/doctor.mjs --agent agt_xxx
 *   node scripts/doctor.mjs --offline             # 只查库，不碰 HTTP（不触发任何生成）
 *
 * 读库一律 readOnly；HTTP 只发 GET 信封，不改数据。
 * 退出码：有 fail → 1，只有 warn → 0。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const argv = process.argv.slice(2)
function flag(name, def) {
  const i = argv.indexOf('--' + name)
  if (i < 0) return def
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

const BASE = String(flag('url', process.env.DSHC_URL || 'http://127.0.0.1:58087')).replace(/\/$/, '')
const DB_PATH = String(flag('db', process.env.DSHC_DB || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'consciousness', 'app.db')))
const OFFLINE = !!flag('offline', false)
const FIX = !!flag('fix', false)
const AGENT = flag('agent', null)

const rows = []
let fails = 0
let warns = 0
function add(level, name, detail) {
  rows.push({ level, name, detail: detail == null ? '' : String(detail) })
  if (level === 'fail') fails++
  if (level === 'warn') warns++
}
const ok = (n, d) => add('ok', n, d)
const warn = (n, d) => add('warn', n, d)
const fail = (n, d) => add('fail', n, d)

async function api(method, p) {
  const r = await fetch(BASE + '/dsh-consciousness/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, path: p, body: {}, token: 'user' }),
  })
  const d = await r.json().catch(() => ({}))
  if (d && d.error) throw new Error(d.error.message || d.error.code)
  return d
}

function openReadOnly() {
  if (!fs.existsSync(DB_PATH)) return null
  try { return new DatabaseSync(DB_PATH, { readOnly: true }) } catch { return null }
}

function dbCounts(db) {
  const t = {}
  for (const name of ['agents', 'memory_items', 'persona', 'persona_values', 'persona_worldview', 'persona_lifeview', 'persona_views', 'relations', 'conflicts', 'proactive', 'changes']) {
    try { t[name] = Number(db.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n) } catch { t[name] = null }
  }
  return t
}

const out = []
console.log('意识体体检  ' + new Date().toLocaleString('zh-CN', { hour12: false }))

// ---------- 1. 插件与接缝 ----------
let ping = null
if (!OFFLINE) {
  try {
    ping = await (await fetch(BASE + '/dsh-consciousness/ping')).json()
    if (ping.ok) ok('插件在跑', BASE + ' · ' + ping.plugin)
    else fail('插件在跑', JSON.stringify(ping).slice(0, 120))
    ok('schema', 'v' + ping.schema + (Number(ping.schema) >= 9 ? '' : '（低于 9）'))
    if (ping.recovered) warn('启动恢复', '回滚了 ' + ping.recovered + ' 条未完成 journal')
    const seams = (ping.host && ping.host.seams) || []
    const bad = seams.filter((s) => s.level !== 'ok')
    if (!bad.length) ok('宿主接缝', '4/4 ok · ' + (ping.host && ping.host.summary))
    else if (bad.every((s) => s.level === 'pending')) warn('宿主接缝', bad.map((s) => s.seam + '=pending').join(' '))
    else fail('宿主接缝', bad.map((s) => s.seam + '=' + s.level + (s.reason ? '(' + s.reason + ')' : '')).join(' '))
    if (ping.push_port) ok('push 端口', '开')
    else warn('push 端口', '关（主动开口不会推会话）')
  } catch (e) {
    fail('插件在跑', String(e.message || e) + ' → 检查 DSH 是否开着、--url 是否对')
  }
}

// ---------- 2. 实例快照（HTTP） ----------
let aid = AGENT
if (!OFFLINE && ping) {
  try {
    const list = await api('GET', '/v1/agents')
    const active = (list || []).find((a) => a.id === aid) || (list || []).find((a) => a.status === 'active') || (list || [])[0]
    if (!active) fail('找实例', '一个都没有')
    else {
      aid = active.id
      ok('实例', active.name + ' · ' + active.status + ' · ' + active.mode)
      if (active.status !== 'active') warn('实例在跑', '当前 ' + active.status + '，注入/主动开口都会停')
    }
  } catch (e) { fail('找实例', e.message) }
}

if (!OFFLINE && ping && aid) {
  try {
    const ov = await api('GET', `/v1/agents/${aid}/overview`)
    ok('记忆', (ov.memory_count || 0) + ' 条 · 未解冲突 ' + (ov.conflicts_open || 0))
    ok('驱力', (ov.drive && ov.drive.band) + ' · D=' + (ov.drive && ov.drive.D))
  } catch (e) { fail('概览', e.message) }

  try {
    const vals = await api('GET', `/v1/agents/${aid}/values/explain`)
    const sum = vals.items.reduce((s, x) => s + Number(x.weight), 0)
    const low = vals.items.filter((x) => Number(x.weight) < 0.019)
    if (vals.items.length === 10) ok('价值观十维', 'Σ' + sum.toFixed(3) + ' · 惯习 ' + (vals.habits || []).length)
    else warn('价值观十维', '只有 ' + vals.items.length + ' 维')
    if (Math.abs(sum - 1) > 0.02) fail('价值观归一', 'Σ=' + sum.toFixed(3))
    else ok('价值观归一', 'Σ=' + sum.toFixed(3))
    if (low.length) fail('价值观不归零', low.map((x) => x.label).join('、'))
    else ok('价值观不归零', '最低 ' + Math.min(...vals.items.map((x) => x.weight)).toFixed(3))
  } catch (e) {
    fail('价值观接口', e.message + '（老宿主？重启/等热加载）')
  }

  try {
    const wv = await api('GET', `/v1/agents/${aid}/worldview/explain`)
    const n = (wv.items || []).length
    if (n === 8) ok('世界观八维', (wv.derived && wv.derived.label) || ('good=' + (wv.derived && wv.derived.good)))
    else warn('世界观八维', '只有 ' + n + ' 维')
    const bad = (wv.items || []).filter((x) => Number(x.weight) < 0.05 || Number(x.weight) > 0.95)
    if (bad.length) fail('世界观范围', bad.map((x) => x.label).join('、'))
    else ok('世界观范围', '均在地板~天花板内')
  } catch (e) {
    fail('世界观接口', e.message + '（需热加载插件）')
  }

  try {
    const lv = await api('GET', `/v1/agents/${aid}/lifeview/explain`)
    const n = (lv.items || []).length
    if (n === 7) ok('人生观七维', 'presence=' + Number(lv.derived && lv.derived.presence).toFixed(2))
    else warn('人生观七维', '只有 ' + n + ' 维')
    const telos = lv.derived && lv.derived.stance && lv.derived.stance.telos
    if (telos) ok('人生观命题', String(telos).slice(0, 40))
    else warn('人生观命题', '还没有 telos（先 grow 一次）')
  } catch (e) {
    fail('人生观接口', e.message + '（需热加载插件）')
  }

  try {
    const pz = await api('GET', `/v1/agents/${aid}/affect/poisons`)
    if (pz && typeof pz.greed === 'number') {
      const inRange = [pz.greed, pz.anger, pz.delusion].every((v) => v >= 0 && v <= 1)
      ok('三毒', '贪 ' + pz.greed.toFixed(2) + ' / 嗔 ' + pz.anger.toFixed(2) + ' / 痴 ' + pz.delusion.toFixed(2) + (inRange ? '' : '（越界）'))
      if (!inRange) fail('三毒范围', JSON.stringify(pz))
    } else warn('三毒', '返回的不是三毒（可能是旧宿主）')
  } catch (e) { fail('三毒接口', e.message) }

  try {
    const sv = await api('GET', `/v1/agents/${aid}/persona/selfview`)
    const n = Array.from(String(sv.text || '')).length
    if (sv.status === 'fresh' && n >= 20) ok('人格自述', n + ' 字 · ' + (sv.source === 'model' ? '模型' : '规则'))
    else if (sv.status === 'generating') warn('人格自述', '正在生成（首次打开会等几秒）')
    else warn('人格自述', '状态 ' + sv.status + ' · ' + n + ' 字')
    const p = sv.params || {}
    if (p.relation && p.tone) ok('自述参数', '关系 ' + p.relation.mode + ' · 分寸 ' + Math.round(p.relation.disclosure * 100) + '% · 语气 ' + p.tone.label)
    else warn('自述参数', '缺 relation/tone（旧宿主？）')
  } catch (e) { fail('自述接口', e.message) }
}

// ---------- 3. 库（readOnly） ----------
const db = openReadOnly()
if (!db) {
  warn('本地库', '读不到 ' + DB_PATH + '（--db 指一下，或库还没建）')
} else {
  const c = dbCounts(db)
  ok('库', DB_PATH)
  if (c.persona_views == null) fail('persona_views 表', '不存在（这次改动没迁移到这套库？）')
  try {
    const v = db.prepare('SELECT version FROM schema_meta').get()
    if (Number(v && v.version) >= 9) ok('schema_meta', 'v' + v.version)
    else warn('schema_meta', 'v' + (v && v.version))
  } catch { warn('schema_meta', '读不到') }

  try {
    const sum = aid
      ? db.prepare('SELECT COALESCE(SUM(weight),0) s, COUNT(*) n FROM persona_values WHERE agent_id=?').get(aid).s
      : 0
    if (Number(sum) > 0) {
      if (Math.abs(Number(sum) - 1) > 0.05) fail('库内价值观总和', Number(sum).toFixed(3) + '（这个实例）')
      else ok('库内价值观总和', Number(sum).toFixed(3) + '（这个实例）')
    } else if (!aid) {
      warn('库内价值观总和', '没指定实例，跳过')
    }
  } catch { /* 老库 */ }

  try {
    const bad = db.prepare("SELECT COUNT(*) n FROM relations WHERE closeness<0 OR closeness>1 OR trust<0 OR trust>1 OR dependence<0 OR dependence>1").get().n
    if (Number(bad)) fail('关系三维范围', bad + ' 条越界')
    else ok('关系三维范围', c.relations + ' 条都在 0–1')
  } catch { /* ignore */ }

  try {
    const bad = db.prepare("SELECT COUNT(*) n FROM persona WHERE path LIKE 'big5.%' AND (value<0 OR value>1)").get().n
    if (Number(bad)) fail('五维范围', bad + ' 条越界')
  } catch { /* ignore */ }

  try {
    let cols = db.prepare("PRAGMA table_info(conflicts)").all().map((x) => x.name)
    if (!(cols.includes('opened_at') && cols.includes('penalized_at')) && FIX) {
      // 只做加法迁移：两列 + 回填，和 db.js 启动时做的事一致
      try {
        const rw = new DatabaseSync(DB_PATH)
        rw.exec('ALTER TABLE conflicts ADD COLUMN opened_at TEXT')
        rw.exec('ALTER TABLE conflicts ADD COLUMN penalized_at TEXT')
        rw.prepare('UPDATE conflicts SET opened_at=? WHERE opened_at IS NULL').run(new Date().toISOString())
        cols = db.prepare("PRAGMA table_info(conflicts)").all().map((x) => x.name)
        ok('冲突迁移', '已补 opened_at / penalized_at（--fix）')
      } catch (e) { fail('冲突迁移', '补列失败：' + String(e.message || e)) }
    }
    if (cols.includes('opened_at') && cols.includes('penalized_at')) {
      if (!FIX) ok('冲突迁移', 'opened_at / penalized_at 都在')
    } else fail('冲突迁移', '缺列：R05 还没迁移（加 --fix，或重启 DSH）')
    const old = db.prepare("SELECT COUNT(*) n FROM conflicts WHERE state='open' AND penalized_at IS NULL AND opened_at IS NOT NULL AND opened_at <= ?").get(new Date(Date.now() - 7 * 86400000).toISOString()).n
    if (Number(old)) warn('待罚冲突', old + ' 条满 7 天未解，下一轮会降权')
  } catch { /* ignore */ }

  try {
    const n = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE status='active' AND (weight<0 OR weight>1)").get().n
    if (Number(n)) fail('记忆权重范围', n + ' 条越界')
  } catch { /* ignore */ }

  ok('表量', Object.entries(c).filter(([, v]) => v != null).map(([k, v]) => k + ' ' + v).join(' · '))
}

// ---------- 4. 输出 ----------
const icon = { ok: '✓', warn: '!', fail: '×' }
const width = Math.max(...rows.map((r) => Array.from(r.name).length)) + 2
for (const r of rows) {
  console.log('  ' + icon[r.level] + ' ' + r.name.padEnd(width) + (r.detail || ''))
}
console.log('\n结论：' + rows.filter((r) => r.level === 'ok').length + ' ok / ' + warns + ' warn / ' + fails + ' fail')
// 不强制退出：undici 的 keep-alive 连接在 process.exit 时会触发 uv assert（Windows）
process.exitCode = fails ? 1 : 0
