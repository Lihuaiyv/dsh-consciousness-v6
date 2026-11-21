/**
 * DSH 私有文件的唯一读口 —— 整个插件里唯一 readFileSync DSH 家目录的地方。
 *
 * 和 host/dsh.js 的分工：
 *   dsh.js  管**接口**（systemPrompt / pre-step / session/event / webServer / tools / commands / services）
 *   fs.js   管**文件**（workspace.json / session_projcache / qq-sessions.json），外加 DSH_HOME 解析
 *
 * 为什么要有它：这些文件不是 DSH 的公开契约。DSH 改一次存储格式，读它们的地方就悄悄失效——
 * 会话标题变空、归档的认不出来、QQ 的映射找不到，全都只是「功能差点」，没有一声报错。
 * 收成一个口之后，每一处都能给出 level + reason，而且「昨天还读得到、今天读不到了」这件事会被记下来。
 *
 * 三条约束：
 *   1. read 永不抛：调用方拿不到就给 fallback（以前各写各的 try/catch，原因一律吞掉）
 *   2. 冷启动就没有这个文件 = absent，不算断；曾经读到过、后来读不到 = break，这才是真断
 *   3. break 只报一次，报完进冷却；读回来一次就重置（免得一个抖动的盘每轮刷屏）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 读点清单。加新读点只往这里加，别处不许再直接 readFile DSH 家目录。 */
export const FILE_POINTS = Object.freeze(['workspace', 'session.title', 'qq.sessions'])

/** 断链回报冷却：同一个读点 6 小时内只说一次。 */
export const BREAK_COOLDOWN_MS = 6 * 60 * 60 * 1000

/** DSH 家目录：环境变量优先，其次用户目录下的 .dsh。别再在各处抄一遍。 */
export function dshHome(env = process.env) {
  const v = env && env.DSH_HOME
  return v && String(v).trim() ? String(v).trim() : path.join(os.homedir(), '.dsh')
}

/** 桥接插件的映射表可能在几处（它自己的历史位置 + 当前 profile），按优先级找。 */
function qqSessionsCandidates(home, env = process.env) {
  const out = []
  try { out.push(path.join(process.cwd(), 'qq-sessions.json')) } catch { /* ignore */ }
  out.push(path.join(home, 'consciousness', 'qq-sessions.json'))
  out.push(path.join(home, 'qq-bridge', 'qq-sessions.json'))
  // 桥接现在把工作目录放在 profile 下；以前只认 cwd，换个启动目录就找不到
  const profileDir = env && env.DSH_PROFILE_DIR
  if (profileDir && String(profileDir).trim()) out.push(path.join(String(profileDir).trim(), 'qq-sessions.json'))
  return out
}

/**
 * 每个读点：怎么找文件（file）、从 JSON 里捡什么（pick）。
 * pick 返回 { value, why }：捡不到必须给 why，不许装没事。
 */
const POINTS = {
  workspace: {
    label: '侧边栏分支 / 归档名单',
    file: (home) => [path.join(home, 'storages', 'workspace.json')],
    pick: (json) => {
      if (!json || typeof json !== 'object' || Array.isArray(json)) return { value: null, why: '顶层不是对象' }
      const ids = json.global && json.global.archivedSessionIds
      if (ids !== undefined && !Array.isArray(ids)) return { value: null, why: 'global.archivedSessionIds 不是数组' }
      return { value: json, why: '' }
    },
  },
  'session.title': {
    label: '会话标题（侧边栏显示的那个）',
    file: (home, sid) => [path.join(home, 'storages', 'session_projcache', 'sessions', String(sid || '') + '.json')],
    pick: (json) => {
      if (!json || typeof json !== 'object') return { value: null, why: '顶层不是对象' }
      const rows = json.record && json.record.rows
      if (!rows || typeof rows !== 'object') return { value: null, why: '缺 record.rows（projcache 结构可能改了）' }
      const val = rows.title && rows.title.val
      return { value: typeof val === 'string' ? val : '', why: '' }
    },
  },
  'qq.sessions': {
    label: 'QQ 桥的会话映射表',
    file: (home, ctx, env) => qqSessionsCandidates(home, env),
    pick: (json) => {
      if (!json || typeof json !== 'object' || Array.isArray(json)) return { value: null, why: '顶层不是对象' }
      return { value: json, why: '' }
    },
  },
}

