/**
 * 一轮对话的两行账（user + agent），两条写链共用一处。
 *
 * 2026-11-13：`commitTurn`（网页 / QQ 桥，index.js）与 `chatReply`（/chat、微信、QQ，features.js）
 * 原先各写一份 chat_turns，INSERT 形状一样、mood/pack 来源不一样，靠「别同时跑」的约定撑着。
 * 这里先只收「形状」：谁传什么 mood/pack 由调用方决定，行为不变；
 * 下一步再收 appendTurn / 每轮 episode（见 docs/计划-记忆统一-v2 的 P2④）。
 *
 * 2026-11-13 16:1x（地基 A1）：mode 不再靠调用方记得传——缺省时按 isWorkMode 现算；
 * 新增单行写口 writeChatTurnRow，收掉 actions / qq_push / qq_bridge / wechat_inbox 四处直写。
 */
import { nid } from '../kernel.js'
import { now } from '../db.js'
import { isWorkMode } from './work_mode.js'
// 2026-11-15（D59）：白天自己点名要留的句子（〔留〕）。
import { extractPins, recordPins } from './quote_pin.js'
// 2026-11-15：留一句的来源里要带上「我自己写的那句 feel」——没有就空着，不拿标签顶。
import { latestFeel } from './feel.js'
// 帧：只加一条原始帧（不含向量），开关 frame.write，默认 off。
import { appendTurnFrame } from './frame_store.js'
// 帧写完立刻补算向量/偏离（python 子进程，后台，不占开口时间），开关 frame.compute。
import { kickFrameCompute } from './frame_compute.js'

/** 调用方给了就用；没给（null/空串）就按当前工作模式现算。算不出才留 null。 */
function resolveMode(db, aid, mode) {
  if (mode != null && String(mode).trim() !== '') return String(mode)
  try { return isWorkMode(db, aid) ? 'work' : 'chat' } catch { return null }
}

export function writeChatTurns(db, aid, {
  user,
  agent,
  at = now(),
  conversationId = null,
  mood = null,
  packUser = '[]',
  packAgent = '[]',
  turnId = null,
  mode = null,
} = {}) {
  const m = resolveMode(db, aid, mode)
  // 2026-11-15（D59）：先把〔留〕的句子摘出来，正文里不留标记；留下来的单独记一条（带来源）。
  const { clean: agentText, pins } = extractPins(agent)
  db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id,turn_id,mode) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(nid('cht_'), aid, 'user', String(user ?? ''), packUser, mood, at, conversationId, turnId || null, m)
  db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id,turn_id,mode) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(nid('cht_'), aid, 'agent', String(agentText ?? ''), packAgent, mood, now(), conversationId, turnId || null, m)
  if (pins.length) {
    try {
      // 有 feel 就带上（我写的那句）；没有就不写这个字段——不拿系统判的情绪标签顶替。
      let feel = null
      try {
        const f = latestFeel(db, aid, { at: Date.parse(at) || Date.now(), maxAgeMin: 30, sessionId: conversationId })
        feel = f && f.text ? String(f.text) : null
      } catch { feel = null }
      recordPins(db, aid, { pins, turnId: turnId || null, session: conversationId, feel, at: Date.parse(at) })
    } catch { /* 留不下来不连累这轮 */ }
  }
  // 帧：一轮 = 一帧，按会话分链。失败不影响这轮账（记账坏了不能连累回话）。
  try {
    if (agentText && appendTurnFrame(db, aid, { user, agent: agentText, conv: conversationId, turnId })) {
      // 写完就把它算掉：否则要等 5 分钟心跳，那时“力”早就失效了。
      kickFrameCompute(db)
    }
  } catch { /* 帧写坏了不算这轮的错 */ }
  return { at, mood, mode: m }
}

/**
 * 单行写口：只记一行（主动发出、桥接入站、工具发信这些「没有成对两行」的场景）。
 * 和 writeChatTurns 共用同一套列；mode 缺省同样现算。
 */
export function writeChatTurnRow(db, aid, {
  role = 'agent',
  text = '',
  at = now(),
  conversationId = null,
  pack = '[]',
  mood = null,
  turnId = null,
  mode = null,
} = {}) {
  const m = resolveMode(db, aid, mode)
  // 2026-11-15（D59）：单行写口也认〔留〕——主动开口、桥接入站也能留一句。
  const { clean: rowText, pins: rowPins } = String(role || 'agent') === 'agent'
    ? extractPins(text)
    : { clean: text, pins: [] }
  db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id,turn_id,mode) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(nid('cht_'), aid, String(role || 'agent'), String(rowText ?? ''), pack, mood, at, conversationId, turnId || null, m)
  if (rowPins.length) {
    try {
      let feel = null
      try {
        const f = latestFeel(db, aid, { at: Date.parse(at) || Date.now(), maxAgeMin: 30, sessionId: conversationId })
        feel = f && f.text ? String(f.text) : null
      } catch { feel = null }
      recordPins(db, aid, { pins: rowPins, turnId: turnId || null, session: conversationId, feel, at: Date.parse(at) })
    } catch { /* 留不下来不连累这行 */ }
  }
  // 单行写口也落帧（主动开口、桥接入站这些没有成对两行）。
  // 只有 agent 行算「我说了一句」；user 行不该单独成帧。
  try {
    if (String(role || 'agent') === 'agent' && rowText) {
      if (appendTurnFrame(db, aid, { user: '（单行）', agent: String(rowText), conv: conversationId, turnId })) {
        kickFrameCompute(db)
      }
    }
  } catch { /* 同上：帧坏了不连累这行 */ }
  return m
}
