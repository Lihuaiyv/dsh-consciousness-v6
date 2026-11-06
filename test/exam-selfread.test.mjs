/**
 * 自我回读零件 · 考卷
 *
 * 管的是「她自己那句话读起来多暖，跟那一刻的情绪对不对得上」：只读字面温度，
 * 最多把快情绪挪一点；慢情绪、slow_at 一概不碰。
 *
 * 不管「这句话说得好不好」（判准在人）、不管「情绪下一步怎么走」（情绪动力）、
 * 不管「记忆怎么写」（记忆写入闸）。
 *
 * 运行：node test/exam-selfread.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { readReplyTone, applySelfRead } from '../src/modules/self_read.js'
import { writeParam } from '../src/kernel.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps

// ================================================================ 读温度：只认字面
{
  check('空句：读不出', readReplyTone('') === null)
  check('空白：读不出', readReplyTone('   ') === null)
  const short = readReplyTone('嗯')
  check('一个字：算短句', short && short.flat === true && short.len === 1, short)
  const warm = readReplyTone('今天陪你改了一整天，累不累呀～')
  check('暖句：温度为正', warm && warm.warmth > 0.2, warm)
  check('暖句：数出语气词', warm && warm.warm === 2, warm)
  const cool = readReplyTone('算了，随便吧。')
  check('冷句：温度为负', cool && cool.warmth < 0, cool)
  check('冷句：数出冷淡词', cool && cool.cool === 2, cool)
  const longer = readReplyTone('今天把那段测试从头到尾又跑了一遍，最后发现是一个时间戳写死了，改完之后全绿。')
  check('长句：温度跟着涨（有上限）', longer && longer.warmth > 0 && longer.warmth <= 0.45, longer)
  const withExcl = readReplyTone('好开心！')
  const noExcl = readReplyTone('好开心')
  check('感叹号：加一点温', withExcl.warmth > noExcl.warmth, { withExcl, noExcl })
  const withDot = readReplyTone('我知道了这件事。')
  const noDot = readReplyTone('我知道了这件事')
  check('短句收句号：更平一点', withDot.warmth < noDot.warmth, { withDot, noDot })
  check('温度夹在 -1..1', [-1, 1].every((x) => x === x) && warm.warmth <= 1 && cool.warmth >= -1, { warm: warm.warmth, cool: cool.warmth })
}

// ================================================================ 不写：关掉、空、太短、没状态
{
  const w = makeWorld()
  try {
    writeParam(w.db, w.aid, 'affect.selfread', 'off')
    const off = applySelfRead(w.db, w.aid, '今天陪你改了一整天，累不累呀～')
    check('开关关掉：不动', off.applied === false && off.reason === 'off', off)
    check('关掉时也没算 delta', off.delta === 0, off)
    writeParam(w.db, w.aid, 'affect.selfread', 'on')
    const empty = applySelfRead(w.db, w.aid, '')
    check('空句：不动', empty.applied === false && empty.reason === 'empty', empty)
    const flat = applySelfRead(w.db, w.aid, '嗯')
    check('太短：读不出，不动', flat.applied === false && flat.reason === 'flat', flat)
    w.db.prepare('DELETE FROM affect_v3 WHERE agent_id=?').run(w.aid)
    const noState = applySelfRead(w.db, w.aid, '今天陪你改了一整天，累不累呀～')
    check('没有情绪状态：不动', noState.applied === false && noState.reason === 'no_state', noState)
  } finally { w.close() }
}

// ================================================================ 对不上才改：拿快情绪比
{
  const w = makeWorld()
  try {
    // makeWorld：slow 0.05 / fast 0.00
    const before = w.db.prepare('SELECT slow, fast, total, slow_at, fast_at FROM affect_v3 WHERE agent_id=?').get(w.aid)
    const out = applySelfRead(w.db, w.aid, '今天陪你改了一整天，累不累呀～', { at: Date.now() })
    check('暖句对不上：改', out.applied === true, out)
    check('只挪快情绪，且不超过 0.02', out.applied === true && out.delta > 0 && out.delta <= 0.02, out)
    const veryWarm = applySelfRead(w.db, w.aid, '哈哈哈哈哈哈哈哈！', { at: Date.now() })
    check('特别暖：也只挪到上限 0.02', veryWarm.applied === true && Math.abs(veryWarm.delta) === 0.02, veryWarm)
    const after = w.db.prepare('SELECT slow, fast, total, slow_at, fast_at FROM affect_v3 WHERE agent_id=?').get(w.aid)
    check('慢情绪一分没动', Number(after.slow) === Number(before.slow), { before, after })
    check('slow_at 没动', after.slow_at === before.slow_at, { before, after })
    check('快情绪真的上去了', Number(after.fast) > Number(before.fast), { before, after })
    check('总数按慢 + 0.35×快 重算', near(Number(after.total), Number(after.slow) + 0.35 * Number(after.fast)), { after })
    check('fast_at 记下了', after.fast_at && after.fast_at !== before.fast_at, { before, after })

    const close = w.db.prepare('SELECT fast FROM affect_v3 WHERE agent_id=?').get(w.aid).fast
    const nearText = '今天天气还不错我们出去走走吧'
    const tone = readReplyTone(nearText)
    w.db.prepare('UPDATE affect_v3 SET fast=? WHERE agent_id=?').run(tone.warmth, w.aid)
    const closeOut = applySelfRead(w.db, w.aid, nearText)
    check('读出来的温度和现在差不多：不折腾', closeOut.applied === false && closeOut.reason === 'close', { closeOut, close, tone })
  } finally { w.close() }
}

{
  const w = makeWorld()
  try {
    const out = applySelfRead(w.db, w.aid, '算了，随便吧。')
    check('冷句：往回拉', out.applied === true && out.delta < 0, out)
    check('往下改只取一半（防自锁）', out.applied === true && Math.abs(out.delta) <= 0.02, out)
    const row = w.db.prepare('SELECT fast, slow, total FROM affect_v3 WHERE agent_id=?').get(w.aid)
    check('改完仍然在界内', row.fast >= -1 && row.fast <= 1, row)
  } finally { w.close() }
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
