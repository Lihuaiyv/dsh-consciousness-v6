/**
 * 用真实的 consciousnessBlock（不是桩）拼一次 QQ 提示词，检查「便签」不再重复。
 * 在线上库的副本上跑，不碰真库。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { consciousnessBlock } from '../index.js'
import { buildReplySystem } from '../src/model.js'
import { attachContextBlock, buildContextBlock, clampContextBlock } from '../src/features.js'
import { recall } from '../src/core.js'

const LIVE = path.join(os.homedir(), '.dsh', 'consciousness')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-realprompt-'))
for (const s of ['', '-wal', '-shm']) {
  const src = path.join(LIVE, 'app.db' + s)
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'app.db' + s))
}
const db = openDb(path.join(dir, 'app.db'))

const aid = db.prepare('SELECT id FROM agents ORDER BY last_interaction_at DESC LIMIT 1').get().id
attachContextBlock((d, id, opts) => consciousnessBlock(d, id, opts))

function count(hay, needle) { return hay.split(needle).length - 1 }

// 主人这一轮的 QQ 提示词
const text = '在吗，今天怎么样'
const pack = recall(db, aid, text, 6, 512)
const block = clampContextBlock(buildContextBlock(db, aid, { recall: pack.items }), 4000)
const sys = buildReplySystem({ text, pack: [], style: { tone: '可爱', address: '主人', catchphrase: '嗯哼' }, affect: { label: '挫败', intensity: 0.6 }, drive: { band: 'D2' }, contextBlock: block, isOwner: true })

console.log('=== 主人 QQ 提示词（' + sys.length + ' 字）===')
console.log(sys)
console.log('\n=== 重复检查 ===')
const checks = [
  ['包在最前面', sys.startsWith('【你此刻的意识体上下文')],
  ['「语气：」只出现一次', count(sys, '语气：') === 1],
  ['「口头禅」最多一次', count(sys, '口头禅') <= 1],
  ['「你称呼对方为」只出现一次', count(sys, '你称呼对方为') === 1],
  ['「主情绪是」不再另写', count(sys, '主情绪是') === 0],
  ['「需求缺口档位」只出现一次', count(sys, '需求缺口档位') === 1],
  ['记忆只来自这一轮召回', pack.items.length > 0 ? count(sys, '- ') >= pack.items.length : true],
  ['规则只有一条', count(sys, '按你自己的分寸说') === 1],
]
for (const [name, ok] of checks) console.log((ok ? 'OK   ' : 'FAIL ') + name)

// 陌生人这一轮
const g = buildReplySystem({ text: '你好', pack: [], style: { tone: '可爱', address: '主人' }, contextBlock: '', isOwner: false })
console.log('\n=== 陌生人 QQ 提示词 ===')
console.log(g)
console.log('\n陌生人里出现「主人」次数：', count(g, '主人'))

db.close()
fs.rmSync(dir, { recursive: true, force: true })
