/**
 * 微信收信：从本地库里捞「比水位新的消息」，写进聊天账本和原文层。
 *
 * 为什么读库不读窗口：微信 4.x 的聊天界面是自绘的，UIA 只给 Qt 空壳（实测 0 个控件），
 * 而本地库能解密、能按会话读。这条路一次都不点窗口——收信不该打扰她。
 * 真正的读库动作在 scripts/wechat-inbox.py；这里只管水位、防重、落账。
 *
 * 纪律：
 *   1) 只读：不回复、不触发开口。收到的话先进账本，回不回是别的地方的事。
 *   2) 水位按会话记在 flags（key = `wechat:inbox:<username>`，存 sort_seq 毫秒）。
 *      没有水位的会话第一次只「落水位、不灌历史」——接上那天不该把几千条旧消息吞进来。
 *   3) 一条消息的身份 = `wx:<username>:<sort_seq>`，交给 appendTurn 去重；
 *      T4 说重复就不写 chat_turns，一句话只记一次。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { now } from '../db.js'
import { isOwner } from './conversations.js'
import { appendTurn } from './archive.js'

const SCRIPT_PATH = fileURLToPath(new URL('../../scripts/wechat-inbox.py', import.meta.url))
const PYTHON = process.env.DSHC_PYTHON || 'python'
const FLAG_PREFIX = 'wechat:inbox:'

/** 这个联系人在这段账本里的 conversation_id：和发信那边同口径（`wechat:<名字>`）。 */
export function conversationIdOfWeChat(name) {
  const n = String(name || '').trim()
  return n ? 'wechat:' + n : ''
}

function flagKey(username) {
  return FLAG_PREFIX + String(username || '')
}

export function getSeen(db, username) {
  try {
    const r = db.prepare('SELECT value FROM flags WHERE key=?').get(flagKey(username))
    return Number(r && r.value) || 0
  } catch { return 0 }
}

function setSeen(db, username, seq) {
  const n = Number(seq) || 0
  if (!username || n <= 0) return
  try {
    db.prepare('INSERT OR REPLACE INTO flags(key,value) VALUES(?,?)').run(flagKey(username), String(n))
  } catch { /* 水位写不进去下次会重读，最多多查一遍，不会丢消息 */ }
}

/** 已经记到哪儿的全部水位（给「不指定会话」那次用）。 */
function allSeen(db) {
  const out = {}
  try {
    for (const r of db.prepare("SELECT key, value FROM flags WHERE key LIKE 'wechat:inbox:%'").all()) {
      const who = String(r.key).slice(FLAG_PREFIX.length)
      const n = Number(r.value) || 0
      if (who && n > 0) out[who] = n
    }
  } catch { /* 老库没 flags 表就当没有 */ }
  return out
}

/**
 * 起 Python 读一次库。返回它的 JSON；读不出来就抛，由调用方决定要不要当「这次没读到」。
 * @param {{chats?:string[]|null, limit?:number, seen?:Record<string,number>}} payload
 */
export function runWeChatInbox(payload, { python = PYTHON, pre = [], timeoutMs = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SCRIPT_PATH)) {
      reject(new Error('找不到 scripts/wechat-inbox.py：' + SCRIPT_PATH))
      return
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-wx-in-'))
    const reqFile = path.join(dir, 'request.json')
    const outFile = path.join(dir, 'result.json')
    fs.writeFileSync(reqFile, JSON.stringify(payload || {}), 'utf8')

    let child
    try {
      child = spawn(python, [...pre, SCRIPT_PATH, reqFile, outFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true })
      reject(new Error('起不了 Python：' + String((e && e.message) || e)))
      return
    }

    let stderr = ''
    child.stderr.on('data', (b) => { if (stderr.length < 4000) stderr += b.toString('utf8') })

    let settled = false
    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录删不掉不算错 */ }
      fn(arg)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已经退出 */ }
      finish(reject, new Error('读微信本地库超时（' + Math.round(timeoutMs / 1000) + ' 秒）'))
    }, Math.max(5000, timeoutMs))

    child.on('error', (e) => finish(reject, new Error('Python 起不来：' + String((e && e.message) || e))))
    child.on('close', (code) => {
      let raw = ''
      try { raw = fs.readFileSync(outFile, 'utf8') } catch { raw = '' }
      if (!raw) {
        finish(reject, new Error('微信收信脚本没产出结果（exit=' + code + '）'
          + (stderr ? '：' + stderr.trim().slice(0, 300) : '')))
        return
      }
      try { finish(resolve, JSON.parse(raw)) } catch {
        finish(reject, new Error('微信收信脚本的结果不是 JSON（exit=' + code + '）'))
      }
    })
  })
}

/**
 * 捞一次新消息，落账。
 *
 * @param {object} o
 * @param {any} o.db
 * @param {string} o.aid
 * @param {string[]|null} [o.chats] 只收这几个会话（username）；不给就收「最近有消息的全部」
 * @param {string} [o.skip] 不收的会话，逗号/空格分开（按 username 或显示名匹配）
 * @param {number} [o.limit] 每个会话最多往回读多少条
 * @param {boolean} [o.seed] 没有水位的会话要不要顺手把历史也收了（默认 false：只落水位）
 * @param {Function} [o.run] 测试注入用
 * @returns {Promise<{ok:boolean, note?:string, added:number, seeded:string[], chats:string[]}>}
 */
