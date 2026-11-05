/**
 * 主动开口 · 模型与测试钩子（零件内）
 *
 * model 单例 + 两个可替换的钩子；几处生成共用同一份，
 * 免得「一个地方换了模型、另一个地方还是旧的」。
 */
import { createModel } from '../../model.js'

export const model = createModel()
export const freeformModelHook = { complete: null }
