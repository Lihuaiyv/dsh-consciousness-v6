/**
 * 三观进对话的契约：页和预览仍是命题句；系统提示不念引子。
 * 闲聊没有命题原文。这句话碰上了，才多出一条做法。
 * 运行：node test/sangguan-s12-prompt.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 1200)) }
}
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg12p-'))
process.env.DSH_HOME = home

const CREED = /你对世界的基本看法|你的人生观|你更看重|你看重：|鱼格倾向|亲近 |可以说到|你还没想定|两样你都要|你给自己这一程/

try {
  const cur = await import(pathToFileURL(path.join(root, 'index.js')).href + '?c=' + Date.now())
  const handlers = {}
  const sections = []
  const child = {
    effect: (f) => { f(); return () => {} },
    systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
    webServer: { register: () => () => {} },
  }
  cur.apply({
    on: (n, fn) => { handlers[n] = fn },
    inject: (deps, fn) => {
      if (deps.includes('systemPrompt')) fn(child)
      else if (deps.includes('webServer')) fn({ effect: child.effect, webServer: child.webServer })
    },
    effect: (f) => f(),
  })
  const { openDb } = await import('../src/db.js')
  const { setSangguanConfig } = await import('../src/modules/sangguan/config.js')
  const { append } = await import('../src/modules/sangguan/ledger.js')
  const { injectView } = await import('../src/modules/sangguan/inject.js')
  const db = openDb(path.join(home, 'consciousness', 'app.db'))
  const now = new Date().toISOString()
  const aid = 'agt_p'
  db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(aid, '小比', 'daily', 'active', now)
  // schema 12 起提示词按会话绑定取人：没有绑定就不挑兜底实例，测试必须先绑一段会话
  const { bindSession } = await import('../src/modules/binding.js')
  bindSession(db, aid, 'sess_p')
  db.prepare('INSERT INTO persona_worldview(agent_id,key,weight,evidence,updated_at) VALUES(?,?,?,?,?)').run(aid, 'safe', 0.2, '[]', now)
  db.prepare('INSERT INTO relations(id,agent_id,name,kind,closeness,trust,dependence,root,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('rel_p', aid, '阿宁', 'stranger', 0.1, 0.1, 0.05, 0, now, now)
  db.prepare(`INSERT INTO memory_items(id,agent_id,type,mark,text,source,w0,weight,stability,difficulty,
      last_decay_at,valid_at,invalid_at,status,created_at,deleted_at,version)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('mem_p', aid, 'fact', 'normal', '用户养了一只橘猫', 'manual', 0.5, 0.9, 1, 5, now, null, null, 'active', now, null, 1)

  const text = () => String(sections[0].text({ agent: { id: 'sess_p' } }) || '')
  const idle = text()
  check('闲聊提示里有人和记忆', idle.includes('小比') && idle.includes('橘猫'), idle.slice(0, 240))
  check('闲聊提示带关系分寸和文体约束', idle.includes('关系：阿宁') && idle.includes('现在：') && idle.includes('不要列点'), idle)
  check('关系行点出对方是谁，也给边界', idle.includes('阿宁') && idle.includes('可以说到'), idle)

  const rawPre = handlers['agent/pre-step']
  const pre = (payload, next) => rawPre({ ...payload, agent: { id: 'sess_p' } }, next)
  await pre({ messages: [{ role: 'user', content: '这件事还没发生，会不会出事' }] }, () => {})
  const danger = text()
  check('每轮都回到同一个身份，不拼出未定义', danger.includes('意识体：小比') && !danger.includes('undefined'), danger)
  await pre({ messages: [{ role: 'user', content: '今天天气不错' }] }, () => {})
  const chat = text()
  check('下一句闲聊不残留上一轮召回', !chat.includes('会不会出事') && chat.includes('小比'), chat)

  setSangguanConfig(db, aid, { enabled: true, inject: 'shadow' })
  append(db, aid, [{ type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at: now, payload: { claims: [{ layer: 'W', kind: 'belt', text: '认真听比急着答更有用', origin: 'extract' }] } }])
  append(db, aid, [{ type: 'CLAIM_EXP', layer: 'V', actor: 'sys', at: now, payload: { claims: [{ layer: 'V', kind: 'norm', text: '答应的事要做到', origin: 'extract' }] } }])
  const preview = injectView(db, aid, { now, cache: false })
  check('预览仍是命题句', preview.text.includes('你对世界的基本看法：认真听比急着答更有用') && preview.text.includes('你更看重：答应的事要做到'), preview.text)
  await pre({ messages: [{ role: 'user', content: '你答应的事要做到啊' }] }, () => {})
  const shadow = text()
  check('shadow 的聊天提示不提前念命题', !shadow.includes('答应的事要做到') && !shadow.includes('认真听'), shadow)
  setSangguanConfig(db, aid, { inject: 'live' })
  await pre({ messages: [{ role: 'user', content: '你答应的事要做到啊' }] }, () => {})
  const live = text()
  check('live 把命题写成自己的看法', live.includes('你更看重：答应的事要做到。') || live.includes('你对世界的基本看法：认真听比急着答更有用。'), live)
  check('live 不把内部术语漏进提示词', !/κ|金巴|KAPPA|π=|θ/.test(live), live)
  await pre({ messages: [{ role: 'user', content: '今天天气不错' }] }, () => {})
  check('live 闲聊仍守住身份与命题尺度', text().includes('意识体：小比') && !/κ|KAPPA/.test(text()))
} catch (e) {
  check('比对跑完', false, String((e && e.stack) || e))
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
process.exit(fail ? 1 : 0)
