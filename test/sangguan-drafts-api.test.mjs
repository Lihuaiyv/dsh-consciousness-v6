/**
 * 三观 · 草稿与三列接口（P4）：权限 / 闸 / 入库写账本 / 召回与注入带 query / status 新字段。
 * 运行：node test/sangguan-drafts-api.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sgapi-'))
process.env.DSH_HOME = home
const { openDb } = await import('../src/db.js')
const api = await import('../src/api.js')
const { loadState } = await import('../src/modules/sangguan/projection.js')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 700)) }
}
const db = openDb(path.join(home, 'app.db'))
let keyn = 0
const call = (method, p, body, token = 'user') => {
  const b = { ...(body || {}) }
  if (method !== 'GET') b.__idempotencyKey = 'k' + (++keyn)
  return api.handle(db, { method, path: p, token, body: b })
}
const sg = (aid, p) => '/v1/agents/' + aid + '/sangguan' + p

const mk = async (name) => (await call('POST', '/v1/agents', { name, __idempotencyKey: 'mk-' + name })).body.id
const aid = await mk('草稿接口')
await call('PUT', sg(aid, '/config'), { enabled: true, lanes: { W: true } })

// ---------- 手写草稿：建 → 闸没过 → 改 → 入库 ----------
const mkDraft = async (body, token = 'user') => call('POST', sg(aid, '/drafts'), body, token)
const base = {
  text: '数据不对就从头再跑，哪怕你在催',
  alt: '', foregone: '', exclusion: '', boundary: [], vouch: false,
  evidence: [{ at: '2026-11-01', quote: '你说「别糊弄，重跑」' }],
}
let r = await mkDraft(base)
check('建草稿：200 且带 gates', r.status === 200 && r.body.draft && r.body.draft.gates, r.body)
const id = r.body.draft.id
check('建草稿：闸没过（缺另一条路/代价/排除/我认）', r.body.draft.gates.pass === false, r.body.draft.gates)
check('建草稿：source=manual', r.body.draft.source === 'manual')

r = await call('POST', sg(aid, '/drafts/' + id + '/commit'), {})
check('入库：闸没过 → 409', r.status === 409 && r.body.error.code === 'TRANSITION', r.body)

r = await call('POST', sg(aid, '/drafts/' + id + '/patch'), { alt: '按趋势补个数先交', foregone: '多花两天', exclusion: '不会拿一个大概对的数交差', vouch: true })
check('改草稿：200，闸补全', r.status === 200 && r.body.draft.gates.pass === true, r.body)
check('改草稿：状态 edited', r.body.draft.status === 'edited')

r = await call('POST', sg(aid, '/drafts/' + id + '/commit'), {})
check('入库：过了 → 200', r.status === 200 && r.body.ok && /^cl_/.test(r.body.claim_id), r.body)
const s = loadState(db, aid)
const c = s.claims[r.body.claim_id]
check('入库：账本里是 V/norm，origin=user', c && c.layer === 'V' && c.kind === 'norm' && c.origin === 'user', c)
check('入库：草稿状态 committed 且带 claim_id', r.body.draft.status === 'committed' && r.body.draft.claim_id === r.body.claim_id)

// 再点一次入库：不能先落一条重复命题再报错
const vBefore = Object.values(loadState(db, aid).claims).filter((x) => x.layer === 'V').length
r = await call('POST', sg(aid, '/drafts/' + id + '/commit'), {})
const vAfter = Object.values(loadState(db, aid).claims).filter((x) => x.layer === 'V').length
check('入库：同一条不能入库两次（409）', r.status === 409 && r.body.error.code === 'TRANSITION', r.body)
check('入库：第二次没有偷偷多写一条命题', vAfter === vBefore, { vBefore, vAfter })

r = await call('GET', sg(aid, '/drafts'), null, 'viewer')
check('列表：默认不列已入库的', r.status === 200 && !r.body.drafts.some((d) => d.id === id), r.body)
r = await call('GET', sg(aid, '/drafts?status=committed'), null, 'viewer')
check('列表：按状态能查到已入库', r.body.drafts.length === 1 && r.body.drafts[0].id === id, r.body.drafts)

// ---------- 权限与重复 ----------
r = await mkDraft({ ...base, text: '答应了的事就要做完，哪怕拖到很晚' }, 'viewer')
check('权限：viewer 不能建草稿', r.status === 403, r.body)

const dup = await mkDraft(base)
check('重复：同文 30 天内判 duplicate', dup.status === 200 && dup.body.duplicate === true, dup.body)

r = await call('POST', sg(aid, '/drafts/dr_nope/patch'), { text: '随便改改看' })
check('改不存在的：404', r.status === 404, r.body)
r = await call('GET', sg(aid, '/drafts/dr_nope'), null, 'viewer')
check('查不存在的：404', r.status === 404, r.body)

// ---------- 丢弃 ----------
const d2 = await mkDraft({ ...base, text: '说话算话，答应的事不拖到明天' })
r = await call('POST', sg(aid, '/drafts/' + d2.body.draft.id + '/discard'), {})
check('丢弃：200 且状态 discarded', r.status === 200 && r.body.draft.status === 'discarded', r.body)
r = await call('POST', sg(aid, '/drafts/' + d2.body.draft.id + '/discard'), {})
check('丢弃：不能丢两次', r.status === 409, r.body)

// ---------- 正在起草时再起一轮 → 409 ----------
const { setFlag } = await import('../src/kernel.js')
setFlag(db, 'sangguan.draftjob:' + aid, JSON.stringify({ status: 'running', started_at: new Date().toISOString() }))
r = await call('POST', sg(aid, '/drafts/generate'), {})
check('起草：跑着的时候再点 → 409', r.status === 409 && r.body.error.code === 'ALREADY_RUNNING', r.body)

// ---------- 三列：status / lanes / 召回 / 注入 ----------
r = await call('POST', sg(aid, '/seed'), { layer: 'W', text: '世界大体可以被理解' })
check('种一句世界观：200', r.status === 200, r.body)
const wId = r.body.claim_id

// 给 L 一点投入证据：一天 5 个回合
for (let i = 0; i < 5; i++) {
  db.prepare(`INSERT INTO raw_turns(id, agent_id, session_id, seq, role, text, created_at, day)
    VALUES(?,?,?,?,?,?,?,?)`).run('rt' + i, aid, 's1', i, 'assistant', '在。', '2026-11-02T10:0' + i + ':00.000Z', '2026-11-02')
}

r = await call('GET', sg(aid, '/status'), null, 'viewer')
check('status：带上 lanes', r.body.lanes && r.body.lanes.W === true && r.body.lanes.L === false, r.body.lanes)
check('status：带上常驻宪章', Array.isArray(r.body.constitution.lines) && r.body.constitution.lines.some((l) => l.includes('世界大体可以被理解')), r.body.constitution)
check('status：带上草稿计数', r.body.drafts && typeof r.body.drafts.pending === 'number' && 'job' in r.body.drafts, r.body.drafts)

r = await call('GET', sg(aid, '/lanes'), null, 'viewer')
check('lanes：三列读数都在', r.body.stats && r.body.stats.W && r.body.stats.L && r.body.stats.V, r.body)
check('lanes：L 的投入天数取自真回合', r.body.stats.L.invest_days === 1, r.body.stats.L)
check('lanes：V 的入库数对得上', r.body.stats.V.committed === 1, r.body.stats.V)

r = await call('GET', sg(aid, '/recall?text=' + encodeURIComponent('世界能讲理吗')), null, 'viewer')
check('召回：核心带上这一句', r.status === 200 && r.body.core.some((x) => x.id === wId), r.body)

r = await call('GET', sg(aid, '/inject/preview?text=' + encodeURIComponent('世界能讲理吗')), null, 'viewer')
check('注入预览：三列取法带上常驻行', r.status === 200 && String(r.body.view.text).includes('你看世界的方式：世界大体可以被理解'), r.body.view)

r = await call('GET', sg(aid, '/config'), null, 'viewer')
check('config：回显 lanes', r.body.config.lanes && r.body.config.lanes.W === true, r.body.config)

// 关闭时：GET 只回 enabled:false
await call('PUT', sg(aid, '/config'), { enabled: false })
r = await call('GET', sg(aid, '/drafts'), null, 'viewer')
check('关掉：drafts 只回 enabled:false', r.status === 200 && r.body.enabled === false && !r.body.drafts, r.body)

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
