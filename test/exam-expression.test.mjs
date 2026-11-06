/**
 * 说话分寸零件 · 考卷
 *
 * 管的是「这一轮怎么说」：慢情绪定基调（低落少说、偏高愿意展开）、
 * 这一下的强度压上限、关系只调温度不逼她多说；输出是软愿望，不是命令。
 * 不管「说什么内容」（注入/召回）、不管「此刻什么情绪」（情绪动力）。
 *
 * 运行：node test/exam-expression.test.mjs
 */
import { expressionFrom, LEVELS } from '../src/algo/expression.js'
import {
  expressionState, shadowLevel, feltLine, wishLine, styleLine, moodWord, subtextOf,
} from '../src/modules/expression_state.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

// ================================================================ 基调：慢情绪定档
{
  const base = expressionFrom({})
  check('中性时正常档', base.level === 'normal' && base.sentences === 3 && base.proactive === 1, base)
  check('中性时语气平', base.tone === 'plain', base.tone)

  const quiet = expressionFrom({ slow: -0.3 })
  check('低落 → 安静档、一句、不主动', quiet.level === 'quiet' && quiet.sentences === 1 && quiet.proactive === 0, quiet)
  check('低落时语气偏冷', quiet.tone === 'cool', quiet.tone)

  const brief = expressionFrom({ slow: -0.1 })
  check('有点低 → 简短档、两句、不主动', brief.level === 'brief' && brief.sentences === 2 && brief.proactive === 0, brief)
  check('稍微低不冷', brief.tone === 'plain', brief.tone)

  const warm = expressionFrom({ slow: 0.3 })
  check('偏高 → 热乎档、四句、愿意主动两句', warm.level === 'warm' && warm.sentences === 4 && warm.proactive === 2, warm)
  check('偏高时语气暖', warm.tone === 'warm', warm.tone)

  check('安静/简短的门槛正好在 -0.2 / -0.05', expressionFrom({ slow: -0.2 }).level === 'quiet'
    && expressionFrom({ slow: -0.049 }).level === 'normal', expressionFrom({ slow: -0.049 }).level)
}

// ================================================================ 强度：这一下太猛，话就短
{
  const short = expressionFrom({ intensity: 0.85 })
  check('太激动 → 一句、不主动', short.sentences === 1 && short.proactive === 0, short)
  check('太激动时语气就一个「短」字', short.tone === 'short', short.tone)
  const mid = expressionFrom({ intensity: 0.7 })
  check('强度偏高 → 最多两句，也不主动', mid.sentences === 2 && mid.proactive === 0, mid)
  check('强度没过线就照常', expressionFrom({ intensity: 0.6 }).sentences === 3)
}

// ================================================================ 性格：多说/少说半句，压不过低落
{
  const extro = expressionFrom({ ei: 0.9 })
  check('外向多一句', extro.level === 'normal' && extro.sentences === 4, extro)
  const intro = expressionFrom({ ei: 0.2 })
  check('内向少一句', intro.sentences === 2, intro)
  const quietExtro = expressionFrom({ slow: -0.3, ei: 0.9 })
  check('低落压过外向：不因为外向就多说', quietExtro.sentences === 1, quietExtro)
  const extroFast = expressionFrom({ ei: 0.9, intensity: 0.7 })
  check('太激动时外向也不加', extroFast.sentences === 2, extroFast)
  const warmIntro = expressionFrom({ slow: 0.3, ei: 0.2 })
  check('热乎档内向也只到三句', warmIntro.sentences === 3, warmIntro)
}

// ================================================================ 边界与兜底
{
  const dirty = expressionFrom({ slow: 'x', intensity: null, ei: undefined })
  check('脏输入按默认走，不炸', dirty.level === 'normal' && dirty.sentences === 3, dirty)
  check('句长永远 1~4、主动永远 0~2', [expressionFrom({ slow: 1, ei: 1 }), expressionFrom({ slow: -1 })].every((r) =>
    r.sentences >= 1 && r.sentences <= 4 && r.proactive >= 0 && r.proactive <= 2))
  check('档位元数据：安静 1 句 / 热乎 4 句', LEVELS.quiet.sentences === 1 && LEVELS.warm.sentences === 4, LEVELS)
}

// ================================================================ 影子档：快情绪挪一档，只在旁边算
{
  check('快情绪偏高 → 影子档上一档', shadowLevel('normal', { fast: 0.5, slow: 0 }) === 'warm')
  check('低落时影子档不往上走', shadowLevel('normal', { fast: 0.5, slow: -0.3 }) === 'normal')
  check('快情绪偏低 → 影子档下一档', shadowLevel('normal', { fast: -0.5 }) === 'brief')
  check('已经到头就不再上', shadowLevel('warm', { fast: 0.9 }) === 'warm')
  check('已经最低就不再下', shadowLevel('quiet', { fast: -0.9 }) === 'quiet')
  check('认不出的档位按正常算', shadowLevel('nope', { fast: 0.5 }) === 'warm')
}

