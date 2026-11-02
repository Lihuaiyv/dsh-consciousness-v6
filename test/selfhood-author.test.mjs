/**
 * 自我改写 P 通道：白名单、每天一条、30 天冷却、可回滚。
 * 运行：node test/selfhood-author.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { authorChange, rollbackAuthor, authorStats, authorTarget, isInterestPath, AUTHOR } from '../src/modules/self_author.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}
const at = new Date(2026, 10, 2, 15, 0, 0).getTime()
const toneOf = (w) => JSON.parse(w.db.prepare("SELECT value FROM persona WHERE agent_id=? AND path='style.tone'").get(w.aid).value)

function throwsCode(fn, code) {
  try { fn(); return { ok: false } } catch (e) { return { ok: e && e.code === code, code: e && e.code, message: e && e.message } }
}

// ---- 1. 白名单
{
  check('语气在名单里', !!authorTarget('style.tone'))
  check('口头禅在名单里', !!authorTarget('style.catchphrase'))
  check('兴趣在名单里', !!authorTarget('interest.sea'))
  check('称呼不在名单里', authorTarget('style.address') === null)
  check('理想自我卡不在名单里', authorTarget('style.card') === null)
  check('人格轴不在名单里', authorTarget('axis.ei') === null)
  check('兴趣命名有边界', isInterestPath('interest.sea') && !isInterestPath('interest.') && !isInterestPath('interest.a b'))
}

// ---- 2. 正常改一处
{
  const w = makeWorld()
  try {
    const before = toneOf(w)
    const out = authorChange(w.db, w.aid, { path: 'style.tone', value: '软一点', reason: '最近总在赶，想说得慢一点' }, at)
    check('改成功', out.ok === true && out.after === '软一点', out)
    check('persona 真变了', toneOf(w) === '软一点', toneOf(w))
    check('before 是旧值', out.before === before, out)
    const ch = w.db.prepare("SELECT * FROM changes WHERE id=?").get(out.id)
    check('changes 记了来源', ch && ch.source === 'self-authorship' && ch.actor === 'self', ch)
    check('有观察期', !!ch.observing_until, ch)
    check('events 有 self.change', w.db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='self.change'").get(w.aid).n === 1)
  } finally { w.close() }
}

// ---- 3. 每天一条
{
  const w = makeWorld()
  try {
    authorChange(w.db, w.aid, { path: 'style.tone', value: '软一点' }, at)
    const again = throwsCode(() => authorChange(w.db, w.aid, { path: 'style.catchphrase', value: '嗯' }, at + 3600000), 'AUTHOR_BUDGET')
    check('同一天第二次被挡', again.ok === true, again)
    const next = authorChange(w.db, w.aid, { path: 'style.catchphrase', value: '嗯' }, at + 86400000)
    check('第二天可以改另一个字段', next.ok === true, next)
  } finally { w.close() }
}

// ---- 4. 同字段 30 天冷却
{
  const w = makeWorld()
  try {
    authorChange(w.db, w.aid, { path: 'style.tone', value: '软一点' }, at)
    const cool = throwsCode(() => authorChange(w.db, w.aid, { path: 'style.tone', value: '再软一点' }, at + 86400000), 'AUTHOR_COOLDOWN')
    check('同字段 30 天内被挡', cool.ok === true, cool)
    const later = authorChange(w.db, w.aid, { path: 'style.tone', value: '再软一点' }, at + 31 * 86400000)
    check('过了 30 天可以再改', later.ok === true, later)
  } finally { w.close() }
}

// ---- 5. 越界值
{
  const w = makeWorld()
  try {
    check('空值拒绝', throwsCode(() => authorChange(w.db, w.aid, { path: 'style.tone', value: '   ' }, at), 'INVALID_ARGUMENT').ok === true)
    check('超长拒绝', throwsCode(() => authorChange(w.db, w.aid, { path: 'style.tone', value: '一句非常非常非常长的话' }, at), 'INVALID_ARGUMENT').ok === true)
    check('兴趣越界拒绝', throwsCode(() => authorChange(w.db, w.aid, { path: 'interest.sea', value: 2 }, at), 'INVALID_ARGUMENT').ok === true)
    const same = throwsCode(() => authorChange(w.db, w.aid, { path: 'style.tone', value: '可爱粘人' }, at), 'AUTHOR_SAME')
    check('改成一样拒绝', same.ok === true, same)
  } finally { w.close() }
}

// ---- 6. 回滚
{
  const w = makeWorld()
  try {
    const before = toneOf(w)
    const out = authorChange(w.db, w.aid, { path: 'style.tone', value: '软一点', reason: '试验' }, at)
    const rb = rollbackAuthor(w.db, w.aid, out.id)
    check('回滚成功', rb.ok === true, rb)
    check('语气读回原值', toneOf(w) === before, toneOf(w))
    check('changes 标了回滚时间', !!w.db.prepare('SELECT rolled_back_at FROM changes WHERE id=?').get(out.id).rolled_back_at)
    check('回滚事件留痕', w.db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='self.change.rolled_back'").get(w.aid).n === 1)
    const twice = throwsCode(() => rollbackAuthor(w.db, w.aid, out.id), 'CONFLICT')
    check('不能回滚两次', twice.ok === true, twice)
  } finally { w.close() }
}

// ---- 7. 统计
{
  const w = makeWorld()
  try {
    authorChange(w.db, w.aid, { path: 'interest.sea', value: 0.6, reason: '总想着看海' }, at)
    const s = authorStats(w.db, w.aid, at)
    check('统计到一条', s.total === 1 && s.fields.includes('persona.interest.sea'), s)
    check('兴趣值写进 persona', JSON.parse(w.db.prepare("SELECT value FROM persona WHERE agent_id=? AND path='interest.sea'").get(w.aid).value) === 0.6)
  } finally { w.close() }
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exit(1)
