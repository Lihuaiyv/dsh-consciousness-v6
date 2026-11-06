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
  channelOrder, autoOrder, conversationIdOfSend,
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

  // 显式 wechat 就是微信：模式配了企业微信也不改道，缺收件人就报错（2026-11-07 起）
  saveConfig(db, aid, { 'wechat.mode': 'wecom', 'wechat.wecom_webhook': base + '/wecom', 'wechat.default_target': '' })
  hits.length = 0
  const noReroute = await rejects(() => sendMessage(db, aid, { text: 'x', channel: 'wechat' }), /没有给微信收件人/)
  check('显式 wechat + wecom 模式：不改道，缺收件人就报错', noReroute && hits.length === 0, { noReroute, hits: hits.length })

  // 显式 wechat + 模式 auto + 没目标：同样报缺收件人
  saveConfig(db, aid, { 'wechat.mode': 'auto', 'wechat.default_target': '' })
  check('显式 wechat + 没目标：报缺收件人', await rejects(() => sendMessage(db, aid, { text: 'x', channel: 'wechat' }), /没有给微信收件人/))
}

// ================================================================ 顺位：默认 QQ 第一，微信封存
{
  saveConfig(db, aid, { 'wechat.default_target': '文件传输助手', 'qq.base_url': base, 'qq.default_target': '12345', 'qq.default_target_type': 'private' })
  const order = channelOrder(getConfig(db, aid))
  check('默认顺位：QQ 第一', order.join(',') === 'qq,wecom,wechat', order)
  check('默认封存：微信是封着的', getConfig(db, aid)['wechat.sealed'] === true, getConfig(db, aid)['wechat.sealed'])

  const custom = saveConfig(db, aid, { 'send.order': 'wecom,qq,乱写' })
  check('顺位：写错的名字丢掉，没写的补在后面', channelOrder(custom).join(',') === 'wecom,qq,wechat', channelOrder(custom))
  check('顺位：空配置回默认，不会一条都不剩', channelOrder({}).join(',') === 'qq,wecom,wechat', channelOrder({}))

  // 封存 = 只从 auto 顺位里拿掉：显式点名照样发，auto 不偷偷退回微信。
  // 这里只考顺位（autoOrder），不真去调微信窗口——那张考卷在 exam-wechat，别在这耗两分钟。
  const sealedCfg = { ...getConfig(db, aid), 'wechat.sealed': true, 'send.order': 'wechat,qq,wecom' }
  check('封存：auto 顺位里没有微信', autoOrder(sealedCfg).join(',') === 'qq,wecom', autoOrder(sealedCfg))
  const openCfg = { ...sealedCfg, 'wechat.sealed': false }
  check('解封：微信回到 auto 顺位', autoOrder(openCfg)[0] === 'wechat', autoOrder(openCfg))
  let allSealed = null
  try { autoOrder({ 'send.order': 'wechat', 'wechat.sealed': true }) } catch (e) { allSealed = e }
  check('封存：只排了微信时顺位仍会补出别的通道（channelOrder 会补齐）', !allSealed && autoOrder({ 'send.order': 'wechat', 'wechat.sealed': true }).join(',') === 'wecom,qq', allSealed && allSealed.message)

  // 顺位第一是企业微信、但没配 webhook：跳过，换下一条
  saveConfig(db, aid, { 'wechat.wecom_webhook': null, 'send.order': 'wecom,qq,wechat' })
  check('密钥：要清空得传 null（空串=这次没改）', String(getConfig(db, aid)['wechat.wecom_webhook']) === '', getConfig(db, aid)['wechat.wecom_webhook'])
  hits.length = 0
  const skip = await sendMessage(db, aid, { text: '换道' })
  check('auto：wecom 没配 webhook → 跳过，落到 qq', skip.channel === 'qq' && skip.tried[0] && skip.tried[0].reason === 'no_webhook', skip)

  // 全都不通：报顺位 + 每条的原因，不装作发过了
  saveConfig(db, aid, { 'send.order': 'qq,wecom,wechat', 'qq.default_target': '', 'wechat.default_target': '' })
  let allDead = null
  try { await sendMessage(db, aid, { text: 'x' }) } catch (e) { allDead = e }
  check('auto：全都不通 → 报顺位与每条的原因',
    !!allDead && /没有一条通道发得出去/.test(String(allDead.message)) && /qq：没有收件人/.test(String(allDead.message)),
    allDead && allDead.message)
}

// ================================================================ 会话记账 id：发出去的话回看得见
{
  check('会话 id：微信按联系人', conversationIdOfSend('wechat', '张三', {}) === 'wechat:张三', conversationIdOfSend('wechat', '张三', {}))
  check('会话 id：企业微信是群', conversationIdOfSend('wecom', '', {}) === 'wecom:group', conversationIdOfSend('wecom', '', {}))
  check('会话 id：QQ 私聊 / 群各用前缀',
    conversationIdOfSend('qq', 'qq:10001', { 'qq.default_target_type': 'private' }) === 'qq:p:10001'
    && conversationIdOfSend('qq', '10002', { 'qq.default_target_type': 'group' }) === 'qq:g:10002')
  check('会话 id：没目标就空着（不编一段假会话）', conversationIdOfSend('wechat', '', {}) === '', conversationIdOfSend('wechat', '', {}))
}

server.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
