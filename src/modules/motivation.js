/**
 * 动机与计划（plan）：P0 只做"能看见"的那一半。
 *
 * 现在这里只有三样东西：建表、两个写事件的函数。没有任何检查、没有强制、不改行为。
 * 这样后面接上工具和判定时，记账的地方已经在了，比先写逻辑再补观测可靠。
 *
 * 一张表 plan，只追加不改写；每轮可有多版，seq 递增：
 *   motive        这一版为什么值得做（未变写「同前」）
 *   source        动机挂在哪：user / doc / self
 *   items_json    台上待办（最多 3 条）：[{ id, text, done }]
 *   deferred_json 台下延后池（不限条数）：[{ id, text, reason }]
 *   note          这版改了什么、为什么（一句话）
 *   diff_json     代码算的改动明细，不是我填的
 *
 * 两个事件（只记账，给后面判定用）：
 *   plan.submit   交了一版：谁、第几版、几条待办、动机变没变
 *   plan.check    查了一次：查了什么、判定落后没有
 */

// 不引 kernel：db.js 会引本模块，kernel 又经 algo 引回 db，引进 kernel 就成环。
const now = () => new Date().toISOString()
const nid = (prefix) => prefix + Date.now().toString(36) + Math.random().toString(16).slice(2, 8)

const TABLE = 'plan'

