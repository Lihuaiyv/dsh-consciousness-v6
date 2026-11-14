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
// 帧：只加一条原始帧（不含向量），开关 frame.write，默认 off。
import { appendTurnFrame } from './frame_store.js'

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
  db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id,turn_id,mode) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(nid('cht_'), aid, 'user', String(user ?? ''), packUser, mood, at, conversationId, turnId || null, m)
  db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id,turn_id,mode) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(nid('cht_'), aid, 'agent', String(agent ?? ''), packAgent, mood, now(), conversationId, turnId || null, m)
  // 帧：一轮 = 一帧，按会话分链。失败不影响这轮账（记账坏了不能连累回话）。
  try {
    if (agent) appendTurnFrame(db, aid, { user, agent, conv: conversationId })
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
  db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id,turn_id,mode) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(nid('cht_'), aid, String(role || 'agent'), String(text ?? ''), pack, mood, at, conversationId, turnId || null, m)
  // 单行写口也落帧（主动开口、桥接入站这些没有成对两行）。
  // 只有 agent 行算「我说了一句」；user 行不该单独成帧。
  try {
    if (String(role || 'agent') === 'agent' && text) {
      appendTurnFrame(db, aid, { user: '（单行）', agent: String(text), conv: conversationId })
    }
  } catch { /* 同上：帧坏了不连累这行 */ }
  return m
}
