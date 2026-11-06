import fs from 'node:fs'
// ① 弱标冻结：注释标清楚「已证伪，不要开」，代码保持两段式（参数留给回放 D 组）
{
  const p = 'src/kernel.js'
  let s = fs.readFileSync(p, 'utf8')
  const a = "  // 弱标（同主题但不同 key、只标不挤）默认不进注入；on 时才显示「同主题后面还有一条说法」。\n  'memory.passport.weak': ['C4', 'off'],"
  const b = "  // 弱标（同主题但不同 key、只标不挤）：**已证伪，冻结，不要开**。\n  // 开过一回，8 条提示全是「同主题」词撞车（「oneLine」能撞出五条互不相干的结论）。\n  // 参数留着只为回放 D 组能复现历史对照；注入口子默认关，别再拿它当判定。\n  'memory.passport.weak': ['C4', 'off'],"
  if (!s.includes(a)) { console.error('kernel anchor not found'); process.exit(1) }
  fs.writeFileSync(p, s.replace(a, b), 'utf8')
}
// ② passport 的弱标视图也标一句，免得后人以为那是可用的判定
{
  const p = 'src/modules/passport.js'
  let s = fs.readFileSync(p, 'utf8')
  const a = "  if (s.weakLater && String(opt && opt.weak) === 'on') {"
  const b = "  // 弱标视图：已证伪（同主题大量是词撞车），默认关、冻结。只给回放对照用。\n  if (s.weakLater && String(opt && opt.weak) === 'on') {"
  if (!s.includes(a)) { console.error('passport anchor not found'); process.exit(1) }
  fs.writeFileSync(p, s.replace(a, b), 'utf8')
}
console.log('weak frozen comments written')