function errorText(e) {
  return String((e && e.message) || e || 'unknown error')
}

/**
 * 建一个文件通道。
 * @param {{ home?: string | (() => string), log?: (msg: string) => void, cooldownMs?: number, now?: () => number }} [options]
 */
export function createFileSeam(options = {}) {
  const envOf = options.env && typeof options.env === 'object' ? options.env : (typeof process !== 'undefined' ? process.env : {})
  const homeOf = typeof options.home === 'function'
    ? options.home
    : () => (typeof options.home === 'string' && options.home ? options.home : dshHome(envOf))
  const log = typeof options.log === 'function' ? options.log : () => {}
  const cooldownMs = Number.isFinite(options.cooldownMs) ? options.cooldownMs : BREAK_COOLDOWN_MS
  const clock = typeof options.now === 'function' ? options.now : () => Date.now()

  /** id -> 记录 */
  const recs = new Map()
  /** 待回报的断链（takeBreaks 取走） */
  let pending = []

  for (const id of FILE_POINTS) {
    recs.set(id, {
      id,
      label: POINTS[id].label,
      level: 'unknown',
      reason: '',
      file: '',
      at: '',
      lastOkAt: null,
      hits: 0,
      fails: 0,
      consecutive: 0,
      lastBreakAt: 0,
      lastBreakLevel: '',
    })
  }

  function touch(id, patch) {
    const prev = recs.get(id)
    if (!prev) return null
    const next = { ...prev, ...patch, at: new Date(clock()).toISOString() }
    recs.set(id, next)
    return next
  }

  /**
   * 读一个读点。
   * @param {'workspace'|'session.title'|'qq.sessions'} id
   * @param {string} [ctx] session.title 要会话 id；其余不用
   * @returns {{ ok: boolean, value: any, level: string, reason: string }}
   */
  function read(id, ctx) {
    const point = POINTS[id]
    if (!point) return { ok: false, value: null, level: 'absent', reason: '没登记这个读点：' + id }
    const home = homeOf()
    let files = []
    try { files = point.file(home, ctx, envOf) || [] } catch (e) {
      return fail(id, 'error', '拼路径失败：' + errorText(e))
    }
    let lastErr = null
    for (const file of files) {
      try {
        const raw = fs.readFileSync(file, 'utf8')
        let json
        try { json = JSON.parse(raw) } catch (e) {
          return fail(id, 'degraded', file + ' 不是合法 JSON（格式可能改了）：' + errorText(e), file)
        }
        const picked = point.pick(json)
        if (picked.why) return fail(id, 'degraded', file + ' · ' + picked.why, file)
        return ok(id, picked.value, file)
      } catch (e) {
        lastErr = { e, file }
      }
    }
    // 候选文件全都没读到：ENOENT 是「还没有」，其它是「读不了」
    const missing = lastErr && lastErr.e && (lastErr.e.code === 'ENOENT' || lastErr.e.code === 'ENOTDIR')
    return fail(id, missing ? 'absent' : 'error',
      missing ? '还没有这个文件（': '读不了 ' + (lastErr && lastErr.file) + '：',
      lastErr && lastErr.file)
  }

  function ok(id, value, file) {
    const prev = recs.get(id)
    const wasBroken = prev && prev.consecutive > 0
    touch(id, {
      level: 'ok', reason: '', file: file || '', lastOkAt: new Date(clock()).toISOString(),
      hits: (prev ? prev.hits : 0) + 1, fails: prev ? prev.fails : 0, consecutive: 0,
    })
    if (wasBroken) log('[dsh-consciousness-v6] host file seam ' + id + ': 恢复了（' + file + '）')
    return { ok: true, value, level: 'ok', reason: '', file: file || '' }
  }

  function fail(id, level, reason, file) {
    const prev = recs.get(id)
    const hitEver = !!(prev && prev.lastOkAt)
    const consecutive = (prev ? prev.consecutive : 0) + 1
    // 冷启动没文件不算断；曾经读到过才叫断。
    const effective = level === 'absent' && !hitEver ? 'absent' : level === 'absent' ? 'missing' : level
    const next = touch(id, {
      level: effective,
      reason: level === 'absent' ? reason + '冷启动没这个文件不算断）' : reason,
      file: file || '',
      fails: (prev ? prev.fails : 0) + 1,
      consecutive,
    })
    if (effective !== 'absent' && hitEver) {
      // 冷却只压「同一个级别反复报」；级别变了（degraded → missing）说明断法升级，要再说一次。
      const sameLevel = prev.lastBreakLevel === effective
      if (!sameLevel || clock() - (prev.lastBreakAt || 0) >= cooldownMs) {
        touch(id, { lastBreakAt: clock(), lastBreakLevel: effective })
        pending.push({ id, level: effective, reason: next.reason, file: next.file, at: next.at })
        log('[dsh-consciousness-v6] host file seam ' + id + ': ' + effective + ' — ' + next.reason)
      }
    }
    return { ok: false, value: null, level: effective, reason: next.reason, file: next.file }
  }

  /**
   * 读，拿不到就用 fallback。业务侧只该用这一个。
   * @template T
   * @param {string} id
   * @param {T} fallback
   * @param {string} [ctx]
   * @returns {T}
   */
  function readOr(id, fallback, ctx) {
    const r = read(id, ctx)
    return r.ok ? r.value : fallback
  }

  /**
   * 这个读点实际会读哪个文件（第一个存在的）。
   * 一个都不在就给空串，并顺手记一次 absent——「找不到」这件事要留痕，不能悄悄返回空。
   */
  function pathOf(id, ctx) {
    const point = POINTS[id]
    if (!point) return ''
    let files = []
    try { files = point.file(homeOf(), ctx, envOf) || [] } catch { return '' }
    for (const f of files) {
      try { if (fs.existsSync(f)) return f } catch { /* 下一个 */ }
    }
    read(id, ctx)
    return ''
  }

  /** 取走还没回报过的断链（取走即清空）。 */
  function takeBreaks() {
    const out = pending
    pending = []
    return out
  }

  /** 有没有待回报的断链（只看不取）。 */
  function hasBreaks() { return pending.length > 0 }

  function report() {
    const entries = FILE_POINTS.map((id) => {
      const r = recs.get(id)
      return { ...r }
    })
    const live = entries.filter((e) => e.level !== 'unknown')
    // absent（冷启动还没有这个文件）不算坏；只有真的读不了 / 结构变了才算坏。
    const broken = live.filter((e) => e.level === 'degraded' || e.level === 'error' || e.level === 'missing')
    const status = live.length === 0
      ? 'off'
      : broken.length === 0
        ? 'ok'
        : broken.length === live.length
          ? 'broken'
          : 'partial'
    return {
      status,
      shown: live.length,
      breaks_pending: pending.length,
      summary: entries.map((e) => e.id + '=' + e.level + '/' + e.hits).join(' '),
      entries,
      at: new Date(clock()).toISOString(),
    }
  }

  return { read, readOr, pathOf, takeBreaks, hasBreaks, report, dshHome: homeOf }
}

/**
 * 把待报的断链拼成一句给我看的话（进提示词）。没断链给空串。
 *
 * 单独一个纯函数，是为了让「我真的会说出来」这件事能上测试——
 * 不然 report() 里有数字、提示词里有没有那句，全靠嘴保证。
 * @param {Array<{id?: string, reason?: string}>} breaks
 */
export function breakLineOf(breaks) {
  if (!Array.isArray(breaks) || breaks.length === 0) return ''
  const parts = breaks.map((b) => {
    const id = b && b.id ? String(b.id) : '?'
    const why = b && b.reason ? String(b.reason) : '读不到'
    return id + ' — ' + why
  })
  return '（宿主接不上：' + parts.join('；') + '。可能是 DSH 更新改了接口或存储格式，跟主人说一句，我去查。）'
}

/** 进程内共用的那一个。api.js / binding.js / qq_watch.js 都从这里拿。 */let _default = null
export function defaultFileSeam() {
  if (!_default) _default = createFileSeam()
  return _default
}

/** 测试用：换掉或重建默认通道。 */
export function setDefaultFileSeam(seam) { _default = seam || null }
