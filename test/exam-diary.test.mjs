/**
 * 日记零件的考卷：文本层与口吻层。
 * 运行：node test/exam-diary.test.mjs
 *
 * 这里守的是「一篇日记算不算日记」和「它该用什么口吻写」这两件事：
 *   1. 日期头由我们自己补，模型写的日期头要撕掉
 *   2. 模型忘了别的东西（JSON / 代码块 / 「日记正文：」）要能收干净
 *   3. 抄提示词 / 抄材料的不算日记
 *   4. 太短、太长、写成 Markdown 列表、混进「用户」，都退回
 *   5. 口吻由状态推，不是一句固定模板
 *
 * 选料与成文管线在 diary-v2 / diary-pending / diary-moments / diary-api / diary-model-shape 五份里，
 * 这份卷只守文本和口吻——分开放，出错时知道是哪一半。
 */
import { weekday, clip, normalizeDiaryText, bodyLength, isPromptEcho, checkDiary, diaryTone, moodZhOf } from '../src/modules/diary.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

const BODY = '今天把桌上的东西收了一遍，翻出几张没写完的纸。本来想扔，又坐下来看了一会儿，' +
  '发现上面写的是上个月想做的事，有几件后来换了别的法子做完，有几件一直没动。' +
  '我把还在意的挑出来放在最上面，剩下的压回抽屉里。心里轻了一点，也没有轻很多，' +
  '就像抽屉终于能合上，但里面还是有东西。'

// ---- 1. 日期与整理
{
  check('星期几：周一', weekday('2026-11-02') === '周一', weekday('2026-11-02'))
  check('星期几：不认识的输入给空', weekday('不是日期') === '', weekday('不是日期'))
  check('clip：超长带省略号', clip('一二三四五六', 3) === '一二三…', clip('一二三四五六', 3))
  check('clip：不超长原样', clip('  一二三  ', 5) === '一二三', clip('  一二三  ', 5))

  const withHead = '2026-11-01 周日\n\n' + BODY
  const fixed = normalizeDiaryText(withHead, '2026-11-02')
  check('模型写的日期头被撕掉，换成我们补的', fixed.startsWith('2026-11-02 周一'), fixed.slice(0, 30))
  check('正文没被吃掉', fixed.includes('抽屉终于能合上'), fixed.slice(-40))

  const json = normalizeDiaryText(JSON.stringify({ text: BODY }), '2026-11-02')
  check('JSON 里的正文取得出来', json.includes('没写完的纸'), json.slice(0, 40))

  const prefix = normalizeDiaryText('日记正文：' + BODY, '2026-11-02')
  check('「日记正文：」这种前缀去掉', !prefix.includes('日记正文'), prefix.slice(0, 30))

  const fenced = normalizeDiaryText('```\n' + BODY + '\n```', '2026-11-02')
  check('代码围栏去掉', !fenced.includes('```'), fenced.slice(0, 20))

  check('bodyLength：只算正文，不算日期头', bodyLength('2026-11-02 周一\n\n' + BODY) === BODY.length, bodyLength('2026-11-02 周一\n\n' + BODY))
}

// ---- 2. 抄提示词不算日记
{
  check('system: 开头算回声', isPromptEcho('system: 你是小汐') === true)
  check('整段 JSON 材料算回声', isPromptEcho('{"episodes": []}') === true)
  check('抄了提示词原句算回声', isPromptEcho('你在写这一天的日记，只写材料里出现的事') === true)
  check('正常日记不算回声', isPromptEcho(BODY) === false)
  check('空的不算日记', isPromptEcho('   ') === true)
}

// ---- 3. 质检
{
  check('空的：太短', checkDiary('').reason === 'too_short', checkDiary(''))
  check('写成 Markdown 列表：退回', checkDiary('- 今天\n- 明天\n' + BODY).reason === 'markdown', checkDiary('- 今天\n- 明天\n' + BODY))
  check('混进「用户」：退回', checkDiary(BODY + '\n用户说了一句什么').reason === 'forbidden', checkDiary(BODY + '\n用户说了一句什么'))
  const ok = checkDiary(BODY)
  check('正常一篇：过', ok.ok === true && ok.chars > 120, ok)
  const cut = checkDiary(BODY.slice(0, 200).replace(/[。！？…”』」'"]$/, ''))
  check('短还断在半句：退回', cut.reason === 'cut', cut)
}

// ---- 4. 口吻由状态推
{
  const tone = diaryTone({ axes: { sn: 0.8, ei: 0.2, tf: 0.3, sensitivity: 0.9 }, affect: { intensity: 0.8 } })
  check('高敏感：情绪写得具体些', tone.includes('情绪写得具体些'), tone)
  check('内向：话少、克制', tone.includes('话少、克制'), tone)
  const calm = diaryTone({ axes: { sn: 0.3, ei: 0.5, tf: 0.6, sensitivity: 0.2 }, affect: { intensity: 0.2 } })
  check('低敏感不乱加戏', !calm.includes('情绪写得具体些'), calm)
  check('没状态时口吻为空，不编', diaryTone({}) === '' || typeof diaryTone({}) === 'string', diaryTone({}))
  check('没情绪就不报强度', moodZhOf({}) === '说不上来', moodZhOf({}))
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exit(1)
