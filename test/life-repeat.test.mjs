/**
 * 生活线续看：同一件事 7 天内最多 2 次；第二次只想想、不再抓同一批网页。
 * 运行：node test/life-repeat.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { lifeTick, pickLifeSubject } from '../src/modules/life.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 300)) }
}

const atDay = (h = 15) => new Date(2026, 10, 2, h, 0, 0).getTime()
const browseOk = async () => ({ items: [{ title: '看海攻略', url: 'https://example.com/sea', snippet: '海边风大。' }] })
const modelOk = { chat: async () => '海边风大，得带件外套。' }
const wake = (w, at) => w.db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(new Date(at - 60000).toISOString(), w.aid)

const w = makeWorld()
try {
  wake(w, atDay())
  let browsed = 0
  const browse = async () => { browsed++; return browseOk() }

  const out1 = await lifeTick(w.db, w.aid, { at: atDay(), browse, model: modelOk })
  check('第一次生活成功', out1.ok === true && out1.kind === 'interest', out1)
  check('第一次用了浏览', browsed === 1, browsed)

  const subj2 = pickLifeSubject(w.db, w.aid, atDay(16))
  check('第二次能选到同一件', !!subj2 && subj2.repeat === true, subj2)

  wake(w, atDay(16))
  // force 跳过「距上次太近」的真实时钟检查：这里测的是续看分支，不是闸
  const out2 = await lifeTick(w.db, w.aid, { at: atDay(16), force: true, browse, model: modelOk })
  check('续看不再浏览', browsed === 1, browsed)
  check('续看仍然成功', out2.ok === true, out2)

  const subj3 = pickLifeSubject(w.db, w.aid, atDay(17))
  check('第三次不再选同一件', !subj3 || subj3.subject_id !== subj2.subject_id, subj3)
} finally { w.close() }

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
