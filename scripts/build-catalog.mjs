// 生成「完整清单」：从 client.js 的 Sec / FoldBlock 区块提取，写入 src/catalog.json
// 用法：node scripts/build-catalog.mjs
import fs from 'node:fs'
import { collectCatalogFromFile } from './catalog-source.mjs'

const here = new URL('.', import.meta.url)
const clientPath = new URL('../client.js', here)
const outPath = new URL('../src/catalog.json', here)

const items = collectCatalogFromFile(clientPath)
const out = {
  source: 'client.js · 各页 Sec / FoldBlock 区块（自动生成，勿手改）',
  tabs: 1,
  items: items.length,
  groups: [{ name: '全部区块', items }],
}
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8')
console.log('catalog', items.length, 'items →', outPath.pathname)