// ================================================================ 合成：情绪定多少，关系定多暖
{
  const st = expressionState({
    affect: { v3: { slow: -0.3, fast: 0.5, total: -0.5 }, intensity: 0.4 },
    relation: { warmth: 0.8, formality: 0.2, disclosure: 0.6, initiative: 0.9 },
    ei: 0.6,
  })
  check('低落时是安静档', st.level === 'quiet', st.level)
  check('低落时不主动（关系再近也不急）', st.proactive === 0 && st.initiative === 0, { p: st.proactive, i: st.initiative })
  check('温度 = 关系六成 + 语气四成', st.warmth === Math.round((0.6 * 0.8 + 0.4 * 0.25) * 100) / 100, st.warmth)
  check('正式 / 披露直接来自关系', st.formality === 0.2 && st.disclosure === 0.6, st)
  check('影子档也交出来', typeof st.wouldLevel === 'string' && typeof st.fast === 'number', st.wouldLevel)
  check('三条软愿望都给了（感受 / 想怎么说 / 怎么说）', typeof st.felt === 'string' && typeof st.wish === 'string' && typeof st.style === 'string', st)

  const noAffect = expressionState({})
  check('没有情绪数据时按中性来', noAffect.level === 'normal', noAffect.level)
  check('中性时句长三句', noAffect.sentences === 3, noAffect.sentences)

  // 迟滞：慢情绪只挪一点点，先不换脸
  const held = expressionState({ affect: { v3: { slow: 0, total: 0 }, intensity: 0.4 }, prev: { level: 'brief', slow: -0.06 } })
  check('慢情绪只挪一点 → 保持上一档的脸', held.level === 'brief', held.level)
  check('保持旧档时句长也收着', held.sentences === 2, held.sentences)
  const moved = expressionState({ affect: { v3: { slow: 0.1, total: 0.3 }, intensity: 0.4 }, prev: { level: 'brief', slow: -0.06 } })
  check('挪够了才换脸', moved.level === 'normal', moved.level)

  const moodFallback = expressionState({ affect: { mood: 0.3, intensity: 0.4 } })
  check('老库没有 v3 时用 mood 换算（0.3 → 偏负面）', moodFallback.felt.includes('偏负面'), moodFallback.felt)
}

// ================================================================ 软愿望：不是命令
{
  check('安静档：一句就停', wishLine({ level: 'quiet' }).includes('短') && styleLine({ level: 'quiet' }).includes('一句就停'), styleLine({ level: 'quiet' }))
  check('热乎档：愿意多说一点', styleLine({ level: 'warm' }).includes('愿意多说一点'), styleLine({ level: 'warm' }))
  check('认不出的档位落到正常档', wishLine({ level: 'x' }) === wishLine({ level: 'normal' }))

  const f = feltLine({ label: 'joy', intensity: 0.8, slow: 0.3, mood: 0.4, weight: 0.6 })
  check('感受行是推测口吻（权重低才说「感觉现在大概」）', feltLine({ label: 'joy', intensity: 0.8, weight: 0.3 }).startsWith('感觉现在大概：')
    && f.startsWith('现在：'), f)
  check('低落时感受里带「不太想多说」', feltLine({ label: 'calm', intensity: 0.4, slow: -0.3 }).includes('不太想多说'))
  check('偏高时感受里带「愿意多说两句」', feltLine({ label: 'calm', intensity: 0.4, slow: 0.3 }).includes('愿意多说两句'))

  check('心情词：0.2 起算偏正面、-0.2 起算偏负面、0 中性',
    moodWord(0.2) === '偏正面' && moodWord(-0.2) === '偏负面' && moodWord(0) === '中性')
  /* 真相：Number(null) 是 0，所以 moodWord(null) 给出「中性」，不是留空——
     「没数据」和「正好中性」在这个函数里分不开。照现实考，写进已知坑。 */
  check('null 会算成 0 → 中性（分不出「没数据」）', moodWord(null) === '中性', moodWord(null))
  check('真正没传（undefined / 非数）才留空', moodWord(undefined) === '' && moodWord('x') === '', moodWord(undefined))

  check('她高兴时把火压着：潜台词是「不想扫兴」', subtextOf({ hot: true, userLabel: 'joy' }) === '不想扫兴，所以把火先压着。')
  check('低信任 + 冲突：潜台词是「有句实话没敢说」', subtextOf({ conflictLine: 'x', lowTrust: true }) === '有句实话没敢说。')
  check('普通冲突：想问又怕吵', subtextOf({ conflictLine: 'x' }) === '想问，但怕一问就变成吵架。')
  check('没有冲突就不出潜台词', subtextOf({}) === '')
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
