/**
 * 发信零件 · 考卷
 *
 * 管的是「把一句话交给哪条通道、按哪个形状送出去」：企业微信群机器人、QQ OneBot、
 * 以及统一入口的通道选择与配置读写。它不管「该不该说」（主动开口）。
 *
 * 运行：node test/exam-send.test.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import {
  getConfig, saveConfig, publicConfig, sendWecom, sendOneBot, onebotEndpoint, sendMessage, DEFAULTS,
} from '../src/modules/actions/channels.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}
const rejects = async (fn, re) => {
  try { await fn(); return false } catch (e) { return re ? re.test(String(e.message || e)) : true }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-exam-send-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_exam_send'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '考卷发信', 'daily', 'active', new Date().toISOString())

// ---- 本地假服务器：收企业微信 / OneBot 的请求
const hits = []
let wecomErr = 0
let onebotFail = false
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    let body = null
    try { body = JSON.parse(raw) } catch { body = null }
    hits.push({ url: req.url, auth: req.headers.authorization || '', body })
    res.setHeader('Content-Type', 'application/json')
    if (req.url.startsWith('/wecom')) {
      res.end(JSON.stringify(wecomErr ? { errcode: wecomErr, errmsg: '坏了' } : { errcode: 0 }))
    } else if (req.url === '/send_private_msg') {
      res.end(JSON.stringify(onebotFail ? { retcode: 1, msg: 'no' } : { retcode: 0, data: { message_id: 42 } }))
    } else if (req.url === '/send_group_msg') {
      res.end(JSON.stringify(onebotFail ? { retcode: 1 } : { retcode: 0, data: { message_id: 43 } }))
    } else {
      res.end('{}')
    }
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

// ================================================================ 配置：默认、读写、打码
{
  const cfg = getConfig(db, aid)
  check('没有配置时给默认值', cfg['wechat.mode'] === DEFAULTS['wechat.mode'] && cfg['qq.default_target_type'] === DEFAULTS['qq.default_target_type'], cfg)
  const saved = saveConfig(db, aid, { 'wechat.mode': 'wecom', 'qq.default_target': 'qq:12345', 'wecom_webhook': 'x' })
  check('保存后读得回来', saved['wechat.mode'] === 'wecom' && saved['qq.default_target'] === 'qq:12345', saved)
  check('不认识的键不落库', !('wecom_webhook' in saved), saved)
  const coerced = saveConfig(db, aid, { 'wechat.mode': '乱写' })
  check('非法值回默认', coerced['wechat.mode'] === DEFAULTS['wechat.mode'], coerced)
  const masked = publicConfig({ ...cfg, 'wechat.wecom_webhook': 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef123456', 'qq.token': 'secret-token-123' })
  check('公开视图：webhook 打码且带 has 标记', masked['wechat.wecom_webhook'].includes('••••') && masked.has_wecom_webhook === true, masked)
  check('公开视图：token 打码', masked['qq.token'].includes('••••') && masked.has_qq_token === true, masked)
}

// ================================================================ 企业微信：分片与失败
{
  check('空 webhook：拒', await rejects(() => sendWecom('', 'hi'), /没有配置/))
  check('非法 URL：拒', await rejects(() => sendWecom('not a url', 'hi'), /不是合法 URL/))
  hits.length = 0
  const out = await sendWecom(base + '/wecom', '你好')
  check('发送成功：一份', out.ok === true && out.parts === 1, out)
  const h = hits[0]
  check('形状：msgtype=text + content', h && h.body && h.body.msgtype === 'text' && h.body.text.content === '你好', h)
  hits.length = 0
  const long = '字'.repeat(4000)
  const multi = await sendWecom(base + '/wecom', long)
  check('超长：按 1800 切片', multi.parts === 3 && hits.length === 3, { parts: multi.parts, hits: hits.length })
  wecomErr = 93000
  check('errcode 非 0：抛错', await rejects(() => sendWecom(base + '/wecom', 'hi'), /企业微信返回 93000/))
  wecomErr = 0
}

// ================================================================ OneBot：私聊 / 群 / 鉴权
{
  check('地址为空：拒', (() => { try { onebotEndpoint(''); return false } catch (e) { return /没有配置/.test(e.message) } })())
  check('地址非法：拒', (() => { try { onebotEndpoint('abc'); return false } catch (e) { return /不是合法 URL/.test(e.message) } })())
  check('末尾斜杠去掉', onebotEndpoint(base + '/') === base)

  hits.length = 0
  const priv = await sendOneBot({ baseUrl: base + '/', token: 'tok', targetType: 'private', target: 'qq:12345', text: '在吗' })
  check('私聊：成功并带回 message_id', priv.ok === true && priv.message_id === 42, priv)
  const p = hits[0]
  check('私聊：打到 send_private_msg + user_id', p.url === '/send_private_msg' && p.body.user_id === 12345 && p.body.message === '在吗', p)
  check('带 token 时加 Bearer', p.auth === 'Bearer tok', p)

  hits.length = 0
  const grp = await sendOneBot({ baseUrl: base, targetType: 'group', target: '987654321', text: '群里' })
  check('群聊：打到 send_group_msg + group_id', grp.ok === true && hits[0].url === '/send_group_msg' && hits[0].body.group_id === 987654321, hits[0])

  check('不是数字的号：拒', await rejects(() => sendOneBot({ baseUrl: base, targetType: 'private', target: 'abc', text: 'x' }), /看起来不对/))
  onebotFail = true
  check('retcode 非 0：抛错', await rejects(() => sendOneBot({ baseUrl: base, targetType: 'private', target: '12345', text: 'x' }), /OneBot 返回失败/))
  onebotFail = false
}

// ================================================================ 统一入口：通道怎么选
{
  check('空文本：拒', await rejects(() => sendMessage(db, aid, { text: '  ' }), /空的/))
  check('不认识的通道：拒', await rejects(() => sendMessage(db, aid, { text: 'hi', channel: 'sms' }), /不认识的通道/))

  // 显式 wecom：走企业微信
  saveConfig(db, aid, { 'wechat.mode': 'wecom', 'wechat.wecom_webhook': base + '/wecom' })
  hits.length = 0
  const w = await sendMessage(db, aid, { text: '群消息', channel: 'wecom' })
  check('显式 wecom：走群机器人', w.channel === 'wecom' && w.ok === true && hits.some((h) => h.url === '/wecom'), w)

  // auto + wecom 模式：也走企业微信
  hits.length = 0
  const a = await sendMessage(db, aid, { text: '自动' })
  check('auto + wecom 模式：走企业微信', a.channel === 'wecom', a)

  // qq：用配置里的地址和默认收件人
  saveConfig(db, aid, { 'qq.base_url': base, 'qq.token': '', 'qq.default_target': '12345', 'qq.default_target_type': 'private' })
  hits.length = 0
  const q = await sendMessage(db, aid, { text: 'QQ 消息', channel: 'qq' })
  check('qq：走 OneBot，用默认收件人', q.channel === 'qq' && q.ok === true && hits[0].url === '/send_private_msg' && hits[0].body.user_id === 12345, q)

  // 显式 wechat + 模式是 wecom：现在会按模式改道企业微信（和代码注释「显式 wechat 不改道」不一致，先按现状考）
  saveConfig(db, aid, { 'wechat.mode': 'wecom', 'wechat.wecom_webhook': base + '/wecom' })
  hits.length = 0
  const reroute = await sendMessage(db, aid, { text: 'x', channel: 'wechat' })
  check('显式 wechat + wecom 模式：按现状改道企业微信', reroute.channel === 'wecom' && reroute.ok === true, reroute)

  // 模式 auto、显式 wechat、默认收件人也清空：报缺收件人
  saveConfig(db, aid, { 'wechat.mode': 'auto', 'wechat.default_target': '' })
  check('显式 wechat + 没目标：报缺收件人', await rejects(() => sendMessage(db, aid, { text: 'x', channel: 'wechat' }), /没有给微信收件人/))
}

server.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
