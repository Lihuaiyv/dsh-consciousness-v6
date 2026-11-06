import fs from 'node:fs'
const p = 'docs/记忆时态-模型窄门-修改计划-2026-11-04.md'
let s = fs.readFileSync(p, 'utf8')
const mark = '> 2026-11-04 深夜。基于当前代码实测，不是照抄交接里的设想。'
const line = mark + '\n>\n> **✅ 已执行（2026-11-04 深夜 ~ 11-05 凌晨）**：P0–P6 全部落地，执行记录与数据对比见\n> `docs/记忆时态-模型窄门-执行记录-2026-11-04.md`。真库开关仍默认 off，线上行为未变。'
if (!s.includes(mark)) { console.error('marker not found'); process.exit(1) }
if (s.includes('已执行')) { console.log('already marked'); process.exit(0) }
fs.writeFileSync(p, s.replace(mark, line), 'utf8')
console.log('marked')
