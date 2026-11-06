/**
 * 说话分寸 · 模型判断（影子）测试
 *
 * 管的是：模型建议怎么被夹进规则档、坏输出/超时怎么回退、影子只落事件不进提示词。
 * 运行：node test/speech-judge.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import {
  LEVEL_ORDER, TONES, parseJudge, clampProposal, buildPrompt, judgeSpeech, recordShadow,
  parseCompare, buildComparePrompt, judgeCompare, recordCompare,
} from '../src/modules/speech_judge.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}
const rule = (level, sentences = 3, proactive = 1, tone = 'plain') => ({ level, sentences, proactive, tone })

// ================================================================ 解析：模型输出怎么读
{
  const good = parseJudge('{"level":"brief","sentences":2,"proactive":0,"tone":"cool","why":"有点累","confidence":0.7}')
  check('正常 JSON 能读', good.ok && good.verdict.level === 'brief' && good.verdict.sentences === 2, good)
  check('信心夹在 0..1', good.ok && good.verdict.confidence === 0.7, good.verdict)

  const fenced = parseJudge('```json\n{"level":"warm","sentences":4,"proactive":2,"tone":"warm"}\n```')
  check('带代码围栏也能读', fenced.ok && fenced.verdict.level === 'warm', fenced)

  const chatty = parseJudge('好的，我判断如下：{"level":"normal","sentences":3,"proactive":1,"tone":"plain"} 以上。')
  check('前后带解释也能读', chatty.ok && chatty.verdict.level === 'normal', chatty)

  check('空输出算坏', parseJudge('').ok === false && parseJudge('').reason === 'empty')
  check('不是 JSON 算坏', parseJudge('我觉得挺好的').reason === 'bad-json')
  check('档位不认识算坏', parseJudge('{"level":"angry"}').reason === 'bad-level')
  check('句数越界会被夹', parseJudge('{"level":"normal","sentences":9}').verdict.sentences === 4, parseJudge('{"level":"normal","sentences":9}').verdict)
  check('语气不认识就留空（后面回退规则档）', parseJudge('{"level":"normal","tone":"sad"}').verdict.tone === null)
  check('档位表只有四档', LEVEL_ORDER.join(',') === 'quiet,brief,normal,warm' && TONES.length === 4, LEVEL_ORDER)
}

// ================================================================ 夹边界：低落不许被抬
{
  const low = clampProposal(rule('quiet', 1, 0, 'cool'), { level: 'normal', sentences: 3, proactive: 1, tone: 'plain' })
  check('低落档：模型想多说，被夹回安静', low.level === 'quiet' && low.sentences === 1 && low.proactive === 0, low)
  check('夹了要留痕 level-up', low.clamped.includes('level-up'), low.clamped)
  check('低落档句数不会超过规则', low.sentences <= 1 && low.proactive <= 0)

  const allow = clampProposal(rule('normal'), { level: 'warm', sentences: 4, proactive: 2, tone: 'warm' })
  check('非低落：允许往上挪一档', allow.level === 'warm', allow.level)
  check('但句数不许超过规则（3）', allow.sentences === 3, allow.sentences)
  check('主动也不许超过规则（1）', allow.proactive === 1, allow.proactive)

  const noUp = clampProposal(rule('normal'), { level: 'warm' }, { allowUp: false })
  check('allowUp=false 时一律不往上抬', noUp.level === 'normal', noUp.level)

  const downTwo = clampProposal(rule('warm', 4, 2, 'warm'), { level: 'quiet', sentences: 1, proactive: 0, tone: 'cool' })
  check('往下最多挪一档：warm → normal', downTwo.level === 'normal', downTwo.level)
  check('往下夹有痕 level-2', downTwo.clamped.includes('level-2'), downTwo.clamped)
  check('往下的句数/主动照收', downTwo.sentences <= 1 && downTwo.proactive === 0, downTwo)

  const badTone = clampProposal(rule('normal', 3, 1, 'plain'), { level: 'normal', tone: 'nope' })
  check('语气不认识就回退规则档', badTone.tone === 'plain', badTone.tone)

  const same = clampProposal(rule('brief', 2, 0, 'plain'), { level: 'brief', sentences: 2, proactive: 0, tone: 'plain' })
  check('建议和规则一致时原样通过、不留夹痕', same.level === 'brief' && same.clamped.length === 0, same)
}

// ================================================================ 问模型：成功 / 超时 / 坏输出
{
  const complete = async () => '{"level":"brief","sentences":2,"proactive":0,"tone":"cool","why":"累","confidence":0.8}'
  const r = await judgeSpeech({ complete, rule: rule('normal'), label: 'tired', intensity: 0.3 })
  check('问一次就有结论', r.ok && r.verdict.level === 'brief' && r.verdict.sentences === 2, r)
  check('结论也过了夹边界', r.verdict.sentences <= 3, r.verdict)

  const noModel = await judgeSpeech({ rule: rule('normal') })
  check('没有模型就退回规则档', !noModel.ok && noModel.reason === 'no-model')

  const throws = await judgeSpeech({ complete: async () => { throw new Error('boom') }, rule: rule('normal') })
  check('模型报错不炸，标 model-error', !throws.ok && throws.reason === 'model-error', throws)

  const hangs = await judgeSpeech({ complete: () => new Promise(() => {}), rule: rule('normal'), timeoutMs: 200 })
  check('超时会断开，标 timeout', !hangs.ok && hangs.reason === 'timeout', hangs)

  const bad = await judgeSpeech({ complete: async () => '不想说', rule: rule('normal') })
  check('坏输出标 bad-json', !bad.ok && bad.reason === 'bad-json', bad)

  const text = buildPrompt({ label: 'joy', intensity: 0.8, warmth: 0.9, rule: rule('warm'), lastUser: '我回来了', lastReply: '嗯' })
  check('提示里带状态与参考档', text[1].content.includes('joy') && text[1].content.includes('参考档'), text[1].content)
  check('只输出 JSON 是写死在系统提示里的', text[0].content.includes('只输出 JSON'), text[0].content)
}

// ================================================================ 影子落账：只写事件，字段齐
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-speech-'))
  const db = openDb(path.join(dir, 'app.db'))
  const aid = 'agt_speech'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,?)')
    .run(aid, '说话分寸', 'daily', 'active', now(), 13)
  const out = recordShadow(db, aid, {
    rule: rule('brief', 2, 0, 'cool'),
    verdict: { level: 'brief', sentences: 1, proactive: 0, tone: 'cool', why: '累', confidence: 0.6, clamped: [] },
    ms: 120,
    model: 'host',
  })
  const row = db.prepare("SELECT type,payload,created_at FROM events WHERE agent_id=? AND type='expr.shadow'").get(aid)
  check('影子落一条事件', !!row && row.type === 'expr.shadow', row && row.type)
  const p = row ? JSON.parse(row.payload) : {}
  check('事件里有规则档', p.rule && p.rule.level === 'brief' && p.rule.sentences === 2, p.rule)
  check('事件里有模型建议（不是被模型名盖掉）', p.suggest && p.suggest.level === 'brief' && p.suggest.why === '累', p.suggest)
  check('事件里有模型名与耗时', p.model === 'host' && p.ms === 120, { model: p.model, ms: p.ms })
  check('没写进任何记忆/对话（影子不生效）', db.prepare('SELECT COUNT(*) n FROM memory_items WHERE agent_id=?').get(aid).n === 0
    && db.prepare('SELECT COUNT(*) n FROM chat_turns WHERE agent_id=?').get(aid).n === 0)
}

// ================================================================ 模拟：一天里几种情形，看夹得对不对
{
  const cases = [
    { name: '低落但模型想多说', rule: rule('quiet', 1, 0, 'cool'), out: '{"level":"normal","sentences":3,"proactive":1,"tone":"plain"}', want: { level: 'quiet', sentences: 1, proactive: 0 } },
    { name: '正常时模型想更收', rule: rule('normal', 3, 1), out: '{"level":"brief","sentences":2,"proactive":0,"tone":"cool"}', want: { level: 'brief', sentences: 2, proactive: 0 } },
    { name: '热乎时模型想再热', rule: rule('warm', 4, 2, 'warm'), out: '{"level":"warm","sentences":4,"proactive":2,"tone":"warm"}', want: { level: 'warm', sentences: 4, proactive: 2 } },
    { name: '模型给出乱档位', rule: rule('normal', 3, 1), out: '{"level":"angry"}', ok: false },
    { name: '模型给出空', rule: rule('normal', 3, 1), out: '', ok: false },
  ]
  for (const c of cases) {
    const r = await judgeSpeech({ complete: async () => c.out, rule: c.rule })
    if (c.ok === false) {
      check('模拟：' + c.name + ' → 回退规则档', !r.ok, r)
    } else {
      check('模拟：' + c.name, r.ok && r.verdict.level === c.want.level
        && r.verdict.sentences === c.want.sentences && r.verdict.proactive === c.want.proactive, r.verdict)
    }
  }
}

// ================================================================ 评委：两版哪版更像
{
  check('A 记成规则版', parseCompare('{"pick":"A","why":"更像","confidence":0.6}').pick === 'rule', parseCompare('{"pick":"A"}'))
  check('B 记成模型版', parseCompare('{"pick":"B"}').pick === 'model')
  check('same 就是分不出来', parseCompare('{"pick":"same"}').pick === 'same')
  check('带围栏也能读', parseCompare('```json\n{"pick":"B"}\n```').pick === 'model')
  check('乱选算坏', parseCompare('{"pick":"C"}').reason === 'bad-pick')
  check('不是 JSON 算坏', parseCompare('都差不多').reason === 'bad-json')

  const p = buildComparePrompt({ rule: rule('brief', 2, 0, 'cool'), suggest: { level: 'normal', sentences: 3, proactive: 1, tone: 'plain' }, label: 'tired', intensity: 0.3 })
  check('两版都摆在提示里', p[1].content.includes('A：') && p[1].content.includes('B：'), p[1].content)

  const cmp = await judgeCompare({ complete: async () => '{"pick":"A","why":"更收","confidence":0.7}', rule: rule('brief', 2, 0, 'cool'), suggest: { level: 'normal' } })
  check('问一次就有选择', cmp.ok && cmp.pick === 'rule' && cmp.why === '更收', cmp)

  const no = await judgeCompare({ rule: rule('normal') })
  check('没模型就不评', !no.ok && no.reason === 'no-model')

  const hang = await judgeCompare({ complete: () => new Promise(() => {}), timeoutMs: 200, rule: rule('normal') })
  check('评委超时会断开', !hang.ok && hang.reason === 'timeout', hang)

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-compare-'))
  const db2 = openDb(path.join(dir2, 'app.db'))
  const aid2 = 'agt_compare'
  db2.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,?)')
    .run(aid2, '评委', 'daily', 'active', now(), 13)
  recordCompare(db2, aid2, { rule: rule('brief', 2, 0, 'cool'), suggest: { level: 'normal', sentences: 3 }, pick: 'rule', why: '更收', confidence: 0.7, ms: 90 })
  const jr = db2.prepare("SELECT payload FROM events WHERE agent_id=? AND type='expr.judge'").get(aid2)
  const jp = jr ? JSON.parse(jr.payload) : {}
  check('评委结论落一条事件', !!jr && jp.pick === 'rule', jp)
  check('事件里两版都在', jp.rule && jp.suggest && jp.rule.level === 'brief' && jp.suggest.level === 'normal', jp)
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
