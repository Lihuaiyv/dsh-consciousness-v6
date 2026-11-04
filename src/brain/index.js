/**
 * 大脑盒入口（INV12）。
 *
 * 这里只放「裁决」：给状态，回决定。
 * 不碰 db、不碰 api、不碰宿主、不碰行动——门禁见 scripts/check-brain.mjs。
 * 旧代码可以继续从 features.js 导；新代码从这里进。
 */
export { clampInjection } from './inject.js'
