/**
 * 碎片表的词表：来源（谁 / 什么来的）和形式（长什么样）。
 *
 * 2026-11-12 定下来的两栏：
 *
 * 来源四样
 *   owner  主人
 *   self   我
 *   other  其他的人（妈妈、文钊、陌生人）
 *   world  世界——既不是主人也不是我的外来物：鸟叫、楼下的猫、雨声、
 *          还有系统通报和工具结果（它们也都不是「谁在说话」）
 *
 * 形式五样
 *   text   字
 *   voice  声音（转出来的字进内容，原文件路径进 meta）
 *   image  图
 *   file   文件
 *   data   数据：波形、采样、数字（脑电、心率这种按点采下来的东西）
 *
 * 库里的历史值不动：老行还是 user / assistant / agent。
 * 原因很硬：id 是「谁 + 会话 + 轮次 + 内容 + 时间」算出来的哈希。
 * 改老行的来源，id 就跟内容脱钩，重放同一轮会插出一条重复的，
 * 「只追加、id 稳」这条规矩就破了。
 *
 * 所以对外的说法是四样，落库时用 toDbRole 折回老词，
 * 读的时候用 normalizeSource 抹平——两套并存，但看不出接缝。
 */

export const SOURCES = ['owner', 'self', 'other', 'world']
export const FORMS = ['text', 'voice', 'image', 'file', 'data']

/** 人类可读的名字，给页面和文档用。 */
export const SOURCE_LABEL = { owner: '主人', self: '我', other: '其他人', world: '世界' }
export const FORM_LABEL = { text: '文字', voice: '声音', image: '图', file: '文件', data: '数据' }

// 老词 → 新词。agent 也是「我」（我主动发出去的），归 self。
const ALIAS = {
  user: 'owner',
  owner: 'owner',
  assistant: 'self',
  agent: 'self',
  self: 'self',
  other: 'other',
  world: 'world',
}

/** 任何来源写法 → 四样之一。认不出的先当主人说的话（保守：宁可多认，不要漏）。 */
export function normalizeSource(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase()
  return ALIAS[s] || 'owner'
}

/**
 * 四样 → 库里该写的值。
 * owner 写回 user、self 写回 assistant，老 id 才算得回同一个号。
 * other / world 是新词，直接写。
 */
export function toDbRole(source) {
  const s = normalizeSource(source)
  if (s === 'owner') return 'user'
  if (s === 'self') return 'assistant'
  return s
}

/** 这一条是不是「人」说的（主人 / 我 / 别人）。world 不算。 */
export function isHumanSource(v) {
  return normalizeSource(v) !== 'world'
}

/** 形式归一：认不出的退到 text，绝不因为写错一个词就把整条吞掉。 */
export function normalizeForm(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase()
  return FORMS.includes(s) ? s : 'text'
}
