/**
 * 三观 S13 · 用户裁决 + r_J、整 agent 清除（拍板 2）、/v1/agents/:id/sangguan/* 接口。全部离线。
 * 运行：node test/sangguan-s13.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg13-'))
process.env.DSH_HOME = home
const { openDb } = await import('../src/db.js')
const { setFlag, getFlag } = await import('../src/kernel.js')
const { append, newId, readEvents, lastSeq } = await import('../src/modules/sangguan/ledger.js')
const { loadState } = await import('../src/modules/sangguan/projection.js')
const { setSangguanConfig } = await import('../src/modules/sangguan/config.js')
const { L0_TABLES, PROJ_TABLES, ensureSangguanSchema } = await import('../src/modules/sangguan/schema.js')
const { verdict, rJOf, VERDICT_DAILY } = await import('../src/modules/sangguan/verdict.js')
const { purgeAgent } = await import('../src/modules/sangguan/purge.js')
const { runWeek } = await import('../src/modules/sangguan/night.js')
const { injectView } = await import('../src/modules/sangguan/inject.js')
const { purgeExpired } = await import('../src/modules/ops.js')
const api = await import('../src/api.js')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 900)) }
}
const db = openDb(path.join(home, 'app.db'))
const DAY = 86400000
let clock = Date.parse('2026-11-02T08:00:00.000Z')
const tick = (min = 1) => new Date((clock += min * 60000)).toISOString()
const put = (aid, evs, expect) => append(db, aid, evs, expect)
const KIND = { W: 'belt', L: 'chapter', V: 'norm' }
const mk = (aid, layer, text, actor = 'sys') => put(aid, [{
  type: 'CLAIM_EXP', layer, actor, at: tick(), payload: { claims: [{ layer, kind: KIND[layer], text, origin: 'extract' }] },
}]).entities.claims[0]
const codeOf = (fn) => { try { fn(); return null } catch (e) { return e.code || String(e.message) } }
const addAgent = (id) => db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(id, id, 'daily', 'paused', new Date().toISOString())

// ---------- 裁决 ----------
const aid = 'agt_s13'
addAgent(aid)
const c1 = mk(aid, 'W', '人多数时候愿意讲道理')
check('关闭时裁决：OFF', codeOf(() => verdict(db, aid, { target_type: 'claim', target_id: c1, sign: 1 }, tick())) === 'OFF')
setSangguanConfig(db, aid, { enabled: true })
check('参数不全：INVALID', codeOf(() => verdict(db, aid, { target_type: 'claim', target_id: c1, sign: 0 }, tick())) === 'INVALID')
check('目标不存在：NOT_FOUND', codeOf(() => verdict(db, aid, { target_type: 'claim', target_id: 'cl_nope', sign: 1 }, tick())) === 'NOT_FOUND')
const dead = mk(aid, 'W', '被推翻的旧看法')
put(aid, [{ type: 'CON', layer: 'W', actor: 'sys', at: tick(), payload: { claim_id: dead } }])
check('终态命题：TERMINAL', codeOf(() => verdict(db, aid, { target_type: 'claim', target_id: dead, sign: 1 }, tick())) === 'TERMINAL')
{
  const pi0 = loadState(db, aid).claims[c1].pi
  const r = verdict(db, aid, { target_type: 'claim', target_id: c1, sign: 1, note: '我同意' }, tick())
  const e = readEvents(db, aid, { types: ['EVIDENCE'] }).pop()
  const x = e.payload.evidence[0]
  check('裁决落账：actor user、kind verdict、权重 w_verdict', r.counted && e.actor === 'user' && x.kind === 'verdict' && x.weight === 1 && x.ref.includes('我同意'), e)
  check('裁决推动 π', loadState(db, aid).claims[c1].pi > pi0)
  const n0 = lastSeq(db, aid)
  const r2 = verdict(db, aid, { target_type: 'claim', target_id: c1, sign: -1 }, tick())
  check('同目标同日第 ' + (VERDICT_DAILY + 1) + ' 次：不计、不写', !r2.counted && r2.reason === 'daily_cap' && lastSeq(db, aid) === n0, r2)
  clock += DAY
  check('次日可再裁决', verdict(db, aid, { target_type: 'claim', target_id: c1, sign: -1 }, tick()).counted)
}
{
  const at = tick()
  const nid = newId('nus', at)
  put(aid, [{ type: 'NU_REGISTER', actor: 'judge', at, payload: { nus: [{ id: nid, claim_id: c1, expect: '他会讲理', observe: '下次争执', p: 0.6, due_at: new Date(clock + 7 * DAY).toISOString() }] } }])
  const r = verdict(db, aid, { target_type: 'nu', target_id: nid, sign: 1 }, tick())
  check('对预见裁决：写 nu 证据', r.counted && readEvents(db, aid, { types: ['EVIDENCE'] }).pop().payload.evidence[0].target_type === 'nu')
  put(aid, [{ type: 'NU_RESOLVE', actor: 'sys', at: tick(), payload: { nu_id: nid, outcome: 'hit' } }])
  check('已结算的预见：TERMINAL', codeOf(() => verdict(db, aid, { target_type: 'nu', target_id: nid, sign: 1 }, tick())) === 'TERMINAL')
}
{
  const w = mk(aid, 'W', '天气会影响人的判断')
  const inq = put(aid, [{ type: 'INQUIRY', layer: 'W', actor: 'judge', at: tick(), payload: { target_type: 'claim', target_id: w, mode: 'ask', question: '你觉得天气影响你吗' } }]).ids[0]
  check('回答前：提问在注入里', injectView(db, aid, { now: tick(), cache: false }).extra.some((l) => l.includes('天气影响你吗')))
  verdict(db, aid, { target_type: 'claim', target_id: w, sign: 1, inquiry_id: inq }, tick())
  const ans = readEvents(db, aid, { types: ['INQUIRY'] }).pop()
  check('带 inquiry_id：同批写 INQUIRY answer_of', ans.actor === 'user' && ans.payload.answer_of === inq)
  check('回答后：提问不再注入', !injectView(db, aid, { now: tick(), cache: false }).extra.some((l) => l.includes('天气影响你吗')))
}

// ---------- r_J ----------
{
  const a2 = 'agt_s13_rj'
  setSangguanConfig(db, a2, { enabled: true })
  const js = []
  for (let i = 0; i < 9; i++) js.push(put(a2, [{ type: 'CLAIM_EXP', layer: 'V', actor: 'judge', at: tick(), payload: { claims: [{ layer: 'V', kind: 'norm', text: '判定出的看法' + i, origin: 'extract' }] } }]))
  check('判定 < 10 次：r_J 不给值', rJOf(db, a2, tick()) === null)
  js.push(put(a2, [{ type: 'CLAIM_EXP', layer: 'V', actor: 'judge', at: tick(), payload: { claims: [{ layer: 'V', kind: 'norm', text: '判定出的看法9', origin: 'extract' }] } }]))
  check('10 次判定、无覆盖：r_J = 1', rJOf(db, a2, tick()) === 1)
  for (let i = 0; i < 3; i++) verdict(db, a2, { target_type: 'claim', target_id: js[i].entities.claims[0], sign: -1, override_of: js[i].ids[0] }, tick())
  const rj = rJOf(db, a2, tick())
  check('3 次用户覆盖 / 10 次判定：r_J = 0.7', rj === 0.7, rj)
  const wk = await runWeek(db, a2, tick(), { job: false, doubt: false, balance: false, elev: false })
  check('慢环：r_J < 0.8 → 调 N_delib（判定不可靠就少审议）', wk.l5.adjust.some((a) => a.key === 'N_delib'), wk.l5.adjust)
  clock += 31 * DAY
  check('30 日窗外：r_J 不给值', rJOf(db, a2, tick()) === null)
}

// ---------- 清除（拍板 2） ----------
function seedAgent(id) {
  addAgent(id)
  setSangguanConfig(db, id, { enabled: true })
  const a = mk(id, 'W', id + ' 的看法甲')
  const b = mk(id, 'W', id + ' 的看法乙')
  const at = tick()
  const qid = newId('questions', at)
  put(id, [{ type: 'KAPPA_OPEN', layer: 'W', actor: 'judge', at, payload: { questions: [{ id: qid, layer: 'W', text: '问' }], kappas: [{ layer: 'W', q_id: qid, pos_id: a, neg_id: b, dep: 'd', excl: 'e' }] } }])
  put(id, [{ type: 'EVIDENCE', actor: 'user', at: tick(), payload: { evidence: [{ kind: 'act', target_type: 'claim', target_id: a, sign: 1, weight: 0.6, ref: 'r' }] } }])
  setFlag(db, 'sangguan.budget:' + id + ':2026-11-02', '{}')
  setFlag(db, 'sangguan.judge:' + id, '[]')
  setFlag(db, 'sangguan.inject:' + id, '{}')
  setFlag(db, 'sangguan.fast.buf:' + id, '[]')
}
const count = (id) => Object.fromEntries([...L0_TABLES, ...PROJ_TABLES].map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE agent_id=?`).get(id).n]))
const total = (o) => Object.values(o).reduce((a, b) => a + b, 0)
{
  const A = 'agt_pA'
  const B = 'agt_pA_x' // 前缀相同：LIKE / 前缀误删会伤到它
  seedAgent(A)
  seedAgent(B)
  const b0 = count(B)
  // 没行可删时触发器不触发，只看有数据的表
  const filled = L0_TABLES.filter((t) => db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE agent_id=?`).get(A).n > 0)
  const threw = filled.filter((t) => codeOf(() => db.prepare(`DELETE FROM ${t} WHERE agent_id=?`).run(A))).length
  check('平时 DELETE：有数据的 L0 表全部拒绝', filled.length >= 5 && threw === filled.length, { filled, threw })
  check('平时 UPDATE：仍拒绝', !!codeOf(() => db.prepare('UPDATE claim_events SET type=type WHERE agent_id=?').run(A)))
  const r = purgeAgent(db, A)
  check('purgeAgent：目标 agent 的 L0 + 投影清零', total(count(A)) === 0, count(A))
  check('purgeAgent：返回删除行数', r.claim_events >= 4 && r.persona_claims === 2 && r.flags >= 5, r)
  check('purgeAgent：别的 agent（同前缀）一行不少', JSON.stringify(count(B)) === JSON.stringify(b0))
  check('purgeAgent：目标的三观 flags 全清', ['sangguan:', 'sangguan.judge:', 'sangguan.inject:', 'sangguan.fast.buf:'].every((k) => getFlag(db, k + A) === null) && getFlag(db, 'sangguan.budget:' + A + ':2026-11-02') === null)
  check('purgeAgent：别的 agent 的 flags 还在', getFlag(db, 'sangguan:' + B) !== null && getFlag(db, 'sangguan.budget:' + B + ':2026-11-02') !== null)
  check('purgeAgent：不残留清除标记', db.prepare('SELECT COUNT(*) n FROM claim_purge').get().n === 0)
  check('清除后：对别的 agent 的 DELETE 依旧拒绝', !!codeOf(() => db.prepare('DELETE FROM claim_events WHERE agent_id=?').run(B)))
  db.exec('SAVEPOINT t1')
  db.prepare('INSERT INTO claim_purge(agent_id) VALUES(?)').run(B)
  const upd = codeOf(() => db.prepare('UPDATE persona_claims SET text=? WHERE agent_id=?').run('改', B))
  db.exec('ROLLBACK TO t1'); db.exec('RELEASE t1')
  check('就算有清除标记：UPDATE 仍拒绝', !!upd)
  check('再清一次空 agent：无副作用', total(purgeAgent(db, A)) === 0)
}
{
  // 旧库：删除触发器没有豁免 → ensureSangguanSchema 升级
  const old = openDb(path.join(home, 'old.db'))
  for (const t of L0_TABLES) {
    old.exec(`DROP TRIGGER trg_${t}_no_delete`)
    old.exec(`CREATE TRIGGER trg_${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, '旧版'); END;`)
  }
  append(old, 'agt_old', [{ type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at: tick(), payload: { claims: [{ layer: 'W', kind: 'belt', text: '旧库命题', origin: 'extract' }] } }])
  check('旧触发器：清除被挡（整体回滚）', !!codeOf(() => purgeAgent(old, 'agt_old')) && old.prepare("SELECT COUNT(*) n FROM claim_events WHERE agent_id='agt_old'").get().n === 1 && old.prepare('SELECT COUNT(*) n FROM claim_purge').get().n === 0)
  ensureSangguanSchema(old)
  const sql = old.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_claim_events_no_delete'").get().sql
  check('升级：删除触发器换成带豁免的新版', sql.includes('claim_purge'))
  check('升级后：平时 DELETE 仍拒绝', !!codeOf(() => old.prepare("DELETE FROM claim_events WHERE agent_id='agt_old'").run()))
  purgeAgent(old, 'agt_old')
  check('升级后：清除成功', old.prepare("SELECT COUNT(*) n FROM claim_events WHERE agent_id='agt_old'").get().n === 0)
  ensureSangguanSchema(old)
  check('升级幂等：再跑一次不出错、触发器仍在', old.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_%_no_delete'").get().n === L0_TABLES.length)
  old.close()
}
{
  const C = 'agt_pC'
  seedAgent(C)
  db.prepare("UPDATE agents SET status='soft_deleted', deleted_at=? WHERE id=?").run(new Date(Date.now() - 8 * DAY).toISOString(), C)
  const out = purgeExpired(db)
  check('ops.purgeExpired：软删满 7 天 → 三观账本一并清除', out.agents >= 1 && total(count(C)) === 0 && getFlag(db, 'sangguan:' + C) === null, { out, left: count(C) })
  check('ops.purgeExpired：其他 agent 不受影响', total(count('agt_pA_x')) > 0 && total(count(aid)) > 0)
}

// ---------- 接口 ----------
let kseq = 0
const call = (method, p, body, token = 'user') => api.handle(db, { method, path: '/v1/agents/' + p, token, body: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? { __idempotencyKey: 'k' + (++kseq), ...(body || {}) } : (body || {}) })
{
  const off = 'agt_s13_api_off'
  addAgent(off)
  mk(off, 'W', '关着也有的命题')
  const meta0 = db.prepare('SELECT COUNT(*) n FROM claim_proj_meta WHERE agent_id=?').get(off).n
  const st = await call('GET', off + '/sangguan/status')
  check('关闭：status 回 enabled:false + 配置', st.status === 200 && st.body.enabled === false && st.body.config.inject === 'shadow', st)
  const hd = await call('GET', off + '/sangguan/heads')
  check('关闭：数据 GET 只回 { enabled:false }', hd.status === 200 && JSON.stringify(hd.body) === '{"enabled":false}', hd)
  check('关闭：数据 GET 不碰投影', db.prepare('SELECT COUNT(*) n FROM claim_proj_meta WHERE agent_id=?').get(off).n === meta0)
  const vd = await call('POST', off + '/sangguan/verdict', { target_type: 'claim', target_id: 'x', sign: 1 })
  check('关闭：写接口 409 OFF', vd.status === 409 && vd.body.error.code === 'OFF', vd)
}
{
  const A = 'agt_s13_api'
  addAgent(A)
  const x = mk(A, 'W', '认真听比急着答更有用')
  const y = mk(A, 'W', '先给答案再慢慢听')
  const at = tick()
  const qid = newId('questions', at)
  put(A, [{ type: 'KAPPA_OPEN', layer: 'W', actor: 'judge', at, payload: { questions: [{ id: qid, layer: 'W', text: '该先听还是先答' }], kappas: [{ layer: 'W', q_id: qid, pos_id: x, neg_id: y, dep: 'd', excl: 'e' }] } }])
  mk(A, 'V', '答应的事要做到')
  const vw = await call('PUT', A + '/sangguan/config', { enabled: true }, 'viewer')
  check('viewer 不能改设置', vw.status === 403)
  const nokey = await api.handle(db, { method: 'PUT', path: '/v1/agents/' + A + '/sangguan/config', token: 'user', body: { enabled: true } })
  check('写接口没有幂等键：400', nokey.status === 400)
  const on = await call('PUT', A + '/sangguan/config', { enabled: true, model: { light: { url: 'https://example.com/v1', key: 'sk-secret-123', model: 'm' } } })
  check('user 打开三观', on.status === 200 && on.body.config.enabled === true, on)
  check('配置不外泄端点 key', on.body.config.model.light.has_key === true && !JSON.stringify(on.body).includes('sk-secret'), on.body)
  const live = await call('PUT', A + '/sangguan/config', { inject: 'live' })
  check('影子期未满切 live：409 SHADOW_NOT_READY', live.status === 409 && live.body.error.code === 'SHADOW_NOT_READY', live.body)
  const force = await call('PUT', A + '/sangguan/config', { inject: 'live', force: true })
  check('带 force 可切 live', force.status === 200 && force.body.config.inject === 'live')
  const bad = await call('PUT', A + '/sangguan/config', { inject: 'auto' })
  check('非法 inject：400', bad.status === 400)
  const seq0 = lastSeq(db, A)
  const gets = ['status', 'heads', 'heads?layer=W&all=1', 'claims/' + x + '/chain', 'claims/' + x + '/explain?polish=0', 'kappa', 'kappa?open=1',
    'deliberations/active', 'precedents', 'predictions', 'events?limit=2', 'timeline?days=30', 'epochs', 'summaries', 'liveness', 'vitals',
    'inject/preview', 'elev', 'candidates', 'config']
  const res = {}
  for (const g of gets) res[g] = await call('GET', A + '/sangguan/' + g)
  const bads = Object.entries(res).filter(([, r]) => r.status !== 200).map(([g, r]) => [g, r.body])
  check('全部 GET 200', !bads.length, bads)
  check('GET 只读：账本 seq 不变', lastSeq(db, A) === seq0)
  check('status：分层计数 + 注入就绪 + 预算 + Qi', res.status.body.counts.claims.W.contested === 2 && res.status.body.inject.mode === 'live' && res.status.body.budget.pools.mid && typeof res.status.body.qi.qi === 'number', res.status.body)
  check('heads：带原文与 π', res.heads.body.layers.V[0].text === '答应的事要做到' && 'pi' in res.heads.body.layers.V[0], res.heads.body)
  check('chain：命题 + 涉及事件 + 矛盾', res['claims/' + x + '/chain'].body.claim.id === x && res['claims/' + x + '/chain'].body.kappas.length === 1 && res['claims/' + x + '/chain'].body.events.length >= 2)
  check('explain?polish=0：模板句', res['claims/' + x + '/explain?polish=0'].body.sentence.includes('认真听比急着答更有用'))
  check('kappa：两极原文 + 问题', res.kappa.body.kappas[0].q === '该先听还是先答' && res.kappa.body.kappas[0].pos.text.includes('认真听'))
  check('deliberations/active：在争的矛盾', res['deliberations/active'].body.kappas.length === 1)
  const ev1 = res['events?limit=2'].body
  check('events 分页：倒序 2 条 + next_before', ev1.events.length === 2 && ev1.events[0].seq > ev1.events[1].seq && ev1.next_before === ev1.events[1].seq, ev1)
  const ev2 = (await call('GET', A + '/sangguan/events?limit=2&before=' + ev1.next_before)).body
  check('events 翻页接得上', ev2.events.length >= 1 && ev2.events[0].seq < ev1.events[1].seq)
  check('events：带人话 word / about', ev1.events.every((e) => e.word && Array.isArray(e.about)))
  check('timeline：按日分组、人话', res['timeline?days=30'].body.days.length >= 1 && res['timeline?days=30'].body.days[0].events.some((e) => e.word === '发现两种看法冲突'), res['timeline?days=30'].body)
  check('inject/preview：视图 + 影子记录 + 就绪', res['inject/preview'].body.view && res['inject/preview'].body.ready && 'shadow_days' in res['inject/preview'].body.ready)
  const v1 = await call('POST', A + '/sangguan/verdict', { target_type: 'claim', target_id: x, sign: 1 })
  check('POST verdict：计入', v1.status === 200 && v1.body.counted === true, v1)
  const v2 = await call('POST', A + '/sangguan/verdict', { target_type: 'claim', target_id: x, sign: 1 })
  check('POST verdict 同日再来：不计', v2.status === 200 && v2.body.counted === false)
  const same = await api.handle(db, { method: 'POST', path: '/v1/agents/' + A + '/sangguan/verdict', token: 'user', body: { __idempotencyKey: 'k1-fixed', target_type: 'claim', target_id: y, sign: -1 } })
  const n1 = lastSeq(db, A)
  const again = await api.handle(db, { method: 'POST', path: '/v1/agents/' + A + '/sangguan/verdict', token: 'user', body: { __idempotencyKey: 'k1-fixed', target_type: 'claim', target_id: y, sign: -1 } })
  check('同一幂等键重放：同样结果、不重复写', same.status === 200 && JSON.stringify(same.body) === JSON.stringify(again.body) && lastSeq(db, A) === n1)
  const vbad = await call('POST', A + '/sangguan/verdict', { target_type: 'claim', target_id: 'cl_nope', sign: 1 })
  check('verdict 目标不存在：404', vbad.status === 404)
  const vv = await call('POST', A + '/sangguan/verdict', { target_type: 'claim', target_id: x, sign: 1 }, 'viewer')
  check('viewer 不能裁决', vv.status === 403)
  const vg = await call('GET', A + '/sangguan/status', null, 'viewer')
  check('viewer 能读', vg.status === 200 && vg.body.enabled === true)
  const el = await call('POST', A + '/sangguan/elev/ev_nope/approve', {})
  check('批准不存在的提案：404', el.status === 404)
  const nf = await call('GET', A + '/sangguan/nope')
  check('未知接口：404', nf.status === 404)
  const cl = await call('GET', A + '/sangguan/claims/cl_nope/chain')
  check('不存在的命题链：404', cl.status === 404)
  const other = await call('GET', A + '/sangguan/status', null, 'user:agt_other')
  check('绑定到别的 agent 的 token：404', other.status === 404)
  const ghost = await call('GET', 'agt_ghost/sangguan/status')
  check('agent 不存在：404', ghost.status === 404)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
