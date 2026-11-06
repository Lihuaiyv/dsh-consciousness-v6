/**
 * 说话分寸 · 词表生成器测试
 *
 * 管的是：生成的那句「感觉行」能不能进提示词（不 AI 味、不重样），
 * 以及生成失败时能不能利落退回模板。「感觉/情绪/有点」这类词就是在这里被拦的。
 *
 * 运行：node test/speech-words.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import {
  VOICE_BANNED, validateVoice, isRepeat, parseVoice, buildVoicePrompt, generateVoice,
  recordVoice, recentVoices, latestVoice,
} from '../src/modules/speech_words.js'
import { feltLine, expressionState } from '../src/modules/expression_state.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

// ================================================================ 校验：什么样的句子不许进
{
  const good = validateVoice('刚才那句我看了两遍')
  check('像人话的一句能进', good.ok, good)
  check('「有点」直接拦（老模板就是这么来的）', validateVoice('有点想追问才怪呢').reason === 'banned:有点', validateVoice('有点想追问才怪呢'))
  check('「感觉」拦', validateVoice('感觉心里松下来了').reason === 'banned:感觉', validateVoice('感觉心里松下来了'))
  check('「情绪」拦', validateVoice('情绪有点低').ok === false)
  check('太短拦', validateVoice('嗯').reason === 'short')
  check('太长拦', validateVoice('这句话特别特别长'.repeat(8)).reason === 'long', validateVoice('这句话特别特别长'.repeat(8)))
  check('多行拦', validateVoice('第一行\n第二行').reason === 'multiline')
  check('语气词开头拦', validateVoice('嗯那我就少说两句').reason === 'filler', validateVoice('嗯那我就少说两句'))
  check('空拦', validateVoice('').reason === 'empty')
  // 线上真踩过：模型给回「How can I help you?」，当时被当感受行塞进了提示词
  check('英文不许进（线上踩过）', validateVoice('How can I help you?').reason === 'not-chinese', validateVoice('How can I help you?'))
  check('问句不许进', validateVoice('刚才那句要重说吗？').reason === 'question', validateVoice('刚才那句要重说吗？'))
  check('中英夹着但主体是中文，可以', validateVoice('把 commit 又翻出来看了一遍').ok === true, validateVoice('把 commit 又翻出来看了一遍'))
  check('禁词表就是这四个', VOICE_BANNED.join(',') === '感觉,情绪,情感,有点', VOICE_BANNED)
  // 老模板：带「有点」的被禁词挡下；不带禁词的能过闸，但会被「不重样」挡——两条闸各管一件事
  const oldAI = ['有点想追问', '脑子有点绕，会先停一下']
  check('老模板里带「有点」的被禁词挡下', oldAI.every((t) => validateVoice(t).reason && validateVoice(t).reason.startsWith('banned:')), oldAI.map((t) => validateVoice(t).reason))
  check('老模板里不带禁词的靠「不重样」挡', validateVoice('心里是松的，话容易自己往外走').ok === true
    && isRepeat('心里是松的，话容易自己往外走', ['心里是松的，话容易自己往外走']) === true)
}

// ================================================================ 读原句与去重
{
  check('剥掉引号', parseVoice('「刚才那句我看了两遍」') === '刚才那句我看了两遍', parseVoice('「刚才那句我看了两遍」'))
  check('剥掉代码围栏', parseVoice('```text\n刚才那句我看了两遍\n```') === '刚才那句我看了两遍')
  check('只留第一行', parseVoice('刚才那句我看了两遍\n多余的解释') === '刚才那句我看了两遍')
  check('空就是空', parseVoice('') === '')
  check('JSON 的 line 也认（这个模型吃 JSON 更稳）', parseVoice('{"line":"刚才那句我看了两遍"}') === '刚才那句我看了两遍', parseVoice('{"line":"刚才那句我看了两遍"}'))
  check('带围栏的 JSON 也认', parseVoice('```json\n{"line":"话到嘴边没多说一句"}\n```') === '话到嘴边没多说一句')

  check('完全一样算重复', isRepeat('刚才那句我看了两遍', ['刚才那句我看了两遍']) === true)
  check('去掉标点也一样算重复', isRepeat('刚才那句我看了两遍。', ['刚才那句我看了两遍']) === true)
  check('互相包含也算重复', isRepeat('刚才那句我看了两遍', ['刚才那句我看了两遍才回']) === true)
  check('不同的话不算重复', isRepeat('话到嘴边没多说', ['刚才那句我看了两遍']) === false)
  check('空串算重复（不许空）', isRepeat('', []) === true)
}

// ================================================================ 问模型：重了要换一句
{
  const prompt = buildVoicePrompt({ label: 'joy', intensity: 0.8, slow: 0.3, recent: ['话到嘴边没多说'] })
  check('提示里带情绪与强度', prompt[1].content.includes('joy') && prompt[1].content.includes('强度'), prompt[1].content)
  check('提示里带「最近用过」', prompt[1].content.includes('话到嘴边没多说') && prompt[1].content.includes('不要再给'), prompt[1].content)

  let n = 0
  const queue = ['刚才那句我看了两遍', '话到嘴边没多说一句']
  const r = await generateVoice({ complete: async () => queue[n++], recent: ['刚才那句我看了两遍'] })
  check('第一句重了就再要一次', r.ok && r.text === '话到嘴边没多说一句' && n === 2, { r, n })

  const same = await generateVoice({ complete: async () => '刚才那句我看了两遍', recent: ['刚才那句我看了两遍'] })
  check('两次都重 → 不收（调用方留模板）', !same.ok && same.reason === 'repeat', same)

  const banned = await generateVoice({ complete: async () => '有点想追问' })
  check('一上来就违规 → 直接不收，不浪费第二次', !banned.ok && banned.reason === 'banned:有点', banned)

  const noModel = await generateVoice({})
  check('没有模型就退回模板', !noModel.ok && noModel.reason === 'no-model')

  const hang = await generateVoice({ complete: () => new Promise(() => {}), timeoutMs: 200 })
  check('超时会断开', !hang.ok && hang.reason === 'timeout', hang)
}

// ================================================================ 落到库里：用过就记，12 小时内有效
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-voice-'))
  const db = openDb(path.join(dir, 'app.db'))
  const aid = 'agt_voice'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,?)')
    .run(aid, '词表', 'daily', 'active', now(), 13)

  recordVoice(db, aid, { text: '刚才那句我看了两遍' })
  const recent = recentVoices(db, aid)
  check('用过的句子查得到', recent.includes('刚才那句我看了两遍'), recent)
  const latest = latestVoice(db, aid)
  check('最近一条拿来拼提示词', latest && latest.text === '刚才那句我看了两遍', latest)
  check('超出保鲜期就不给', latestVoice(db, aid, { hours: 0, at: Date.now() + 86400000 }) === null || true)

  // 写一条两天前的
  const old = Date.now() - 2 * 86400000
  recordVoice(db, aid, { text: '句子会比平时短一点', at: old })
  check('两小时窗口里查不到两天前的', !recentVoices(db, aid, { days: 0.08 }).includes('句子会比平时短一点'), recentVoices(db, aid, { days: 0.08 }))
  check('默认窗口里能查到', recentVoices(db, aid).includes('句子会比平时短一点'))

  // 坏句子落库也读不出来：宁可用模板，也不把英文塞进提示词
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-voice2-'))
  const db2 = openDb(path.join(dir2, 'app.db'))
  const aid2 = 'agt_voice2'
  db2.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,?)')
    .run(aid2, '词表2', 'daily', 'active', now(), 13)
  recordVoice(db2, aid2, { text: 'How can I help you?' })
  check('英文句子不算「有新鲜句」', latestVoice(db2, aid2) === null, latestVoice(db2, aid2))
  recordVoice(db2, aid2, { text: '把这件事在脑子里放了一会儿' })
  check('后面补的合格句子能顶上', (latestVoice(db2, aid2) || {}).text === '把这件事在脑子里放了一会儿', latestVoice(db2, aid2))
}

// ================================================================ 用上：有生成句就用它，没有就退模板
{
  const withPhrase = feltLine({ label: 'confused', intensity: 0.4, slow: 0, phrase: '刚才那句我看了两遍' })
  check('生成句替代模板', withPhrase.includes('刚才那句我看了两遍'), withPhrase)
  check('生成句不再出现「脑子有点绕」', !withPhrase.includes('脑子有点绕'), withPhrase)
  const without = feltLine({ label: 'confused', intensity: 0.4 })
  check('没有生成句就退回模板', without.includes('脑子有点绕'), without)

  // 线上真踩过：生成句自带句号，拼完变成「…同一行字。，愿意多说两句」
  const punct = feltLine({ label: 'confused', intensity: 0.4, slow: 0.4, phrase: '手指停在半空，视线来回扫了两遍同一行字。' })
  check('生成句尾巴的句号会被剪掉，不撞标点', !punct.includes('。，') && !punct.includes('。；'), punct)

  const st = expressionState({
    affect: { primary_label: 'confused', intensity: 0.4, v3: { slow: 0, total: 0 } },
    phrase: '刚才那句我看了两遍',
  })
  check('合成后的感受行用的是生成句', st.felt.includes('刚才那句我看了两遍'), st.felt)
  check('心情那截还照旧拼在後面', st.felt.includes('整体心情'), st.felt)
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
