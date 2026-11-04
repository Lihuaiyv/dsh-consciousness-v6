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
import { recordFeel, latestFeel, feelLineOf, cleanFeelText } from '../src/modules/feel.js'
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
check('描述里说清「不写数字、不进正文」', /不写数字/.test(feel.description) && /不会出现在对用户说的话里/.test(feel.description))

// ---------- 二、落库 ----------
const before = db.prepare('SELECT slow, fast, total FROM affect_v3 WHERE agent_id=?').get(aid)
const r1 = await feel.execute({ text: '有点想再问一句，\n又怕显得急' }, { agent: { id: 'sess_qq_owner' } })
check('记下了', r1.ok === true, r1)
check('换行被折成一行', r1.text === '有点想再问一句， 又怕显得急', r1.text)
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
const r2 = await feel.execute({ text: '又一句' }, {})
check('12 秒内再记：跳过', r2.ok === false && r2.skipped === 'too_soon', r2)
const r3 = await feel.execute({ text: '隔了一会儿的感觉' }, {})
check('跳过的那次没写进库', db.prepare('SELECT COUNT(*) n FROM affect_feel WHERE agent_id=?').get(aid).n === 1)
// 手动把上一条时间推远，验「同一句重复」这条
db.prepare('UPDATE affect_feel SET at=? WHERE agent_id=?').run(new Date(T0 - 60000).toISOString(), aid)
const r4 = recordFeel(db, aid, { text: '隔了一会儿的感觉', at: T0 })
check('时间推远后能记', r4.ok === true, r4)
const r5 = recordFeel(db, aid, { text: '隔了一会儿的感觉', at: T0 + 30000 })
check('三十秒后同一句重复：跳过', r5.ok === false && r5.skipped === 'same', r5)
check('空的记不了', recordFeel(db, aid, { text: '   \n  ', at: T0 + 120000 }).skipped === 'empty')
check('只有标点也记不了', recordFeel(db, aid, { text: '……', at: T0 + 130000 }).skipped === 'empty')
check('去掉首尾引号', cleanFeelText('「有点累」') === '有点累', cleanFeelText('「有点累」'))
const long = recordFeel(db, aid, { text: '啊'.repeat(200), at: T0 + 200000 })
check('太长掐到 80 字 + 省略号', long.ok && long.text.length === 81 && long.text.endsWith('…'), { len: long.text.length })

// ---------- 四、注入 ----------
const fresh = recordFeel(db, aid, { text: '这会儿有点像刚跑完步，心还热着', at: T0 + 400000 })
check('最新一条记得住', latestFeel(db, aid, { at: T0 + 400000 + 60000 }) !== null)
check('超窗口不冒充刚说完', latestFeel(db, aid, { at: T0 + 400000 + 9 * 3600 * 1000 }) === null, latestFeel(db, aid, { at: T0 + 400000 + 9 * 3600 * 1000 }))
const line = feelLineOf(latestFeel(db, aid, { at: T0 + 460000 }))
check('注入行带自己的原话', line.includes('这会儿有点像刚跑完步'), line)
check('注入行带当时的数', /快 [+-]?\d/.test(line), line)
check('注入行说清「这不是你说的」', line.includes('不是你说的'), line)
// consciousnessBlock：以「当前时间」为准，所以把这条挪到刚才
db.prepare('UPDATE affect_feel SET at=? WHERE agent_id=? AND text=?').run(new Date().toISOString(), aid, fresh.text)
const block = consciousnessBlock(db, aid)
check('提示词里有 feel 这条通路', block.includes('先用 feel 记一句'), block.slice(0, 200))
check('提示词里有自己那句话', block.includes('这会儿有点像刚跑完步'), block.slice(-600))
const guestBlock = consciousnessBlock(db, aid, { snap: 'off' })
check('客人会话看不到这条', !guestBlock.includes('这会儿有点像刚跑完步'), guestBlock.slice(-300))
// 漏调的情况：她要是两小时没记，不能拿旧的那句冒充「刚说完」
{
  const old = new Date(Date.now() - 3 * 3600 * 1000).toISOString()
  db.prepare('UPDATE affect_feel SET at=? WHERE agent_id=?').run(old, aid)
  const stale = consciousnessBlock(db, aid)
  check('三小时前的旧感觉：不再冒充满上一句', !stale.includes('这会儿有点像刚跑完步'), stale.slice(-200))
  db.prepare('UPDATE affect_feel SET at=? WHERE agent_id=?').run(new Date().toISOString(), aid)
}
check('moodLabelOf 还在（没被这次改动带坏）', moodLabelOf(db, aid) === 'calm', moodLabelOf(db, aid))

// ---------- 五、关掉开关 ----------
writeParam(db, aid, 'affect.feel.inject', 'off')
const offBlock = consciousnessBlock(db, aid)
check('affect.feel.inject=off：不再注入', !offBlock.includes('这会儿有点像刚跑完步'), offBlock.slice(-300))

w.close && w.close()
console.log('')
console.log('通过 ' + pass + ' / ' + (pass + fail))
process.exit(fail ? 1 : 0)
