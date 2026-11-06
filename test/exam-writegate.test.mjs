/**
 * 门卫零件 · 考卷
 *
 * 管的是「一条她自己说的话，值不值得记住、记了要不要落冷层」：
 * 分三档（留 / 冷放 / 丢）→ 打分 → 判决（留 / 丢 / 落冷）→ 落库。
 * 不管「这句话是不是真的」（事实核对）、不管「温度怎么衰减」（冷暖）。
 *
 * 运行：node test/exam-writegate.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import {
  sourceBadge, narrationOnly, selfTextWhy, selfTextOk, classifySelf, scoreSelf, gateSelfText,
} from '../src/modules/memory_source.js'
import { writeExtractedItem } from '../src/features.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}
const near = (a, b, eps = 1e-9) => Math.abs(Number(a) - Number(b)) <= eps

// ================================================================ 旁白：主语不是她自己
{
  check('「用户正在…」是旁白', narrationOnly('用户正在推进需求') === true)
  check('「对方的偏好是…」是旁白', narrationOnly('对方的偏好是安静') === true)
  check('「对话中没有提到」是旁白', narrationOnly('对话中没有提到这件事') === true)
  check('她说自己，不是旁白', narrationOnly('我今天有点难过') === false)
  check('只写「用户」两个字不算旁白（还看不出是不是转述）', narrationOnly('用户') === false)
  check('空串不是旁白', narrationOnly('') === false)
  check('不认「我」开头的转述', narrationOnly('我觉得用户可能想多了') === false)
}

// ================================================================ 为什么被拦：分得清才好改
{
  check('太短：len', selfTextWhy('我在') === 'len')
  check('旁白：narration', selfTextWhy('用户正在推进需求') === 'narration')
  check('开头不像自己：head', selfTextWhy('这件事我想了很久才说') === 'head')
  check('以时间词开头、通篇没我：no_me', selfTextWhy('今天天气很好，出门走了走') === 'no_me')
  check('正常的一句：ok', selfTextOk('我想明白了，以后不把话说满'))
  /* 噪音要排在 head 前面判：开头就是转写标记 / 代码块 / 报错的，先记成 noise，
     不然「为什么被拦」会显示 head，看的人改错地方（2026-11-05 夜修）。 */
  check('开头就是转写：noise', selfTextWhy('User: 你好') === 'noise')
  check('开头就是代码块：noise', selfTextWhy('{"a":1}') === 'noise')
  check('开头就是报错：noise', selfTextWhy('出错了 Error: boom') === 'noise')
  check('正文里带报错：noise', selfTextWhy('我这边出错了，failed 三次') === 'noise')
  check('正文里带堆栈：noise', selfTextWhy('我这边出错了 Error: boom') === 'noise')
}

// ================================================================ 三档：留 / 冷放 / 丢
{
  check('空 → 丢', classifySelf('').tier === 'drop' && classifySelf('').why === 'empty')
  check('太短 → 丢', classifySelf('我在').tier === 'drop' && classifySelf('我在').why === 'short')
  check('转写残留 → 丢，不进冷层', classifySelf('User: 你好').tier === 'drop' && !classifySelf('User: 你好').cold)
  const narr = classifySelf('用户正在推进需求')
  check('旁白 → 丢，但落冷层（真事实，不丢内容）', narr.tier === 'drop' && narr.cold === true && narr.why === 'narration', narr)
  const ok = classifySelf('我今天觉得有点难过，想起你上次说的话')
  check('带「我」的 → 留', ok.tier === 'ok', ok)
  const unsure = classifySelf('这是一件很重要的事，需要认真处理')
  check('通篇没「我」又不像垃圾 → 拿不准', unsure.tier === 'unsure', unsure)

  const long = '我' + '想'.repeat(260)
  const clsLong = classifySelf(long)
  check('超长截到 200 再判，不整条丢', clsLong.tier === 'ok' && clsLong.text.length === 200, { tier: clsLong.tier, len: clsLong.text && clsLong.text.length })
}

// ================================================================ 打分：什么更值得记
{
  check('平铺直叙：底分 0.4', scoreSelf('今天在楼下买了点东西') === 0.4, scoreSelf('今天在楼下买了点东西'))
  const up = scoreSelf('我想明白了，以后不再把话说满')
  check('想明白 + 承诺 → 加分', up >= 0.7, up)
  const down = scoreSelf('跑了测试，提交了 commit，改了接口')
  check('跑测试 / 提交 / 接口 → 减分', down <= 0.2, down)
  check('分值夹在 0..1', scoreSelf('想明白了然后跑测试提交接口页面配置') >= 0 &&
    scoreSelf('想明白了然后跑测试提交接口页面配置') <= 1)
  check('同一句：有分量比流水账高', up > down, { up, down })
}

