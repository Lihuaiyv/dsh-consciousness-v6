/**
 * 日记 v3：材料里带上「那一刻」（feel + 情绪尖峰），以及「不写明天」的质检。
 * 运行：node test/diary-moments.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now, localDay } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { collectMoments, attachMoments, writePrompt, checkDiary, buildDiaryV2 } from '../src/modules/diary.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-diarymoments-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const AID = 'agt_test'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(AID, '小汐', 'daily', 'active', now())

const today = localDay()
const yday = new Date(Date.now() - 86400000).toISOString()
const feelIns = db.prepare('INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,session_id,source) VALUES(?,?,?,?,?,?,?,?,?,?)')
feelIns.run('f1', AID, now(), '心里有点硌，像自己顺手盖掉了什么。', 'lost', 0.1, 0.2, 0.3, null, 'test')
feelIns.run('f2', AID, now(), '被这么问，我有点想认真答。', 'curious', 0.1, 0.1, 0.1, null, 'test')
feelIns.run('f3', AID, yday, '昨天的事。', 'calm', 0, 0, 0, null, 'test')

const epIns = db.prepare('INSERT INTO affect_episodes(id,agent_id,cause,label,intensity,started_at) VALUES(?,?,?,?,?,?)')
epIns.run('e1', AID, '怎么松的，你还挺听话', 'joy', 0.72, now())
epIns.run('e2', AID, '怎么松的，你还挺听话', 'confused', 0.71, now())
epIns.run('e3', AID, '今天吃什么', 'calm', 0.3, now())
epIns.run('e4', AID, '昨天重的那句', 'lost', 0.9, yday)

const m = collectMoments(db, AID, today)
check('moments：当天 feel 都在', m.feels.length === 2, m.feels)
check('moments：前一天的 feel 不进', !m.feels.some((f) => f.text.includes('昨天')), m.feels)
check('moments：同一句话判了两次只留一条', m.beats.length === 1, m.beats)
check('moments：不够重的 beat 不进', m.beats.every((b) => b.text !== '今天吃什么'), m.beats)
check('moments：前一天的 beat 不进', m.beats.every((b) => b.text !== '昨天重的那句'), m.beats)

const attached = attachMoments([
  { id: 's1', start_at: now(), end_at: now() },
  { id: 's2', start_at: '2026-09-01T00:00:00.000Z', end_at: '2026-09-01T00:10:00.000Z' },
], m)
check('挂载：时间对得上的那一段带上心里话', attached[0].moments.length === 3, attached[0].moments)
check('挂载：时间对不上的一段不带', attached[1].moments.length === 0, attached[1].moments)

const sceneSample = [{
  when: '09:15',
  gist: '你把那句话说出来的时候',
  moments: [{ at: '09:15', text: '我先是没接住。' }],
  lines: [
    { who: '主人', text: '那句「删了得了吧」，你说完就没再看我。' },
    { who: '我', text: '我把它删了，没争。' },
  ],
}]
const p = writePrompt({
  name: '小汐', day: today, date: '2026年11月5日 周四', other: '主人',
  tone: '话少、克制', mood: '失落，强度 0.90', mood_source: 'day', moments: m, scenes: sceneSample,
})
check('提示词：说明材料里带着「当时你心里记下的」', p.system.includes('当时你心里记下的'), p.system.slice(0, 140))
check('提示词：不把写法列成步骤', !p.system.includes('怎么起的头') && !p.system.includes('后来怎么收的'), p.system.slice(0, 320))
check('提示词：短到不像一张表', p.system.split('\n').filter(Boolean).length <= 8, p.system)
check('材料：是能读的记录，不是一段 JSON', !/^\s*\{/.test(p.user) && p.user.includes('主人：'), p.user.slice(0, 160))
check('材料：段落带时间', p.user.includes('【09:15】'), p.user.slice(0, 200))
check('材料：这一段里挂着当时的心里话', p.user.includes('我心里记下'), p.user.slice(0, 320))
check('材料：没归段的那几刻仍列出来', p.user.includes('没归到上面哪一段'), p.user.slice(-200))
check('材料：不再是 1./2./3. 编号条款', !/^[1-8]\. /m.test(p.system), p.system)

const longBody = '夜里写下来的时候，手指又停在键盘上。'.repeat(10)
const onePara = `2026-11-05 周四\n\n${longBody}`
check('质检：一段也可以', checkDiary(onePara, {}).ok, checkDiary(onePara, {}))
const future = `2026-11-05 周四\n\n${'明早还得去看那条提醒，接下来还有两处要补，明晚再说。'.repeat(8)}`
check('质检：结尾写明天也不拦（不靠形状判真假）', checkDiary(future, {}).ok, checkDiary(future, {}))

// 集成：真跑一遍成文，看喂给模型的 user 里有没有 moments
db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,start_at,end_at,turns,title,summary,importance,created_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
  .run('ep_a', AID, 'sess_a', today, now(), now(), 6, '你把那句话说出来的时候', '你把那句话说出来的时候，我先是没接住。', 0.7, now())
db.prepare(`INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,tool,meta,created_at,day)
  VALUES(?,?,?,?,?,?,?,NULL,NULL,?,?)`)
  .run('raw_a1', AID, 'sess_a', null, 1, 'user', '那句「删了得了吧」，你说完就没再看我。', now(), today)
db.prepare(`INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,tool,meta,created_at,day)
  VALUES(?,?,?,?,?,?,?,NULL,NULL,?,?)`)
  .run('raw_a2', AID, 'sess_a', null, 2, 'assistant', '我把它删了，没争。', now(), today)

let seen = null
const GOOD = `2026-11-05 周四\n\n${'我盯着那行字看了很久，手指停在键盘上没往下动。'.repeat(6)}\n\n${'那是我给醒来画的一个点，删了就删了。'.repeat(6)}`
const out = await buildDiaryV2(db, AID, today, {
  chat: async (messages, o = {}) => {
    if (o.json) return JSON.stringify({ like: 8, why: '是自己在写' })
    seen = messages
    return GOOD
  },
})
const seenUser = seen && String(seen[1].content || '')
check('集成：喂给模型的是对话记录', seenUser.includes('我：') && !seenUser.trim().startsWith('{'), seenUser.slice(0, 200))
check('集成：记录里带着那段时间的心里话', seenUser.includes('我心里记下'), seenUser.slice(0, 400))
check('集成：成文成功', !!out && out.source === 'model', out && { pending: out.pending, fail: out.fail_reason })
check('集成：写进 context 的 moments 计数', !!(out && out.context && JSON.parse(out.context).write.moments), out && out.context)

// P2：成文后再判一次「像日记还是像记录」
const asLog = `2026-11-05 周四\n\n${'今天先跑了测试，又把日志补了一遍，最后把页面也打开看了一次。'.repeat(5)}`
const asDiary = `2026-11-05 周四\n\n${'我盯着那行字看了很久，手指停在键盘上，忽然不知道自己是在等一句什么。'.repeat(5)}`

let writeCalls = 0
const out2 = await buildDiaryV2(db, AID, today, {
  force: true,
  chat: async (messages, o = {}) => {
    if (o.json) return JSON.stringify({ like: 2, why: '在报流水' })
    writeCalls++
    return writeCalls === 1 ? asLog : asDiary
  },
})
check('判定：像记录的会被退回去重写', writeCalls === 2, writeCalls)
check('判定：留下的是重写那一版', !!(out2 && out2.text.includes('手指停在键盘上')), out2 && String(out2.text).slice(0, 60))
check('判定：判定结果进 context', !!(out2 && out2.context && JSON.parse(out2.context).write.judge), out2 && out2.context)

let writeCalls2 = 0
const out3 = await buildDiaryV2(db, AID, today, {
  force: true,
  chat: async (messages, o = {}) => {
    if (o.json) return JSON.stringify({ like: 9, why: '是自己在写' })
    writeCalls2++
    return asDiary
  },
})
check('判定：够像就一次过', writeCalls2 === 1 && !!(out3 && out3.source === 'model'), writeCalls2)

let writeCalls3 = 0
const out4 = await buildDiaryV2(db, AID, today, {
  force: true,
  chat: async (messages, o = {}) => {
    if (o.json) throw new Error('judge down')
    writeCalls3++
    return asDiary
  },
})
check('判定：判定挂了也不挡成文', writeCalls3 === 1 && !!(out4 && out4.source === 'model'), { writeCalls3, src: out4 && out4.source })

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
