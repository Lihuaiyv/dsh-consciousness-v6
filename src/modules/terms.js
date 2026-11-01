/**
 * 检索词归一化：卡片、扩词、回填脚本共用一套规则。
 *
 * 为什么单开一个文件：这三个地方对「什么样的词能进索引」必须一致，
 * 否则模型给的同义词在写入侧被收下、在查询侧被丢掉（或反过来），排查起来像鬼打墙。
 *
 * 规则：
 *   - 单个汉字只收实词（「猫」「酒」可以，「的」「了」「是」不行）；
 *   - 2–12 个字，不能带空白或标点（那是句子，不是词）；
 *   - 疑问词 / 指代词 / 泛词（「一个」「什么」「可以」）不进索引，只会制造假命中。
 */

const STOP_CHARS = new Set([...'的了是我你他她它们在这那有个吗呢吧啊就都也还和与要会能可很太更最把被让给从对向已经过嘛呀哦嗯一不没等只'])

const STOP_WORDS = new Set([
  '一个', '这个', '那个', '什么', '怎么', '如何', '一下', '可以',
  '我们', '你们', '他们', '自己', '东西', '事情', '问题', '时候',
])

export function cleanTerm(raw) {
  return String(raw == null ? '' : raw)
    .replace(/^[\s"'“”‘’《》\[【(（]+|[\s"'“”‘’》\]】)）]+$/g, '')
    .trim()
}

export function isTerm(t) {
  if (!t || t.length > 12) return false
  if (/[\s,，、;；。.!！?？:：]/.test(t)) return false
  if (STOP_WORDS.has(t.toLowerCase())) return false
  if (t.length === 1) return /[\u4e00-\u9fff]/.test(t) && !STOP_CHARS.has(t)
  return true
}

/** 归一化一组检索词：去标点、去重、按规则过滤，最多 max 个。 */
export function normalizeTerms(input, max = 8) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[\s,，、;；|]+/)
  const out = []
  const seen = new Set()
  for (const raw of list) {
    const t = cleanTerm(raw)
    if (!isTerm(t)) continue
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
    if (out.length >= max) break
  }
  return out
}
