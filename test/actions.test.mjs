/**
 * 行动层单测：端口闸门 / 通道配置 / OneBot 发送 / 研究流水线 / 去重 / 工具注册形状。
 * 不碰真实网络：web 和模型都是假的，OneBot 用本地 http server。
 */
import assert from 'node:assert'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { seedState } from '../src/core.js'
import { createActionTools, executeSend, executeRemind, executeResearch, executeBrowse, getConfig, saveConfig, requirePort } from '../src/modules/actions/index.js'
import { scoreSource, classifyDomain, scoreLabel } from '../src/modules/actions/credibility.js'
import { canonicalUrl, htmlToText, jaccard, parseJsonLoose } from '../src/modules/actions/util.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-actions-'))
process.env.DSH_HOME = dir
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_test'
db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,'daily','active',?,1)").run(aid, '测试体', new Date().toISOString())
seedState(db, aid)

let pass = 0
function ok(name) { pass++; console.log('  ✓', name) }

// ---------- 假依赖（放最前面，避免顶层 await 撞上 TDZ） ----------
const fakeWeb = {
  async search({ maxResults }) {
    return {
      truncated: false,
      sources: [
        { url: 'https://example.com/a?utm_source=x', title: '示例文章 A', snippet: '和主题有关的摘要', publishedAt: '2026-09-01' },
        { url: 'https://www.gov.cn/zhengce/b', title: '政策原文 B', snippet: '官方口径', publishedAt: '2026-08-01' },
        { url: 'https://zhihu.com/question/1', title: '社区讨论 C', snippet: '个人经验' },
      ].slice(0, maxResults || 8),
    }
  },
  async fetch({ url }) {
    const bodyText = '这是正文内容，用来测试抽取与引用。'.repeat(30)
    return {
      url,
      statusCode: 200,
      truncated: false,
      body: { kind: 'html', content: '<html><head><title>测试页</title></head><body><p>' + bodyText + '</p></body></html>' },
    }
  },
}

const fakeModel = {
  status: () => ({ primary: 'ok' }),
  async chat(messages) {
    const sys = String((messages && messages[0] && messages[0].content) || '')
    if (sys.includes('检索策略')) return JSON.stringify({ queries: ['测试 现状', '测试 数据', '测试 风险'] })
    if (sys.includes('研究主编')) return '# 测试报告\n\n## 一句话结论\n测试结论。\n\n## 来源\n- [S1] 示例'
    return JSON.stringify({
      summary: '这是一段摘要。',
      claims: [{ claim: '测试说法 A', quote: '这是正文内容', stance: 'support', confidence: 0.8 }],
      published: '2026-09-01',
      author: '测试作者',
    })
  },
}

// ---------- 1. 凭证/来源打分 ----------
ok('域名分档：政府 > 社区')
assert.ok(scoreSource({ url: 'https://www.gov.cn/a' }).score > scoreSource({ url: 'https://zhihu.com/q/1' }).score)
assert.equal(classifyDomain('www.nature.com').id, 'academic')
assert.equal(scoreLabel(0.85), '高')
assert.equal(scoreLabel(0.3), '低')
ok('URL 归一会丢掉跟踪参数')
assert.equal(canonicalUrl('https://Example.com/a/?utm_source=x&b=2#h'), 'https://example.com/a?b=2')
ok('HTML 转文本保留段落且去脚本')
const txt = htmlToText('<html><head><title>T</title><script>bad()</script></head><body><p>第一段</p><p>第二段 &amp; 更多</p></body></html>')
assert.ok(txt.includes('第一段') && txt.includes('第二段 & 更多') && !txt.includes('bad'))
ok('相似度：同一说法的改写能聚到一起')
assert.ok(jaccard('这个方案成本很高，需要三千万', '这个方案的成本很高，大约要三千万') > 0.42)
ok('宽松 JSON 解析')
assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 })

// ---------- 2. 端口闸门 + 配置 ----------
const ports = db.prepare('SELECT name,enabled FROM action_ports WHERE agent_id=?').all(aid)
assert.equal(ports.length, 4)
assert.ok(ports.every((p) => !p.enabled))
assert.throws(() => requirePort(db, aid, 'send_message'), /还没开/)
ok('默认四个端口全关')

