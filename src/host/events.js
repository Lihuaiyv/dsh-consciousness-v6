/**
 * 收信 · 认件：把平台递进来的事件，认成「谁、说了什么」。
 *
 * 收信分两截：平台负责「怎么收到」，这里只负责「收到之后认成什么」。
 * 输入一个宿主事件对象（session/event），输出 { kind: 'user'|'assistant'|'other', text }。
 *
 * 为什么单独拆出来：这段是契约翻译——平台换事件形状，它就该红；
 * 它不碰平台内部，只认事件名和消息体的形状，能单独喂数据考。
 */

/** 本插件消费的宿主事件名。宿主改名时只改这里。 */
export const HOST_EVENTS = Object.freeze({
  userMessage: 'user/message',
  assistantMessage: 'assistant/message',
  preStep: 'agent/pre-step',
})

/** 从一条会话消息里取出纯文本：content 可能是字符串，也可能是 block 数组。 */
export function messageText(message) {
  if (!message) return ''
  const c = message.content
  if (typeof c === 'string') return c.trim()
  if (!Array.isArray(c)) return ''
  return c
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/**
 * 把一条 session/event 归一成 { kind, text }。
 * 事件名和 data 形状都只在这里出现：user/message 的 data 就是消息本身，
 * assistant/message 的 data 是 { turn, step, message, usage?, stream? }。
 */
export function readEvent(event) {
  const type = event && typeof event.type === 'string' ? event.type : ''
  if (type === HOST_EVENTS.userMessage) return { kind: 'user', text: messageText(event.data) }
  if (type === HOST_EVENTS.assistantMessage) return { kind: 'assistant', text: messageText(event.data && event.data.message) }
  return { kind: 'other', text: '' }
}
