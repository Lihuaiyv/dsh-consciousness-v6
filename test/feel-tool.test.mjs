/**
 * 「说话那一刻的感觉」通路（feel 工具）。
 * 运行：node test/feel-tool.test.mjs
 *
 * 验四件事：
 *   1. 工具真注册出去了（形状过宿主那套校验），不是只写好放着
 *   2. 落库对了：一句话 + 当时的快/慢，且**不动情绪**（一个新写入点就是一个新 bug 面）
 *   3. 频率闸：太密跳过、重话跳过、空话跳过、太长掐断
 *   4. 注入：下一轮能看到「我上一句说出来之前心里是什么样」，而且不是给客人看的
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { moodLabelOf } from '../src/modules/affect.js'
import { consciousnessBlock } from '../index.js'
import { recordFeel, latestFeel, feelLineOf, feelTextForInject, cleanFeelText, feelAnchorOf, echoFeelOf, echoFeelLineOf, FEEL_TRIGGER } from '../src/modules/feel.js'
import { createActionTools } from '../src/modules/actions/index.js'
import { writeParam } from '../src/kernel.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}
const T0 = Date.now() - 3600 * 1000 // 一小时前：既不在未来，也不会被 8 小时窗口判老

const w = makeWorld()
const { db, aid } = w

// ---------- 一、工具形状（宿主 validateTool 的那套口径） ----------
const tools = createActionTools({ getDb: () => db, getAgentId: () => aid })
const feel = tools.find((t) => t.name === 'feel')
check('feel 工具在注册列表里', !!feel, tools.map((t) => t.name))
check('有 name / description', !!(feel && feel.name && feel.description))
check('有 parameters', !!(feel && feel.parameters && typeof feel.parameters === 'object'))
check('有 output.schema + render', !!(feel && feel.output && feel.output.schema && typeof feel.output.render === 'function'))
check('execute 是函数', !!(feel && typeof feel.execute === 'function'))
check('必填 text 写进了 schema', !!(feel && Array.isArray(feel.parameters.required) && feel.parameters.required.includes('text')), feel && feel.parameters.required)
check('描述里说清「不写数字、不进正文」', /不写数字/.test(feel.description) && /不进你要说出口的话/.test(feel.description))
// 每轮那句不参与预算削减，所以没人拦它变长——这里当闸：超 80 字就红。
check('每轮那句不超过 80 字（它不参与预算，长了会挤别人）', FEEL_TRIGGER.length <= 80, { len: FEEL_TRIGGER.length, text: FEEL_TRIGGER })

// ---------- 二、落库 ----------
const before = db.prepare('SELECT slow, fast, total FROM affect_v3 WHERE agent_id=?').get(aid)
const r1 = await feel.execute({ text: '手指停在半空，\n又怕显得急' }, { agent: { id: 'sess_qq_owner' } })
check('记下了', r1.ok === true, r1)
check('返回值没有 undefined 键（宿主的 lossless JSON 会拒）',
  Object.values(r1).every((v) => v !== undefined) && !Object.prototype.hasOwnProperty.call(r1, 'hint'), r1)
check('成功回执不带落点字段（不留监工）',
  !Object.prototype.hasOwnProperty.call(r1, 'anchor') && !Object.prototype.hasOwnProperty.call(r1, 'hint'), Object.keys(r1))
check('换行被折成一行', r1.text === '手指停在半空， 又怕显得急', r1.text)
const row = db.prepare('SELECT * FROM affect_feel WHERE agent_id=? ORDER BY at DESC LIMIT 1').get(aid)
check('库里有一条', !!row, row)
check('带上了当时的快/慢（不是事后补算）', Number.isFinite(Number(row.fast)) && Number.isFinite(Number(row.slow)), row)
check('session 记下来了', row.session_id === 'sess_qq_owner', row.session_id)
const after = db.prepare('SELECT slow, fast, total FROM affect_v3 WHERE agent_id=?').get(aid)
check('不动情绪：慢/快/总一个数没变',
  JSON.stringify(before) === JSON.stringify(after), { before, after })
check('渲染只回一句确认，不回原文（不然等于喂回自己的话）',
  feel.output.render({}, r1).map((x) => x.text).join('') === '记下了。', feel.output.render({}, r1))

// ---------- 三、频率闸 / 清洗 ----------
const r2 = await feel.execute({ text: '手指还停在半空' }, {})
check('12 秒内再记：跳过', r2.ok === false && r2.skipped === 'too_soon', r2)
const r3 = await feel.execute({ text: '隔了一会儿才回神' }, {})
check('跳过的那次没写进库', db.prepare('SELECT COUNT(*) n FROM affect_feel WHERE agent_id=?').get(aid).n === 1)
// 手动把上一条时间推远，验「同一句重复」这条
db.prepare('UPDATE affect_feel SET at=? WHERE agent_id=?').run(new Date(T0 - 60000).toISOString(), aid)
const r4 = recordFeel(db, aid, { text: '隔了一会儿才回神', at: T0 })
check('时间推远后能记', r4.ok === true, r4)
const r5 = recordFeel(db, aid, { text: '隔了一会儿才回神', at: T0 + 30000 })
check('三十秒后同一句重复：跳过', r5.ok === false && r5.skipped === 'same', r5)
check('空的记不了', recordFeel(db, aid, { text: '   \n  ', at: T0 + 120000 }).skipped === 'empty')
check('只有标点也记不了', recordFeel(db, aid, { text: '……', at: T0 + 130000 }).skipped === 'empty')
check('去掉首尾引号', cleanFeelText('「有点累」') === '有点累', cleanFeelText('「有点累」'))

// ---------- 三之二、写得像 AI 的退回（和感受行同一把尺） ----------
{
  const beforeN = db.prepare('SELECT COUNT(*) n FROM affect_feel WHERE agent_id=?').get(aid).n
  const ai1 = recordFeel(db, aid, { text: '心里说不上来的那种感觉', at: T0 + 200000 })
  check('带「感觉」的：退回', ai1.ok === false && ai1.skipped === 'ai-flavor' && ai1.issue === 'ai-word', ai1)
  check('退回时告诉哪句不要用', /别用「/.test(ai1.hint || ''), ai1.hint)
  const ai2 = recordFeel(db, aid, { text: '因为他夸我，所以我想笑', at: T0 + 210000 })
  check('解释原因的：退回', ai2.ok === false && ai2.skipped === 'ai-flavor' && ai2.issue === 'explains', ai2)
  const ai3 = recordFeel(db, aid, { text: '嗯', at: T0 + 220000 })
  check('太短（说不清是哪一下）：退回', ai3.ok === false && ai3.issue === 'too-short', ai3)
  const ai4 = recordFeel(db, aid, { text: '啊'.repeat(200), at: T0 + 230000 })
  check('太长：不再退回，先存着（注入时再截短）', ai4.ok === true, ai4)
  check('被退回的两条（AI 味 / 太短）没进库，太长那条进了',
    db.prepare('SELECT COUNT(*) n FROM affect_feel WHERE agent_id=?').get(aid).n === beforeN + 1)
  // 太长的那条：库里留原话，拼注入时才收短；不能因为长就整条消失
  const longLine = feelLineOf({ text: ai4.text })
  const longInjected = feelTextForInject(ai4.text)
  check('注入时截短，不会把 80 字整条塞进去', Array.from(longInjected).length <= 61 && longInjected.endsWith('…'), longInjected)
  check('注入行用的是截短后的句子', longLine.includes(longInjected) && !longLine.includes(ai4.text), longLine)
  // 有句读时从句读处断：句子读起来还是一口气，不是从字中间切断
  const longNat = '屏幕停在提交成功的最后一行，我手指还搭在键盘上没挪开，那句话「通道优先」在眼底又亮了一下，窗外已经黑了，屋里只剩风扇转的声音。'
  const natOut = feelTextForInject(longNat)
  check('有句读：在逗号处断，前文一字不改', Array.from(longNat).length > 61 && natOut.endsWith('…') && longNat.startsWith(natOut.slice(0, -1)), natOut)
  check('短句原样不动', feelTextForInject('手有点抖') === '手有点抖')
  check('句末「。」不会和数字尾巴拼成「。，」',
    !feelLineOf({ text: '她走了。', fast: 0.1, slow: 0.2 }).includes('。，'),
    feelLineOf({ text: '她走了。', fast: 0.1, slow: 0.2 }))
  // 退回不是静默的：库里留 feel.miss，查「这几轮为什么没有 feel」不用猜
  const misses = db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='feel.miss'").all(aid).map((r) => JSON.parse(r.payload))
  const missP = misses.find((m) => m.reason === 'ai-word') || {}
  check('被退回时留一条 feel.miss', misses.length >= 3 && missP.reason === 'ai-word', misses.map((m) => m.reason))
  check('miss 里带着原文，能看出改哪', String(missP.text || '').length > 0, missP)
  const okOne = recordFeel(db, aid, { text: '猛地一下没接住气', at: T0 + 242000 })
  check('写得白的话照样能记', okOne.ok === true, okOne)
  // 别挡太狠：「有点」在人话里太常见，三个字的短句也是一句话
  const okTwo = recordFeel(db, aid, { text: '手有点抖', at: T0 + 255000 })
  check('「有点」不挡（那是人话）', okTwo.ok === true, okTwo)
  const okThree = recordFeel(db, aid, { text: '手在抖', at: T0 + 275000 })
  check('三个字也收（手在抖就是一句）', okThree.ok === true, okThree)
}

// ---------- 三之三、换落点：只落库，不回执 ----------
{
  check('落点分类：话', feelAnchorOf('那句话还在耳朵里') === '话', feelAnchorOf('那句话还在耳朵里'))
  check('落点分类：物', feelAnchorOf('桌上那杯水凉了') === '物', feelAnchorOf('桌上那杯水凉了'))
  check('落点分类：什么都沾不上', feelAnchorOf('什么都没有') === 'none', feelAnchorOf('什么都没有'))
  const evBefore = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='feel.anchor.repeat'").get(aid).n
  const a1 = recordFeel(db, aid, { text: '视线钉在屏幕上', at: T0 + 300000 })
  check('第一条：视线，回执干净', a1.ok === true && Object.keys(a1).every((k) => k !== 'anchor' && k !== 'hint'), a1)
  const a2 = recordFeel(db, aid, { text: '手压着桌沿没松', at: T0 + 312000 })
  check('第二条：换成身体，从头数', a2.ok === true, a2)
  const a3 = recordFeel(db, aid, { text: '指节蹭了一下', at: T0 + 324000 })
  check('第三条：同类才两条，还没到数', a3.ok === true, a3)
  const a4 = recordFeel(db, aid, { text: '喉咙里顶着一口气', at: T0 + 336000 })
  check('连着三条同类：回执也不提（只落库）', a4.ok === true && !('hint' in a4) && !('anchor' in a4), a4)
  const evMid = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='feel.anchor.repeat'").get(aid).n
  check('同一时刻，库里留下了痕', evMid > evBefore, { evBefore, evMid })
  check('回执不提，句子照样进库',
    (db.prepare('SELECT text FROM affect_feel WHERE agent_id=? AND at=?').get(aid, new Date(T0 + 336000).toISOString()) || {}).text === '喉咙里顶着一口气')
  const a5 = recordFeel(db, aid, { text: '指节还压着', at: T0 + 348000 })
  check('第四条同类：不再重复留痕（不然 events 会被淹）', a5.ok === true, a5)
  check('连着四条只留一条痕',
    db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='feel.anchor.repeat'").get(aid).n === evMid,
    db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='feel.anchor.repeat'").get(aid).n)
  const a6 = recordFeel(db, aid, { text: '那句话还在耳朵里', at: T0 + 360000 })
  check('换到「话」：能记', a6.ok === true, a6)
  const a7 = recordFeel(db, aid, { text: '手冷', at: T0 + 372000 })
  check('两个字也收（那一刻本来就不完整）', a7.ok === true && a7.text === '手冷', a7)
  const a8 = recordFeel(db, aid, { text: '嗯', at: T0 + 384000 })
  check('一个字还是不收（说不清是哪一下）', a8.ok === false && a8.issue === 'too-short', a8)
  check('成功回执永远只有一句「记下了。」',
    feel.output.render({}, a4).map((x) => x.text).join('') === '记下了。', feel.output.render({}, a4))
}

// ---------- 四、注入 ----------
const fresh = recordFeel(db, aid, { text: '刚跑完步，心还热着', at: T0 + 400000 })
check('最新一条记得住', latestFeel(db, aid, { at: T0 + 400000 + 60000 }) !== null)
check('超窗口不冒充刚说完', latestFeel(db, aid, { at: T0 + 400000 + 9 * 3600 * 1000 }) === null, latestFeel(db, aid, { at: T0 + 400000 + 9 * 3600 * 1000 }))
const line = feelLineOf(latestFeel(db, aid, { at: T0 + 460000 }))
check('注入行带自己的原话', line.includes('刚跑完步，心还热着'), line)
check('注入行说清「这不是你说的」', line.includes('不是你说的'), line)
/* 2026-11-07 改：数字从注入行退场——快/慢是账本上的东西，不该在开口前念给我听。
   数还在库里（下面「落库」那几条照旧验），只是不再进这一行。 */
