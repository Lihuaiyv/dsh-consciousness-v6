// 「完整清单」的唯一提取规则：生成脚本和测试都走这里，避免两边各数各的。
import fs from 'node:fs'

/**
 * 从 client.js 提取所有可见区块标题：
 * - h(Sec, { title: 'xxx' }) 与 h(FoldBlock, { title: 'xxx' }) 的字面标题
 * - 设置页的分组标题写在 PARAM_TAB_GROUPS 里（渲染时是 g.title）
 */
export function collectCatalog(clientSrc) {
  const items = []
  const push = (t) => { if (t && !items.includes(t)) items.push(t) }
  for (const m of clientSrc.matchAll(/h\((Sec|FoldBlock),/g)) {
    const seg = clientSrc.slice(m.index, m.index + 280)
    const t = seg.match(/title:\s*(?:view\s*===\s*'user'\s*\?\s*'[^']*'\s*:\s*)?'([^']+)'/)
    push(t && t[1])
  }
  const gs = clientSrc.indexOf('const PARAM_TAB_GROUPS = [')
  if (gs >= 0) {
    const ge = clientSrc.indexOf('\n    ]', gs)
    const block = clientSrc.slice(gs, ge > gs ? ge : clientSrc.length)
    for (const m of block.matchAll(/title:\s*'([^']+)'/g)) push(m[1])
  }
  return items
}

export function collectCatalogFromFile(clientPath) {
  return collectCatalog(fs.readFileSync(clientPath, 'utf8'))
}