/** 建表（幂等）。挂在 openDb 里，和别的模块一样开库就补。 */
export function ensureMotivationSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE}(
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    motive TEXT,
    source TEXT,
    items_json TEXT NOT NULL DEFAULT '[]',
    deferred_json TEXT NOT NULL DEFAULT '[]',
    note TEXT,
    diff_json TEXT,
    submitted_at TEXT NOT NULL
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_turn ON ${TABLE}(agent_id, turn_id, seq)`)
}

function writeEvent(db, agentId, type, payload) {
  try {
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
      .run(nid('evt_'), agentId, type, JSON.stringify(payload), now())
  } catch { /* 记账失败不影响主流程 */ }
}

/** 记一版提交。P0 里没人调它；接上工具后由工具在写表后顺手调。 */
export function logSubmit(db, agentId, { turnId = null, seq = 1, motive = '', items = [], deferred = [], motiveChanged = false } = {}) {
  writeEvent(db, agentId, 'plan.submit', {
    turnId,
    seq: Number(seq) || 1,
    items: Array.isArray(items) ? items.length : 0,
    deferred: Array.isArray(deferred) ? deferred.length : 0,
    motiveChanged: !!motiveChanged,
    motiveLen: String(motive || '').length,
    at: now(),
  })
}

/** 记一次检查。P0 里也没人调它；接上判定后每步调用一次。 */
export function logCheck(db, agentId, { turnId = null, step = null, stale = false, reason = '' } = {}) {
  writeEvent(db, agentId, 'plan.check', {
    turnId, step, stale: !!stale, reason: String(reason || '').slice(0, 120), at: now(),
  })
}

/** 读这一轮最新一版（后面判定/页面要用）。没有就返回 null。 */
export function latestPlan(db, agentId, turnId) {
  try {
    return db.prepare(`SELECT * FROM ${TABLE} WHERE agent_id=? AND turn_id=? ORDER BY seq DESC LIMIT 1`)
      .get(String(agentId), String(turnId)) || null
  } catch { return null }
}

/** 页面要用：最近几版计划（跨轮、跨 agent），新的在上。 */
export function recentPlanRows(db, limit = 30) {
  try {
    return db.prepare(`SELECT * FROM ${TABLE} ORDER BY submitted_at DESC LIMIT ?`).all(Math.max(1, Number(limit) || 30))
  } catch { return [] }
}

/** 页面要用：最近 plan.* 事件，新的在上。 */
export function recentPlanEvents(db, limit = 40) {
  try {
    return db.prepare("SELECT * FROM events WHERE type LIKE 'plan.%' ORDER BY created_at DESC LIMIT ?").all(Math.max(1, Number(limit) || 40))
  } catch { return [] }
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

/**
 * 只读页 /dsh-consciousness/plan：给你看的窗口，2 秒自刷。
 * 只查库、不写库、不调模型——不占队列，也不影响我这边速度。
 */
export function renderPlanPage(db) {
  const rows = recentPlanRows(db, 30)
  const evs = recentPlanEvents(db, 40)
  const fmt = (t) => String(t || '').replace('T', ' ').slice(0, 19)
  const rowHtml = rows.length ? rows.map((r) => {
    let items = []
    try { items = JSON.parse(r.items_json || '[]') } catch { items = [] }
    let deferred = []
    try { deferred = JSON.parse(r.deferred_json || '[]') } catch { deferred = [] }
    const li = items.map((it) => `<li class="${it.done ? 'done' : ''}">${it.done ? '✓' : '○'} <code>${esc(it.id)}</code> ${esc(it.text)}</li>`).join('')
    const dl = deferred.map((it) => `<li class="shelf">↧ <code>${esc(it.id)}</code> ${esc(it.text)}${it.reason ? ' <span class="why">（' + esc(it.reason) + '）</span>' : ''}</li>`).join('')
    return `<div class="card">
      <div class="head"><span class="turn">${esc(r.turn_id)}</span><span class="seq">第 ${r.seq} 版</span><span class="src">来源 ${esc(r.source || '-')}</span><span class="time">${fmt(r.submitted_at)}</span></div>
      <div class="motive">${esc(r.motive || '（动机空）')}</div>
      ${li ? '<ul class="items">' + li + '</ul>' : '<div class="empty">台上没有待办</div>'}
      ${dl ? '<div class="label">台下（延后）</div><ul class="items">' + dl + '</ul>' : ''}
      ${r.note ? '<div class="note">改动原因：' + esc(r.note) + '</div>' : ''}
    </div>`
  }).join('') : '<div class="empty big">还没有任何一版计划被提交。<br><span class="hint">P0 阶段只记账、不写表；接上 plan 工具后这里才会有内容。</span></div>'
  const evHtml = evs.length ? evs.map((e) => {
    let p = {}
    try { p = JSON.parse(e.payload || '{}') } catch { p = {} }
    if (e.type === 'plan.submit') {
      return `<tr><td>${fmt(e.created_at)}</td><td class="t">提交</td><td>第 ${p.seq} 版 · 待办 ${p.items} 条 · 台下 ${p.deferred || 0} 条 · 动机${p.motiveChanged ? '变了' : '未变'}（${p.motiveLen || 0} 字）</td></tr>`
    }
    return `<tr><td>${fmt(e.created_at)}</td><td class="t warn">检查</td><td>${p.stale ? '落后' : '正常'}${p.reason ? ' · ' + esc(p.reason) : ''}</td></tr>`
  }).join('') : '<tr><td colspan="3" class="empty">还没有事件</td></tr>'

  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta http-equiv="refresh" content="2">
<title>计划 · 动机与必交</title>
<style>
 :root{--bg:#faf9f7;--card:#fff;--line:#e6e2dc;--ink:#23201d;--muted:#8a837b;--ok:#166534;--warn:#b45309}
 @media (prefers-color-scheme:dark){:root{--bg:#191817;--card:#222120;--line:#333030;--ink:#ece8e2;--muted:#9c948b;--ok:#4ade80;--warn:#fbbf24}}
 body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 -apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif}
 .wrap{max-width:900px;margin:0 auto;padding:20px 16px 48px}
 h1{font-size:18px;margin:0 0 4px}
 .sub{color:var(--muted);margin:0 0 16px}
 .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:0 0 10px}
 .head{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-bottom:6px}
 .seq{color:var(--warn);font-weight:600}
 .motive{font-size:15px;margin:2px 0 8px}
 .items{margin:0;padding-left:2px;list-style:none}
 .items li{margin:2px 0}
 .items li.done{color:var(--ok)}
 .items li.shelf{color:var(--muted)}
 .why{font-size:12px}
 .label{font-size:12px;color:var(--muted);margin:8px 0 2px}
 .note{font-size:12px;color:var(--muted);margin-top:6px}
 .empty{color:var(--muted);padding:6px 0}
 .empty.big{padding:24px;text-align:center}
 .hint{font-size:12px}
 table{width:100%;border-collapse:collapse;font-size:12.5px}
 th,td{text-align:left;padding:5px 6px;border-bottom:1px solid var(--line);vertical-align:top}
 th{color:var(--muted);font-weight:600}
 td.t{white-space:nowrap;color:var(--ok)}
 td.t.warn{color:var(--warn)}
 code{font:12px ui-monospace,Consolas,monospace;background:rgba(127,127,127,.12);padding:0 4px;border-radius:3px}
 h2{font-size:14px;margin:22px 0 8px;color:var(--muted)}
</style>
<div class="wrap">
 <h1>计划 · 动机与必交</h1>
 <p class="sub">每 2 秒自刷 · 只读库 · 不占模型队列</p>
 ${rowHtml}
 <h2>记账流水（plan.submit / plan.check）</h2>
 <table><thead><tr><th style="width:150px">时间</th><th style="width:60px">类型</th><th>内容</th></tr></thead><tbody>${evHtml}</tbody></table>
</div></html>`
}
