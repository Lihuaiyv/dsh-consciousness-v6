/**
 * 忘口 v0：只识别「明确要求忘掉」的意思，不执行。
 *
 * 为什么先只识别：忘是写操作（HIDE + 轮次级联），误判一次就把用户真说过的话藏起来。
 * 先把「我听到的忘」记成 `forget.intent` 事件，在真库上量一量误判，再决定接不接 hideMemory。
 *
 * 判定很窄：
 *   - 「忘掉 / 别再提」类：必须带回忆对象（这件事 / 刚才 / 这句 / 它…）；
 *   - 「删掉 / 抹掉」类：必须明确在说记忆（记忆 / 回忆 / 原话 / 刚才那句），否则当成在聊代码/文件；
 *   - 排除问句和提醒：「你忘了吗」「别忘了我」「我忘了」都不算；
 *   - 超过 80 字的长句不算（太可能是在聊别的）。
 */

const SOFT = /(忘掉|忘了吧|别再提|不要再提|不要提了)/
const SOFT_OBJ = /(这件事|那件事|这段|那段|这句|那句|这条|那条|刚才|它|我说的话)/
const HARD = /(删掉|抹掉|删除|删了)/
const MEM_OBJ = /(记忆|回忆|原话|说过的话|那句话|这句话|刚才那句|刚才那段|刚才那条)/
const NEG = /(你忘|别忘|不要忘|忘了吗|忘了？|忘了\?|我忘了|会不会忘|记不记得|还记不记得)/

export function detectForgetIntent(text) {
  const t = String(text || '').trim()
  if (!t || t.length > 60) return false
  if (NEG.test(t)) return false
  if (SOFT.test(t) && SOFT_OBJ.test(t)) return true
  if (HARD.test(t) && MEM_OBJ.test(t)) return true
  return false
}
