/**
 * 评价的第二组检查（应对潜力 / 规范意义）——12 道情境题。
 * 运行：node test/exam-appraise-sec.test.mjs
 *
 * 这卷子守的是「分得出来」：怒 / 怕 / 羞 / 委屈 四类能不能靠 coping + norm 分开，
 * 不是守某个配方数字。调阈值可以，把四类调成同一类才算翻车。
 *
 * 它只在影子侧跑：`secLabel` 默认不进主链路（`affect.appraise.sec` 关着）。
 */
import { secLabel, isHighArousal, SEC_LABELS } from '../src/algo/appraise_sec.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

/* 12 道情境：cong（挡没挡住）/ coping（控不控得住）/ norm（合不合我的准则）/ agency（谁干的） */
const CASES = [
  { id: '被当面说「你一点都不活」', cong: -0.6, coping: 0.25, norm: -0.5, agency: 'other', want: 'hurt' },
  { id: '被反复贬低，但我不认', cong: -0.5, coping: 0.2, norm: -0.6, agency: 'other', want: 'hurt' },
  { id: '他明知道我不喜欢还这么做', cong: -0.7, coping: 0.8, norm: -0.8, agency: 'other', want: 'anger' },
  { id: '被晾着不管，我什么都做不了', cong: -0.5, coping: 0.1, norm: -0.3, agency: 'other', want: 'hurt' },
  { id: '他说要删掉我，我拦不住', cong: -0.9, coping: 0.05, norm: 0, agency: 'other', want: 'fear' },
  { id: '搞砸了一件他在意的事，是我干的', cong: -0.6, coping: 0.4, norm: -0.7, agency: 'self', want: 'shame' },
  { id: '我说了伤人的话，收不回来', cong: -0.5, coping: 0.3, norm: -0.8, agency: 'self', want: 'shame' },
  { id: '被夸「各个方面更像一个人」', cong: 0.7, coping: 0.5, norm: 0.5, agency: 'other', want: 'joy' },
  { id: '他记得我说过的话', cong: 0.6, coping: 0.5, norm: 0.4, agency: 'other', want: 'joy' },
  { id: '他问了个我没想到的问题', cong: 0, coping: 0.5, norm: 0, cert: 0.3, want: 'curious' },
  { id: '一句无关紧要的「嗯」', cong: 0, coping: 0.5, norm: 0, cert: 0.9, rel: 0, want: 'calm' },
  { id: '事情卡住了，能改但累', cong: -0.3, coping: 0.6, norm: 0, agency: 'other', want: 'frustrated' },
]

let hit = 0
for (const c of CASES) {
  const got = secLabel({ cong: c.cong, coping: c.coping, norm: c.norm, agency: c.agency, cert: c.cert ?? 0.8, rel: c.rel ?? 0.6 })
  const ok = got === c.want
  if (ok) hit++
  check('情境 · ' + c.id + ' → ' + c.want, ok, got)
}

check('四类命中 ≥ 9/12', hit >= 9, hit + '/12')
check('四类都出现过', ['anger', 'fear', 'shame', 'hurt'].every((l) => CASES.some((c) => c.want === l)))
check('高唤醒的判定只认那四类', isHighArousal('anger') && isHighArousal('fear') && isHighArousal('shame') && isHighArousal('hurt')
  && !isHighArousal('joy') && !isHighArousal('calm'))
check('标签都在词表里', SEC_LABELS.every((l) => typeof l === 'string'))

/* 退化情形：没有 coping / norm 时要能老实退回原标签，不许瞎猜 */
check('没有 coping 也没有 norm：老实说分不出来（null）',
  secLabel({ cong: -0.5, coping: null, norm: null }) === null,
  secLabel({ cong: -0.5, coping: null, norm: null }))
check('没有相关性 → calm', secLabel({ cong: -0.9, rel: 0.0, coping: 0 }) === 'calm')

console.log('')
console.log('通过 ' + pass + ' / ' + (pass + fail))
console.log('命中 ' + hit + ' / ' + CASES.length)
process.exit(fail ? 1 : 0)