const cfg0 = getConfig(db, aid)
assert.equal(cfg0['wechat.mode'], 'uia')
assert.equal(cfg0['research.depth'], 'standard')
const cfg1 = saveConfig(db, aid, { 'wechat.mode': 'wecom', 'research.max_sources': 7, 'bogus.key': 1 })
assert.equal(cfg1['wechat.mode'], 'wecom')
assert.equal(cfg1['research.max_sources'], 7)
assert.equal(cfg1['bogus.key'], undefined)
ok('配置读写 + 未知键丢弃')

// ---------- 3. 工具形状 ----------
const tools = createActionTools({
  getDb: () => db,
  getAgentId: () => aid,
  getWeb: () => fakeWeb,
  getModel: () => fakeModel,
  log: () => {},
})
const names = tools.map((t) => t.name).sort()
assert.ok(names.includes('act_browse') && names.includes('act_send') && names.includes('act_research'))
assert.ok(names.includes('memory_search') || names.includes('act_remind'))
for (const t of tools) {
  assert.ok(t.description && t.parameters && t.output.schema && typeof t.output.render === 'function')
  assert.equal(typeof t.execute, 'function')
}
ok('行动工具都有 schema / render / execute')

// 端口没开时工具拒绝执行
await assert.rejects(() => tools.find((t) => t.name === 'act_browse').execute({ mode: 'bilibili_feed' }), /还没开/)
ok('端口未开时 act_browse 拒绝')

// ---------- 4. OneBot 发送 ----------
const received = []
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    received.push({ url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 42 } }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + server.address().port

saveConfig(db, aid, { 'qq.base_url': base, 'qq.token': 'tk', 'qq.default_target_type': 'private' })
db.prepare("INSERT OR REPLACE INTO action_ports VALUES(?,?,?,?)").run(aid, 'send_message', 1, new Date().toISOString())
const sent = await executeSend(db, aid, { channel: 'qq', target: '10001', text: '你好' })
assert.equal(sent.channel, 'qq')
assert.equal(received.length, 1)
assert.equal(received[0].url, '/send_private_msg')
assert.equal(received[0].auth, 'Bearer tk')
assert.deepEqual(JSON.parse(received[0].body), { user_id: 10001, message: '你好' })
ok('OneBot 私聊发送：端点 / 鉴权 / 载荷都对')

const logRow = db.prepare("SELECT * FROM action_log WHERE agent_id=? AND port='send_message' ORDER BY created_at DESC").get(aid)
assert.ok(logRow && logRow.status === 'sent')
ok('发送写入 action_log')

// ---------- 5. 提醒 ----------
db.prepare("INSERT OR REPLACE INTO action_ports VALUES(?,?,?,?)").run(aid, 'remind', 1, new Date().toISOString())
const rem = executeRemind(db, aid, { text: '明天看报告', at: new Date(Date.now() + 86400000).toISOString() })
assert.ok(rem.inbox_id)
assert.equal(db.prepare('SELECT COUNT(*) n FROM inbox_items WHERE agent_id=?').get(aid).n, 1)
ok('提醒进收件箱')

// ---------- 6. 浏览（假 web） ----------
db.prepare("INSERT OR REPLACE INTO action_ports VALUES(?,?,?,?)").run(aid, 'browse', 1, new Date().toISOString())
const b = await executeBrowse(db, aid, { mode: 'url', url: 'https://example.com/post' }, { web: fakeWeb })
assert.equal(b.mode, 'url')
assert.ok(b.text.includes('正文'))
assert.equal(b.status, 200)
ok('网页浏览走宿主 web.fetch')