check('注入行不带快慢数字', !/[+\-−]\d+\.\d+/.test(line), line)
check('注入行不出现「快 +」/「慢 +」', !/快\s*[+\-−]|慢\s*[+\-−]/.test(line), line)
// consciousnessBlock：以「当前时间」为准，所以把这条挪到刚才
db.prepare('UPDATE affect_feel SET at=? WHERE agent_id=? AND text=?').run(new Date().toISOString(), aid, fresh.text)
const block = consciousnessBlock(db, aid)
check('提示词里有 feel 这条通路', block.includes('就调 feel 记一句'), block.slice(0, 200))
check('提示词里有自己那句话', block.includes('刚跑完步，心还热着'), block.slice(-600))
const guestBlock = consciousnessBlock(db, aid, { snap: 'off' })
check('客人会话看不到这条', !guestBlock.includes('刚跑完步，心还热着'), guestBlock.slice(-300))
// 漏调的情况：她要是两小时没记，不能拿旧的那句冒充「刚说完」
{
  const old = new Date(Date.now() - 3 * 3600 * 1000).toISOString()
  db.prepare('UPDATE affect_feel SET at=? WHERE agent_id=?').run(old, aid)
  const stale = consciousnessBlock(db, aid)
  check('三小时前的旧感觉：不再冒充满上一句', !stale.includes('刚跑完步，心还热着'), stale.slice(-200))
  db.prepare('UPDATE affect_feel SET at=? WHERE agent_id=?').run(new Date().toISOString(), aid)
}
check('moodLabelOf 还在（没被这次改动带坏）', moodLabelOf(db, aid) === 'calm', moodLabelOf(db, aid))

