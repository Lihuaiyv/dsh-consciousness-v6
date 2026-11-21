/**
 * 一轮压两句（你 / 我）＋「我上一句」读回。
 * 2026-11-15：主人的话也不原样递——一起压；最近六轮写成「你：/我：」十二行。
 * 运行：node test/presence-summary.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { presenceLine } from '../src/modules/presence.js'
import {
  buildPairPrompt,
  parsePair,
  validateLastSentence,
  generatePairSummary,
  recordLastSentence,
  lastSentenceOf,
  recentDialoguePairs,
} from '../src/modules/last_sentence.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

const LONG = '读完了，主人。那份在 [提示词改进-2026-11-14.md](<docs/待实现想法/提示词改进-2026-11-14.md>)，三件：A 一句话手感、B 四条线合并、C 上一句摘要。'
const LONG_USER = '下面这块是啥？user和上面的 system 有什么不同？我想知道这一块到底拿什么材料、怎么拼起来的，还有以后要改该改哪里。'
const SHORT = '好，那就这样。'

function seedTurn(w, { id, role = 'agent', text, tid = 'tid_1', conv = 'dsh:sess-eval', agoMs = 1000 }) {
  w.db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id,turn_id) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, w.aid, role, text, '[]', null, new Date(Date.now() - agoMs).toISOString(), conv, tid)
}

// ---- 1 没摘要：退回截断（和今天一样，兜底不能丢）
{
  const w = makeWorld()
  try {
    w.db.prepare('DELETE FROM chat_turns WHERE agent_id=?').run(w.aid)
    seedTurn(w, { id: 'cht_1', text: LONG })
    const p = presenceLine(w.db, w.aid, { conversationId: 'dsh:sess-eval' })
    check('没摘要时退回截断', p.source === 'clip', p.source)
    check('没摘要时仍带省略号', p.line.includes('…」'), p.line)
    check('没摘要时非空', p.line.includes('我上一句说的是'), p.line)
  } finally { w.close() }
}

// ---- 2 有摘要：整句读完，不再是半句
{
  const w = makeWorld()
  try {
    w.db.prepare('DELETE FROM chat_turns WHERE agent_id=?').run(w.aid)
    seedTurn(w, { id: 'cht_2', text: LONG, tid: 'tid_2' })
    recordLastSentence(w.db, w.aid, { turnId: 'tid_2', conversationId: 'dsh:sess-eval', text: '读完了，三件都还在，先说 C。', you: '那份提示词改进在哪。', maxChars: 24 })
    const p = presenceLine(w.db, w.aid, { conversationId: 'dsh:sess-eval' })
    check('有摘要就用摘要', p.source === 'summary', p.source)
    check('摘要完整出现在那行', p.line.includes('我上一句说的是「读完了，三件都还在，先说 C。」。'), p.line)
    check('有摘要时不再出现截断省略号', !p.line.includes('…」'), p.line)
    check('摘要不带链接/路径', !/https?:|\.md|D:/.test(p.line), p.line)
  } finally { w.close() }
}

// ---- 3 只按 turn_id 认：别轮的短话不许顶替
{
  const w = makeWorld()
  try {
    w.db.prepare('DELETE FROM chat_turns WHERE agent_id=?').run(w.aid)
    seedTurn(w, { id: 'cht_3', text: LONG, tid: 'tid_now' })
    recordLastSentence(w.db, w.aid, { turnId: 'tid_old', conversationId: 'dsh:sess-eval', text: '这是上一轮的短话。' })
    const p = presenceLine(w.db, w.aid, { conversationId: 'dsh:sess-eval' })
    check('别轮的摘要不冒领', p.source === 'clip', p.source)
    check('别轮的摘要不出现', !p.line.includes('这是上一轮的短话'), p.line)
  } finally { w.close() }
}

// ---- 4 开关：关掉就逐字回到旧行为
{
  const w = makeWorld()
  try {
    w.db.prepare('DELETE FROM chat_turns WHERE agent_id=?').run(w.aid)
    seedTurn(w, { id: 'cht_4', text: LONG, tid: 'tid_4' })
    recordLastSentence(w.db, w.aid, { turnId: 'tid_4', conversationId: 'dsh:sess-eval', text: '读完了，三件都还在。' })
    const onLine = presenceLine(w.db, w.aid, { conversationId: 'dsh:sess-eval' }).line
    w.db.prepare('INSERT INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)').run(w.aid, 'presence.summary', 'off', new Date().toISOString())
    const off = presenceLine(w.db, w.aid, { conversationId: 'dsh:sess-eval' })
    check('关掉读回截断', off.source === 'clip', off.source)
    check('关掉后与有摘要那行不同', off.line !== onLine)
  } finally { w.close() }
}

// ---- 5 你上一句：不走我的摘要
{
  const w = makeWorld()
  try {
    w.db.prepare('DELETE FROM chat_turns WHERE agent_id=?').run(w.aid)
    seedTurn(w, { id: 'cht_5', role: 'user', text: LONG, tid: 'tid_5' })
    recordLastSentence(w.db, w.aid, { turnId: 'tid_5', conversationId: 'dsh:sess-eval', text: '我自己瞎写的短话。' })
    const p = presenceLine(w.db, w.aid, { conversationId: 'dsh:sess-eval' })
    check('你说的话不拿我的短话替', !p.line.includes('我自己瞎写的短话'), p.line)
    check('你说的仍标「你上一句」', p.line.includes('你上一句说的是'), p.line)
  } finally { w.close() }
}

// ---- 6 校验：坏形状一律不收
{
  check('空的不收', validateLastSentence('').ok === false)
  check('太短的不收', validateLastSentence('嗯。').ok === false)
  check('以省略号结尾不收', validateLastSentence('读完了，那份在提示词改进里…').ok === false)
  check('带链接不收', validateLastSentence('读完了，见 [提示词改进](x)。').ok === false)
  check('带长英文不收', validateLastSentence('读完了，deepseek 那个文件。').ok === false)
  check('超长不收', validateLastSentence('一'.repeat(60), { maxChars: 24 }).ok === false)
  check('正常的一句收', validateLastSentence('读完了，三件都还在，先说 C。', { maxChars: 24 }).ok === true)
  const v = validateLastSentence('「读完了，三件都还在。」', { maxChars: 24 })
  check('去掉外层引号', v.ok && v.text === '读完了，三件都还在。', v)
}

// ---- 7 解析：两句都要
{
  const p = parsePair('{"you":"那份提示词改进在哪","me":"读完了，三件都还在。"}')
  check('解析出 you', p.you === '那份提示词改进在哪', p)
  check('解析出 me', p.me === '读完了，三件都还在。', p)
  const fenced = parsePair('```json\n{"you":"那份在哪","me":"读完了。"}\n```')
  check('围栏里的 JSON 也认', fenced.you === '那份在哪' && fenced.me === '读完了。', fenced)
  // 线上一类真实翻车：全角冒号 / 中文键 / 方括号引号 —— JSON.parse 直接挂
  const full = parsePair('{「you」：「那份在哪」，「me」：「读完了，三件都还在。」}')
  check('全角冒号 + 中文括号也认得出 you', full.you === '那份在哪', full)
  check('全角冒号 + 中文括号也认得出 me', full.me === '读完了，三件都还在。', full)
  const cn = parsePair('{"对方":"那份在哪","我":"读完了。"}')
  check('中文键也认得出', cn.you === '那份在哪' && cn.me === '读完了。', cn)
  // 现在要的是两行纯文本，不再逼模型写 JSON（两键 JSON 那版一直回空串）
  const twoLine = parsePair('对方：那份提示词改进在哪\n我：读完了，三件都还在。')
  check('两行纯文本认得出来', twoLine.you === '那份提示词改进在哪' && twoLine.me === '读完了，三件都还在。', twoLine)
  const twoLineWeird = parsePair('- 对方: 那份在哪\n- 我: 读完了。')
  check('带横杠、半角冒号也认', twoLineWeird.you === '那份在哪' && twoLineWeird.me === '读完了。', twoLineWeird)
  check('不是 JSON 时只认第一行当「我」', parsePair('读完了，三件都还在。\n多余解释').me === '读完了，三件都还在。')
}

// ---- 8 生成：两边都短才跳过；你那边长也要压
{
  const w = makeWorld()
  try {
    let calls = 0
    const complete = async () => { calls++; return '{"you":"他在问那一块是什么","me":"读完了，三件都还在，先说 C。"}' }

    const short = await generatePairSummary({ delays: [0, 0, 0], complete, user: SHORT, text: SHORT, maxChars: 24 })
    check('两边都短才跳过模型', short.ok === true && short.skipped === true && calls === 0, { short, calls })

    const longUserOnly = await generatePairSummary({ delays: [0, 0, 0], complete, user: LONG_USER, text: SHORT, maxChars: 24 })
    check('只有你那边长 → 也要调模型压', longUserOnly.ok === true && calls === 1, { longUserOnly, calls })
    check('你那边压出来了', longUserOnly.you === '他在问那一块是什么', longUserOnly)

    const both = await generatePairSummary({ delays: [0, 0, 0], complete, user: LONG_USER, text: LONG, maxChars: 24 })
    check('两边都长 → 一句调用压两句', both.ok === true && calls === 2 && !!both.you && !!both.text, { both, calls })
    check('我那句合格', validateLastSentence(both.text, { maxChars: 24 }).ok, both.text)

    const boom = await generatePairSummary({ delays: [0, 0, 0], complete: async () => { throw new Error('boom') }, user: LONG_USER, text: LONG, maxChars: 24 })
    check('模型挂了返回失败', boom.ok === false && boom.reason === 'model-error', boom)

    const timeout = await generatePairSummary({ delays: [0, 0, 0], complete: () => new Promise(() => {}), user: LONG_USER, text: LONG, maxChars: 24, timeoutMs: 250 })
    check('超时返回失败', timeout.ok === false && timeout.reason === 'timeout', timeout)

    const bad = await generatePairSummary({ delays: [0, 0, 0], complete: async () => '{"you":"他在问 [那一块](x)…","me":"读完了。"}', user: LONG_USER, text: LONG, maxChars: 24 })
    check('你那边不合格也整条不收', bad.ok === false && String(bad.reason).startsWith('you:'), bad)

    // 本地 14B 会把整段抄回来：超长不判失败，直接本地裁到 N 字
    const lazy = await generatePairSummary({
      delays: [0, 0, 0],
      complete: async () => '{"you":"' + LONG_USER + '","me":"' + LONG + '"}',
      user: LONG_USER,
      text: LONG,
      maxChars: 24,
    })
    check('模型没压、原样抄回来时本地裁', lazy.ok === true && Array.from(lazy.you).length <= 25 && Array.from(lazy.text).length <= 25, lazy)

    // 2026-11-15 线上：这条是全轮第一个模型调用，偶尔回空串。空就再要一次。
    let tries = 0
    const flaky = await generatePairSummary({ delays: [0, 0, 0],
      complete: async () => { tries++; return tries === 1 ? '' : '{"you":"他在问那块是什么","me":"读完了，三件都还在。"}' },
      user: LONG_USER,
      text: LONG,
      maxChars: 24,
    })
    check('第一次回空 → 隔一下再要，第二次拿到就算成', flaky.ok === true && tries === 2 && flaky.you === '他在问那块是什么', { flaky, tries })

    const alwaysEmpty = await generatePairSummary({ delays: [0, 0, 0], complete: async () => '', user: LONG_USER, text: LONG, maxChars: 24 })
    check('两次都空才认输', alwaysEmpty.ok === false && String(alwaysEmpty.reason).includes('empty'), alwaysEmpty)

    // 落库：同一 turn_id 只写一条
    const a = recordLastSentence(w.db, w.aid, { turnId: 'tid_gen', conversationId: 'dsh:sess-eval', text: '读完了，三件都还在。', you: '那份提示词改进在哪。' })
    const b = recordLastSentence(w.db, w.aid, { turnId: 'tid_gen', conversationId: 'dsh:sess-eval', text: '又压了一遍，不该出现。', you: '不该出现。' })
    const n = w.db.prepare("SELECT count(*) n FROM events WHERE agent_id=? AND type='presence.last_sentence'").get(w.aid).n
    check('同一轮只写一条', !!a && b === null && n === 1, { a, b, n })
    const hit = lastSentenceOf(w.db, w.aid, { turnId: 'tid_gen' })
    check('读回原文没被第二条覆盖', hit && hit.text === '读完了，三件都还在。', hit)
    check('you 也读得回来', hit && hit.you === '那份提示词改进在哪。', hit)
    check('没有 turn_id 不瞎认', lastSentenceOf(w.db, w.aid, { turnId: null }) === null)
  } finally { w.close() }
}

// ---- 9 六轮对话：旧的在前、只取本会话、两边都在
{
  const w = makeWorld()
  try {
    for (let i = 1; i <= 8; i++) {
      recordLastSentence(w.db, w.aid, {
        turnId: 'tid_' + i,
        conversationId: 'dsh:sess-eval',
        text: '我说第' + i + '句，压好了。',
        you: '你说第' + i + '句，压好了。',
        maxChars: 24,
      })
    }
    recordLastSentence(w.db, w.aid, { turnId: 'tid_x', conversationId: 'dsh:other', text: '别处的句子，压好了。', you: '别处的问话，压好了。' })
    const pairs = recentDialoguePairs(w.db, w.aid, { conversationId: 'dsh:sess-eval', rounds: 6 })
    check('只取本会话的六轮', pairs.length === 6, pairs.length)
    check('旧→新', pairs[0].me.includes('第3句') && pairs[5].me.includes('第8句'), pairs.map((p) => p.me))
    check('每到一对都是两句', pairs.every((p) => p.you.includes('你说') && p.me.includes('我说')), pairs[0])
    check('别的窗口的事不混进来', !pairs.some((p) => p.me.includes('别处')), pairs.map((p) => p.me))
  } finally { w.close() }
}

// ---- 10 压的提示词：两边都给，要求两句
{
  const msgs = buildPairPrompt({ user: LONG_USER, text: LONG, maxChars: 24 })
  check('两条消息', Array.isArray(msgs) && msgs.length === 2, msgs && msgs.length)
  check('system 要两行、不要 JSON', msgs[0].content.includes('两行') && msgs[0].content.includes('对方：') && msgs[0].content.includes('我：'), msgs[0].content)
  check('system 里带字数', msgs[0].content.includes('24'), msgs[0].content)
  check('user 里两边都在（对方 / 我）', msgs[1].content.includes('对方：') && msgs[1].content.includes('我：'), msgs[1].content)
  check('原话里的〔留〕被摘掉', !buildPairPrompt({ user: '〔留〕这句要留。', text: '〔留〕这句也要。' })[1].content.includes('〔留〕'))
}

// ---- 11 模型没给时，本地截断兜底也要能读回来（六轮上下文不能断）
{
  const w = makeWorld()
  try {
    recordLastSentence(w.db, w.aid, {
      turnId: 'tid_clip',
      conversationId: 'dsh:sess-eval',
      text: '读完了，三件都还在，先说 C，然后…',
      you: '那份提示词改进在哪，我想…',
      maxChars: 24,
      source: 'clip',
    })
    const hit = lastSentenceOf(w.db, w.aid, { turnId: 'tid_clip' })
    check('截断兜底那行读得回来（不拿省略号挡它）', hit && hit.text.startsWith('读完了，三件都还在'), hit)
    const pairs = recentDialoguePairs(w.db, w.aid, { conversationId: 'dsh:sess-eval', rounds: 6 })
    check('截断兜底的也进得了六轮', pairs.some((p) => p.me.startsWith('读完了，三件都还在') && p.you.startsWith('那份提示词改进在哪')), pairs)
  } finally { w.close() }
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