// ---------- 7. 研究流水线 ----------
db.prepare("INSERT OR REPLACE INTO action_ports VALUES(?,?,?,?)").run(aid, 'research', 1, new Date().toISOString())
const out = await executeResearch(db, aid, { topic: '测试主题', goal: '验证流水线', depth: 'quick', max_sources: 5 }, { web: fakeWeb, model: fakeModel })
assert.ok(out.run_id.startsWith('rsr_'))
assert.ok(out.report.includes('测试报告'))
assert.ok(out.sources.length >= 1)
assert.ok(out.sources.every((s) => s.url && s.tier && typeof s.score === 'number'))
assert.ok(out.stats.fetched >= 1)
assert.equal(db.prepare('SELECT COUNT(*) n FROM research_runs WHERE agent_id=?').get(aid).n, 1)
assert.ok(fs.existsSync(out.file), '报告文件应落盘')
ok('研究：流水线跑通，报告/来源/统计都齐')

const out2 = await executeResearch(db, aid, { topic: '测试主题', goal: '第二轮', depth: 'quick', max_sources: 5 }, { web: fakeWeb, model: fakeModel })
assert.ok(out2.stats.seen_skipped > 0, '第二轮应跳过已读来源')
ok('研究：第二轮跳过已读来源')

// ---------- 7b. 模型 chat 通道（研究依赖它；ModelPort 之前没有这个方法） ----------
{
  const { createModel, attachHostLlm } = await import('../src/model.js')
  const llm = {
    stream: async function* () { /* available() 只检查它存在 */ },
    prepareCall: async (cfg) => ({
      config: { ...cfg },
      async *stream() { yield { type: 'text-delta', text: '{"queries":["a","b"]}' } },
    }),
  }
  const fakeCtx = {
    get: (n) => (n === 'llm' ? llm
      : n === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : null),
  }
  attachHostLlm(() => fakeCtx)
  const m = createModel()
  const out3 = await m.chat([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], 100)
  assert.equal(out3, '{"queries":["a","b"]}')
  ok('ModelPort.chat → 宿主 llm 可用')
}

// ---------- 8. 工具端到端 ----------
const researchTool = tools.find((t) => t.name === 'act_research')
const tOut = await researchTool.execute({ topic: '工具测试', depth: 'quick' })
assert.ok(tOut.report.includes('测试报告'))
const render = researchTool.output.render({}, tOut)
assert.equal(render[0].type, 'text')
assert.ok(render[0].text.length > 100)
ok('act_research 工具执行 + 渲染')

// P4.4 / P4.7 / P4.8（在预算打满之前测）
{
  const { publicConfig, isBlockedBrowseHost } = await import('../src/modules/actions/index.js')
  saveConfig(db, aid, { 'qq.token': 'secret-token-xyz' })
  const kept = saveConfig(db, aid, { 'qq.token': '' })
  assert.equal(kept['qq.token'], 'secret-token-xyz')
  const pub = publicConfig(kept)
  assert.ok(pub['qq.token'].includes('••••'))
  assert.ok(!String(pub['qq.token']).includes('secret-token'))
  ok('配置：空串保留密钥 + GET 视图打码')

  assert.ok(isBlockedBrowseHost('127.0.0.1'))
  assert.ok(isBlockedBrowseHost('10.0.0.1'))
  assert.ok(isBlockedBrowseHost('192.168.1.1'))
  assert.ok(isBlockedBrowseHost('localhost'))
  assert.ok(!isBlockedBrowseHost('example.com'))
  await assert.rejects(() => executeBrowse(db, aid, { mode: 'url', url: 'http://127.0.0.1/' }, { web: fakeWeb }), /内网|本机/)
  ok('浏览：私网 / localhost 被拦')

  await assert.rejects(() => executeSend(db, aid, { channel: 'qq', text: '无收件人' }), /收件人/)
  ok('发送：无显式 target 拒绝')
}

// 预算：默认本月 3 条（前面已用 1 条成功发送；无 target 失败会退款）
saveConfig(db, aid, { 'qq.default_target_type': 'group' })
received.length = 0
for (let i = 0; i < 2; i++) await executeSend(db, aid, { channel: 'qq', target: '20002', text: '第' + i + '条' })
await assert.rejects(() => executeSend(db, aid, { channel: 'qq', target: '20002', text: '第四条' }), /本月打扰预算/)
ok('打扰预算：超过 3 条被拦')

server.close()
try { db.close() } catch { /* ignore */ }
fs.rmSync(dir, { recursive: true, force: true })
console.log('\n actions.test: ' + pass + ' 组通过')
