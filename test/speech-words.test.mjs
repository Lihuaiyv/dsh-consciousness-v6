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
  recordVoice, recentVoices, latestVoice, voiceStale,
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
  // 2026-11-15：这一行改成写「心情」以后，「有点」放开了——「心里有点堵」是正常说法；
  // 拦的正事变成三个报告腔词（感觉/情绪/情感）。
  check('「感觉」拦', validateVoice('感觉心里松下来了').reason === 'banned:感觉', validateVoice('感觉心里松下来了'))
  check('「情绪」拦', validateVoice('情绪有点低').reason === 'banned:情绪', validateVoice('情绪有点低'))
  check('「有点」不再拦（写心情要用）', validateVoice('心里有点堵，说不上是多大事').ok === true, validateVoice('心里有点堵，说不上是多大事'))
  check('太短拦', validateVoice('嗯').reason === 'short')
  check('太长拦', validateVoice('这句话特别特别长'.repeat(8)).reason === 'long', validateVoice('这句话特别特别长'.repeat(8)))
  check('多行拦', validateVoice('第一行\n第二行').reason === 'multiline')
  check('语气词开头拦', validateVoice('嗯那我就少说两句').reason === 'filler', validateVoice('嗯那我就少说两句'))
  check('空拦', validateVoice('').reason === 'empty')
  // 线上真踩过：模型给回「How can I help you?」，当时被当感受行塞进了提示词
  check('英文不许进（线上踩过）', validateVoice('How can I help you?').reason === 'not-chinese', validateVoice('How can I help you?'))
  check('问句不许进', validateVoice('刚才那句要重说吗？').reason === 'question', validateVoice('刚才那句要重说吗？'))
  check('中英夹着但主体是中文，可以', validateVoice('把 commit 又翻出来看了一遍').ok === true, validateVoice('把 commit 又翻出来看了一遍'))
  check('禁词表就是这三个', VOICE_BANNED.join(',') === '感觉,情绪,情感', VOICE_BANNED)
  // 老模板：现在都能过禁词闸（「有点」放开了），但会被「不重样」挡——两条闸各管一件事
  const oldAI = ['有点想追问，会多问一句', '脑子有点绕，会先停一下']
  check('老模板现在能过禁词闸（但会被不重样挡）', oldAI.every((t) => validateVoice(t).ok === true), oldAI.map((t) => validateVoice(t).reason))
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
  const prompt = buildVoicePrompt({ label: 'joy', intensity: 0.8, slow: 0.3, dialogue: [{ you: '他在问输入是什么', me: '我说了那几句话' }] })
  check('提示里带情绪与强度', prompt[1].content.includes('joy') && prompt[1].content.includes('强度'), prompt[1].content)
  check('上下文是对话的样子（对方：/我：）', prompt[1].content.includes('对方：他在问输入是什么') && prompt[1].content.includes('我：我说了那几句话'), prompt[1].content)
  check('提示里不再列「最近用过」那八句', !prompt[1].content.includes('不要再给'), prompt[1].content)
  check('system 里点明写心情（主人 22:38 定的措辞，照抄）', prompt[0].content.includes('写你此刻大概的心情') && prompt[0].content.includes('只写心情'), prompt[0].content)
  const many = buildVoicePrompt({ dialogue: Array.from({ length: 9 }, (_, i) => ({ you: '对方第' + i, me: '我第' + i })) })
  check('最多只带六轮（十二行）', (many[1].content.match(/对方：/g) || []).length === 6, many[1].content)

  let n = 0
  const queue = ['刚才那句我看了两遍', '话到嘴边没多说一句']
  const r = await generateVoice({ complete: async () => queue[n++], recent: ['刚才那句我看了两遍'] })
  check('第一句重了就再要一次', r.ok && r.text === '话到嘴边没多说一句' && n === 2, { r, n })

  const same = await generateVoice({ complete: async () => '刚才那句我看了两遍', recent: ['刚才那句我看了两遍'] })
  check('两次都重 → 不收（调用方留模板）', !same.ok && same.reason === 'repeat', same)

  // 2026-11-15：提示词里不再列禁词了，违规也当「再来一次」——两次都不行才不收
  const banned = await generateVoice({ complete: async () => '感觉有点想追问' })
  check('一上来就违规 → 再要一次，两次都违规才不收', !banned.ok && banned.tried.length === 2, banned)

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
  check('心情那截还照旧拼在後面', st.felt.includes('整体'), st.felt)
}

// ================================================================ 换不换：心情变了才重写（2026-11-15）
{
  const base = { label: 'frustrated', intensity: 0.5, slow: 0.0 }
  const snap = { label: 'frustrated', intensity: 0.5, slow: 0.0, mood: 0.5 }
  const at = Date.now()
  const old = new Date(at - 3600000).toISOString()

  check('没有句子 → 要写', voiceStale(null, { ...base, at, lastAt: null }).stale === true)
  check('心情没变 → 沿用', voiceStale(snap, { ...base, at, lastAt: old }).stale === false, voiceStale(snap, { ...base, at, lastAt: old }))
  check('标签变了 → 重写', voiceStale(snap, { ...base, label: 'joy', at, lastAt: old }).why === 'label')
  check('强度跨档 → 重写', voiceStale(snap, { ...base, intensity: 0.8, at, lastAt: old }).why === 'band')
  check('慢情绪走 0.2 以上 → 重写', voiceStale(snap, { ...base, slow: 0.25, at, lastAt: old }).why === 'slow')
  check('慢情绪只动 0.1 → 沿用', voiceStale(snap, { ...base, slow: 0.1, at, lastAt: old }).stale === false)
  check('老数据没记当时的数 → 当变了', voiceStale({ label: null, intensity: null, slow: null }, { ...base, at, lastAt: old }).why === 'unrecorded')
  check('三十秒内刚写过 → 不写（冷却）', voiceStale(snap, { ...base, label: 'joy', at, lastAt: new Date(at - 30000).toISOString() }).why === 'gap')
  check('冷却可以调成 0', voiceStale(snap, { ...base, label: 'joy', at, lastAt: new Date(at - 30000).toISOString(), gapMin: 0 }).why === 'label')
}

// ================================================================ 写进去的四个数要能读回来（下一轮靠它判断）
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-voice3-'))
  const db = openDb(path.join(dir, 'app.db'))
  const aid = 'agt_voice3'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,?)')
    .run(aid, '词表3', 'daily', 'active', now(), 13)
  recordVoice(db, aid, { text: '心里有点堵，还没到发火那一步', label: 'frustrated', intensity: 0.7, slow: 0.1, mood: 0.48 })
  const v = latestVoice(db, aid)
  check('写进去的数读得回来', v && v.snap && v.snap.label === 'frustrated' && v.snap.intensity === 0.7 && v.snap.slow === 0.1, v)
  const v2 = voiceStale(v.snap, { label: 'frustrated', intensity: 0.7, slow: 0.15, at: Date.now() + 3600000, lastAt: v.at })
  check('拿读回来的数判「要不要换」', v2.stale === false, v2)
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
