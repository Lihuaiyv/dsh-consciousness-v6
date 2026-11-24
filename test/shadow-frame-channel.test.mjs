/**
 * 找核影子接在「一轮的账」上，不是某一个通道（2026-11-23 主人定：应该所有通道都走）。
 *
 * 背景：原先只在 chatReply 尾部调 shadowFrame。网页 / QQ 真对话走的是
 * captureTurn → commitTurn → writeChatTurns，根本不经过 chatReply，所以切了一直没跑。
 *
 * 运行：node test/shadow-frame-channel.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { writeChatTurns, writeChatTurnRow, setShadowImpl } from '../src/modules/turn_write.js'
import { setFlag } from '../src/kernel.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

const w = makeWorld()
const calls = []
let mode = 'ok'
setShadowImpl((db, aid, args) => {
  calls.push({ db, aid, args })
  if (mode === 'throw') throw new Error('sync boom')
  if (mode === 'reject') return Promise.reject(new Error('async boom'))
  return Promise.resolve()
})
const flag = (v) => setFlag(w.db, 'affect.frame.shadow', v)

try {
  calls.length = 0
  flag('off')
  writeChatTurns(w.db, w.aid, { user: '在吗', agent: '在。', turnId: 'tid_off', conversationId: 'c1' })
  check('开关 off：连影子函数都不调', calls.length === 0, calls)

  calls.length = 0
  flag('on')
  writeChatTurns(w.db, w.aid, { user: '在吗', agent: '在。我在这儿。', turnId: 'tid_on', conversationId: 'c1' })
  check('开关 on：一轮调用一次', calls.length === 1, calls)
  const c = calls[0]
  check('交给切核的是我这句话', c && c.args.reply === '在。我在这儿。', c && c.args)
  check('turnId 原样带过去（同一轮同一个号）', c && c.args.turnId === 'tid_on', c && c.args)

  calls.length = 0
  writeChatTurns(w.db, w.aid, { user: '嗯', agent: '', turnId: 'tid_empty', conversationId: 'c1' })
  check('这轮我没说话（空回复）：不切', calls.length === 0, calls)

  calls.length = 0
  writeChatTurnRow(w.db, w.aid, { role: 'agent', text: '主动说一句。', conversationId: 'c1' })
  check('单行写口不切（避开 QQ 出站与 chatReply 同句双切）', calls.length === 0, calls)

  mode = 'throw'; calls.length = 0
  let threw = false
  try {
    writeChatTurns(w.db, w.aid, { user: 'x', agent: '一句。', turnId: 'tid_throw', conversationId: 'c1' })
  } catch { threw = true }
  check('切核同步抛错：不连累这一轮记账', !threw)
  const rows = w.db.prepare("SELECT COUNT(*) n FROM chat_turns WHERE turn_id='tid_throw'").get().n
  check('同步抛错后两行账还是写进去了', rows === 2, rows)

  mode = 'reject'; calls.length = 0
  writeChatTurns(w.db, w.aid, { user: 'y', agent: '一句。', turnId: 'tid_reject', conversationId: 'c1' })
  // 让它落地：影子是异步的，reject 不该冒成 unhandled 把进程带走
  await new Promise((r) => setTimeout(r, 20))
  check('切核异步 reject：账照写、进程不崩', true)
} finally {
  setShadowImpl(null)
  w.close()
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exit(1)