// ================================================================ 判决：留 / 丢 / 落冷
{
  const g1 = gateSelfText({ cls: { tier: 'ok' }, ruleScore: 0.7 })
  check('过得去就留，分量照算', g1.keep === true && near(g1.score, 0.7), g1)

  const g2 = gateSelfText({ cls: { tier: 'drop', why: 'narration', cold: true }, ruleScore: 0.4 })
  check('旁白：不丢内容，落冷层', g2.keep === false && g2.cold === true && g2.why === 'narration', g2)

  const g3 = gateSelfText({ cls: { tier: 'drop', why: 'noise' }, ruleScore: 0.4 })
  check('噪音：直接丢，不占冷层', g3.keep === false && !g3.cold, g3)

  const g4 = gateSelfText({ cls: { tier: 'unsure', why: 'no_me' }, ruleScore: 0.4, modelHay: { keep: true } })
  check('拿不准 + 模型说留 → 留', g4.keep === true, g4)

  const g5 = gateSelfText({ cls: { tier: 'unsure', why: 'no_me' }, ruleScore: 0.4, modelHay: { keep: false } })
  check('拿不准 + 模型说丢 → 落冷层，不真删', g5.keep === false && g5.cold === true && g5.why === 'model', g5)

  const g6 = gateSelfText({ cls: { tier: 'unsure', why: 'no_me' }, ruleScore: 0.4 })
  check('拿不准又等不到判词 → 落冷层', g6.keep === false && g6.cold === true, g6)

  const mixed = gateSelfText({ cls: { tier: 'ok' }, ruleScore: 0.5, modelHay: { keep: true, score: 0.9 } })
  check('模型补分：六成规则、四成模型', near(mixed.score, 0.5 * 0.6 + 0.9 * 0.4), mixed.score)
  check('分量下限 0.05', gateSelfText({ cls: { tier: 'drop', why: 'noise' }, ruleScore: 0 }).score === 0.05)
  check('分量上限 0.95', gateSelfText({ cls: { tier: 'ok' }, ruleScore: 1, modelHay: { score: 1 } }).score === 0.95)

  const low = gateSelfText({ cls: { tier: 'ok' }, ruleScore: 0.2, admission: 'score', minScore: 0.35 })
  check('按分量选人：低分落冷，不占热层', low.keep === false && low.cold === true && low.why === 'low_score', low)
  const high = gateSelfText({ cls: { tier: 'ok' }, ruleScore: 0.8, admission: 'score', minScore: 0.35 })
  check('按分量选人：高照留', high.keep === true, high)
  const timeMode = gateSelfText({ cls: { tier: 'ok' }, ruleScore: 0.2, admission: 'time' })
  check('按时间选人：低分也留（不按分量卡）', timeMode.keep === true, timeMode)
}

// ================================================================ 来源徽章：看得出这句话从哪来
{
  check('抽取有徽章', sourceBadge('extract').label === '抽取')
  check('手记/记得都算手记', sourceBadge('remember').label === '手记' && sourceBadge('ui').label === '手记')
  check('不认识的来源原样截短显示', sourceBadge('wecom-push').label === 'wecom-pu', sourceBadge('wecom-push'))
  check('空来源按手记算', sourceBadge('').label === '手记')
}

// ================================================================ 落到库上：热的进热层、旁白进冷层、噪音不写
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-exam-wgate-'))
  const db = openDb(path.join(dir, 'app.db'))
  const aid = 'agt_exam_wgate'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,?)')
    .run(aid, '考卷写入闸', 'daily', 'active', now(), 13)
  const rowOf = (id) => db.prepare('SELECT id,text,source,temp_state,importance FROM memory_items WHERE id=?').get(id)

  const good = writeExtractedItem(db, aid, { who: 'self', text: '我想明白了，以后不把每句都答得那么满', type: 'episode' })
  const goodRow = rowOf(good.id)
  check('过得去的话真的落库了', good.id && goodRow && goodRow.source === 'self', { good, goodRow })
  check('落热层（不是冷）', !goodRow || goodRow.temp_state !== 'cold', goodRow && goodRow.temp_state)

  const narr = writeExtractedItem(db, aid, { who: 'self', text: '用户正在推进一个新的需求' })
  const narrRow = rowOf(narr.id)
  check('旁白：落冷层，内容还在', narr.action === 'drop' && narr.cold === true && narrRow && narrRow.temp_state === 'cold', { narr, narrRow })
  const coldEv = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='memory.self_cold'").get(aid).n
  check('旁白落冷要留痕（memory.self_cold）', Number(coldEv) >= 1, coldEv)

  const noise = writeExtractedItem(db, aid, { who: 'self', text: 'User: 你好' })
  check('噪音：丢掉，不写库', noise.action === 'drop' && !noise.id, noise)

  const unsure = writeExtractedItem(db, aid, { who: 'self', text: '这是一件很重要的事，需要认真处理' })
  const unsureRow = rowOf(unsure.id)
  check('拿不准又没判词：落冷层，可回查', unsure.cold === true && unsureRow && unsureRow.temp_state === 'cold', { unsure, unsureRow })

  const dup = writeExtractedItem(db, aid, { who: 'self', text: '我想明白了，以后不把每句都答得那么满', type: 'episode' })
  // 真相：自述车道没带 fact_key / turn_id，addMemory 认不出「同一句」，会多落一条。
  // 这是已知坑（说明页里写了），考卷照现实考：不许假装它去重。
  check('同一句再来一次：现在不去重，会多一条', dup.action === 'new' && dup.id && dup.id !== good.id, { dup, good: good.id })

  db.prepare("INSERT OR REPLACE INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)")
    .run(aid, 'memory.write.self', JSON.stringify('off'), now())
  const off = writeExtractedItem(db, aid, { who: 'self', text: '我想明白了，以后不把每句都答得那么满' })
  check('关掉自述写入就一条都不收', off.action === 'drop' && off.reason === 'self_off', off)
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
