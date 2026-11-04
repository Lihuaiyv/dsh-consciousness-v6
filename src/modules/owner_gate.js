/**
 * 认人硬闸（owner gate）· 客人拿不到主人的记忆
 *
 * 原来的口子：`memory_search` 的 execute 只看 db 和 aid，不看**是谁在调**。
 * QQ 桥接给每个陌生人建的是真 agent，那个 agent 一旦调 memory_search，
 * 主人的长期记忆就顺着工具结果端出去了——提示词那边早就按 isOwner 分了岔
 * （model.js 里客人那段明说「不要称呼主人」），只有工具这条路一直没闸。
 *
 * 两道，故意不共用一条代码路径：
 *   1. tools.guard —— 宿主在执行前问一句，返回字符串就是拒绝理由（主闸，模型看到被挡）
 *   2. memory_search.execute 里再判一次 —— 守卫那层注册失败/降级时还拦得住（不让漏）
 *
 * 判定（从严到宽）：
 *   非 QQ 会话（网页 / 本机）        → 主人，放行
 *   QQ 私聊 且 isOwner              → 主人，放行
 *   QQ 群聊                         → 客人，拒（群里不是主人一个人的会话）
 *   主人号一个都没配（ownerUnset）  → 认不出，拒（宁可少给，不可串人）
 *   其它 QQ（陌生人 / 映射表认不出）→ 客人，拒
 *   拿不到会话 id                   → 判不了，放行 + 记一条 gate.ungated
 *                                     （真机上能看出这种情况到底有没有发生过）
 *
 * 跟 qq_bridge 的分工：那边管「记不记」，这边管「给不给」。同一套认人依据。
 */

import { event, getParam } from '../kernel.js'
import { identifyQQSession, loadSessionMap, parseOwnerQq } from './qq_bridge.js'

/** 被闸住的工具。目前只有它会真的把主人的长期记忆端出来。 */
export const GATE_TOOL = 'memory_search'

export const REASON_GUEST =
  '这条会话不是主人本人——不能替他从记忆里翻东西。'
export const REASON_GROUP =
  '这是群聊，不是主人一个人的会话——不能在这里翻他的记忆。'
export const REASON_UNSET =
  '主人号还没配（qq.bridge.owner_qq / qq.owner 都是空的），认不出这是不是主人，先不让翻记忆。'

export const EVENT_DENIED = 'gate.denied'
export const EVENT_UNGATED = 'gate.ungated'

function flagOf(db, key) {
  try {
    const r = db.prepare('SELECT value FROM flags WHERE key=?').get(String(key))
    return r && r.value != null ? String(r.value) : ''
  } catch { return '' }
}

/**
 * 主人号来源有两处，并起来一起认：
 *   `qq.bridge.owner_qq`（桥接插件用，参数表）
 *   `qq.owner`（老配置，flags 表）
 *
 * 刻意**不带** conversations.js 里那个 FALLBACK_OWNER 兜底号：
 * 兜底号是给「本机自己」判断「这句话算不算关于主人」用的，
 * 放进硬闸等于凭空多出一个能翻记忆的主人。
 */
export function ownerQqList(db, param) {
  const read = typeof param === 'function' ? param : () => ''
  const out = new Set()
  try { for (const q of parseOwnerQq(read('qq.bridge.owner_qq'))) out.add(q) } catch { /* 参数读不到就当没配 */ }
  try { for (const q of parseOwnerQq(flagOf(db, 'qq.owner'))) out.add(q) } catch { /* 同上 */ }
  return [...out]
}

/**
 * 纯判定，不碰数据库以外的任何东西——测试直接喂 sessionId 就能验。
 * @returns {{ok:boolean, guest:boolean, kind:'local'|'owner'|'group'|'stranger'|'unset'|'unknown'|'ungated'|'off', reason:string, who:object|null}}
 */
export function guestVerdict(sessionId, { owners = [], sessionMap = null } = {}) {
  const sid = String(sessionId || '')
  if (!sid) return { ok: true, guest: false, kind: 'ungated', reason: '', who: null }
  let who = null
  try { who = identifyQQSession(sid, owners, sessionMap) } catch { who = null }
  if (!who || who.isQQ !== true) return { ok: true, guest: false, kind: 'local', reason: '', who: null }
  if (who.isOwner) return { ok: true, guest: false, kind: 'owner', reason: '', who }
  if (who.kind === 'g') return { ok: false, guest: true, kind: 'group', reason: REASON_GROUP, who }
  // 没配主人号时，「认不出」不等于「确认是陌生人」，单独给个说得清的理由，别让人以为号配错了
  if (who.ownerUnset) return { ok: false, guest: true, kind: 'unset', reason: REASON_UNSET, who }
  return { ok: false, guest: true, kind: who.kind === 'u' ? 'stranger' : 'unknown', reason: REASON_GUEST, who }
}

/**
 * 把「谁是主人」和「会话映射表」都读出来，再判。
 * 守卫层和执行层都走这一条，免得两边认人认得不一致。
 */
export function verdictFor({ db, aid = '', sessionId = '', param, findSessionsFile } = {}) {
  const read = typeof param === 'function'
    ? param
    : (k) => (db && aid ? getParam(db, aid, k) : undefined)
  // 总开关：关掉就完全不管，行为和没这层一样（排查时能一键退回去）
  if (String(read('gate.guest.enable') ?? 'on') !== 'on') {
    return { ok: true, guest: false, kind: 'off', reason: '', who: null }
  }
  let owners = []
  try { owners = ownerQqList(db, read) } catch { owners = [] }
  let sessionMap = null
  try {
    const file = String(read('qq.bridge.sessions_file') || '')
      || (typeof findSessionsFile === 'function' ? String(findSessionsFile() || '') : '')
    sessionMap = file ? loadSessionMap(file) : null
  } catch { sessionMap = null }
  return guestVerdict(sessionId, { owners, sessionMap })
}

function audit(db, aid, type, payload) {
  try { event(db, String(aid || ''), type, payload) } catch { /* 记账失败不影响判定 */ }
}

/**
 * 宿主守卫：`ToolGuard = (execution) => string | undefined`。
 *
 * 只对 `tool` 那一个工具生效，别的工具原样放过（守卫是全局的，
 * 一条把整个工具链带走的判定会是灾难）。自己出任何错都放行——
 * 守卫坏了应该少拦一次，不该让所有工具都调不动。
 */
export function makeOwnerGuard({ getDb, getAid, param, findSessionsFile, tool = GATE_TOOL } = {}) {
  return function ownerGuard(execution) {
    try {
      if (!execution || String(execution.name || '') !== tool) return undefined
      const db = typeof getDb === 'function' ? getDb() : null
      if (!db) return undefined
      const aid = typeof getAid === 'function' ? String(getAid() || '') : ''
      const sid = execution.agent && execution.agent.id ? String(execution.agent.id) : ''
      const v = verdictFor({ db, aid, sessionId: sid, param, findSessionsFile })
      if (v.ok) {
        if (v.kind === 'ungated') audit(db, aid, EVENT_UNGATED, { tool, why: '调用没有带会话 id，判不了是谁' })
        return undefined
      }
      audit(db, aid, EVENT_DENIED, {
        tool,
        sessionId: sid,
        kind: v.kind,
        chatKey: (v.who && v.who.chatKey) || '',
        peerId: (v.who && v.who.peerId) || '',
      })
      return v.reason
    } catch {
      return undefined
    }
  }
}