export async function pollWeChatInbox(o = {}) {
  const { db, aid } = o
  const limit = Math.max(1, Math.min(200, Number(o.limit) || 40))
  const run = typeof o.run === 'function' ? o.run : (p) => runWeChatInbox(p, { python: o.python, pre: o.pre, timeoutMs: o.timeoutMs })
  const chats = Array.isArray(o.chats) && o.chats.length ? o.chats.map(String) : null
  const skipWords = String(o.skip || '').split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean)

  const payload = { chats, limit, seen: chats ? Object.fromEntries(chats.map((c) => [c, getSeen(db, c)])) : allSeen(db) }
  let res
  try {
    res = await run(payload)
  } catch (e) {
    return { ok: false, note: String((e && e.message) || e).slice(0, 300), added: 0, seeded: [], chats: [] }
  }
  if (!res || res.ok !== true) {
    return { ok: false, note: String((res && res.note) || '读不到微信本地库').slice(0, 300), added: 0, seeded: [], chats: [] }
  }

  const added = []
  const seeded = []
  const touched = []
  const replied = []
  for (const chat of res.chats || []) {
    const username = String(chat.username || '')
    if (!username) continue
    const name = String(chat.name || username)
    if (skipWords.some((w) => w === username || w === name)) continue
    const msgs = Array.isArray(chat.messages) ? chat.messages : []
    const seen = chats ? getSeen(db, username) : (payload.seen[username] || 0)
    const maxSeq = msgs.reduce((n, m) => Math.max(n, Number(m.sort_seq) || 0), seen)
    // 主人号：不自己记账，把这一轮交给回调（它会走完整条回复管线，顺手把话记了）
    const owner = typeof o.onOwnerMessage === 'function' ? isOwner(db, username) : false

    // 第一次见到这个会话：只记水位，不灌历史（接上那天别把几年旧消息吞进记忆）。
    // 例外：主人号且最后一句是刚发的（两小时内）——接上那一刻他也该被接住。
    if (!seen && !o.seed) {
      if (owner && msgs.length) {
        const last = msgs[msgs.length - 1]
        const fresh = Date.now() - (Date.parse(String(last.at || '')) || 0) < 2 * 60 * 60 * 1000
        if (fresh && !last.self) {
          try {
            const ok = await o.onOwnerMessage({ db, aid, name, username, text: String(last.text || ''), at: String(last.at || '') || now() })
            if (ok) replied.push(name)
          } catch { /* 接不住就只落水位，下一句再说 */ }
        }
      }
      setSeen(db, username, maxSeq)
      seeded.push(name)
      continue
    }

    const conv = conversationIdOfWeChat(name)
    for (const m of msgs) {
      const text = String(m.text || '')
      if (!text.trim()) continue
      const seq = Number(m.sort_seq) || 0
      if (seen && seq && seq <= seen) continue
      const at = String(m.at || '') || now()
      const role = m.self ? 'agent' : 'user'
      // 自己刚发出去的话，发信那边已经记过一笔（conversation 同名、role=agent、同一句）。
      // 再从库里读回来就是第二笔——十秒到十分钟内同文同会话，认成同一条，跳过。
      if (role === 'agent') {
        try {
          const since = new Date((Date.parse(at) || Date.now()) - 10 * 60 * 1000).toISOString()
          const already = db.prepare("SELECT 1 FROM chat_turns WHERE agent_id=? AND conversation_id=? AND role='agent' AND text=? AND created_at>=?")
            .get(aid, conv, text, since)
          if (already) continue
        } catch { /* 查不到就当没记过 */ }
      }
      // 主人说的话：交给回调走完整管线（召回 → 回一句 → 记账 → 发出去）。
      // 回调说「处理了」就不再记一遍；回调抛错/返回 false 就退回普通记账，话不能丢。
      if (owner && role === 'user') {
        let handled = false
        try { handled = !!(await o.onOwnerMessage({ db, aid, name, username, text, at })) } catch { handled = false }
        if (handled) { replied.push(name); continue }
      }
      const turnId = 'wx:' + username + ':' + (m.id || seq)
      let dup = false
      try {
        const app = appendTurn(db, aid, {
          sessionId: conv, role, text, turnId, at,
          meta: { channel: 'wechat', chat: username, type: String(m.type || '') },
        })
        dup = !!(app && app.duplicate)
      } catch { /* 原文写不进也要继续把这一批剩下的记完 */ }
      if (!dup) {
        try {
          db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id) VALUES(?,?,?,?,?,?,?,?)')
            .run('cht_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 10), aid, role, text, '[]', null, at, conv)
        } catch { /* 账本写不进不影响消息已经读到 */ }
        added.push({ chat: name, role, text: text.slice(0, 80) })
      }
    }
    if (maxSeq > seen) setSeen(db, username, maxSeq)
    touched.push(name)
  }

  return { ok: true, added: added.length, seeded, chats: touched, replied, items: added.slice(0, 20) }
}