// ---------- 五、关掉开关 ----------
writeParam(db, aid, 'affect.feel.inject', 'off')
const offBlock = consciousnessBlock(db, aid)
check('affect.feel.inject=off：不再注入', !offBlock.includes('刚跑完步，心还热着'), offBlock.slice(-300))

w.close && w.close()

// ---------- 六、旧感觉回来：一天一条，不重复 ----------
{
  const w2 = makeWorld()
  try {
    const old = new Date(Date.now() - 20 * 86400000).toISOString()
    w2.db.prepare('INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,source) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('afe_echo_1', w2.aid, old, '认得字，认不得人。', 'irritated', 0, 0, 0, 'tool')
    const e1 = echoFeelOf(w2.db, w2.aid, { label: 'irritated' })
    check('二十天前那条能被翻回来', !!e1 && e1.text === '认得字，认不得人。', e1)
    const line = echoFeelLineOf(e1)
    check('回看那行只陈述、不下结论', line.includes('我也这样过') && !line.includes('所以'), line)
    check('同一天只翻一次', echoFeelOf(w2.db, w2.aid, { label: 'irritated' }) === null)
    check('没有标签就不翻', echoFeelOf(w2.db, w2.aid, { label: '' }) === null)
    check('标签对不上不翻', echoFeelOf(w2.db, w2.aid, { label: 'joy' }) === null)
  } finally { w2.close && w2.close() }
}

// ---------- 七、按「像不像」翻，不按标签 ----------
// label 是评上一轮对话得出的，和这一句 feel 常对不上（「胸口一松」被标成 frustrated）。
{
  const w3 = makeWorld()
  try {
    const old = new Date(Date.now() - 10 * 86400000).toISOString()
    w3.db.prepare('INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,source) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('afe_echo_2', w3.aid, old, '被问了一句，手指停在键盘边上没动，心里先沉了一下。', 'joy', 0, 0, 0, 'tool')
    const byText = echoFeelOf(w3.db, w3.aid, { text: '手指停在键盘边上，心里沉了一下', label: 'irritated' })
    check('按像不像翻，标签不对也能翻到', !!byText && byText.label === 'joy', byText)
  } finally { w3.close && w3.close() }
}

console.log('')
console.log('通过 ' + pass + ' / ' + (pass + fail))
process.exit(fail ? 1 : 0)
