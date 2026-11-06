import fs from 'node:fs'
// ① kernel：把「默认不进注入」改成「已证伪，冻结」
{
  const p = 'src/kernel.js'
  let s = fs.readFileSync(p, 'utf8')
  const key = '  // 弱标（同主题但不同 key、只标不挤）默认不进注入'
  const i = s.indexOf(key)
  if (i < 0) { console.error('kernel line not found'); process.exit(1) }
  const j = s.indexOf('\n', i)
  const oldLine = s.slice(i, j).replace(/\r$/, '')
  const newLines = [
    '  // 弱标（同主题但不同 key、只标不挤）：**已证伪，冻结，不要开**。',
    '  // 开过一回，8 条提示全是「同主题」词撞车（「oneLine」能撞出五条互不相干的结论）。',
    '  // 参数留着只为回放 D 组能复现历史对照；注入口子默认关，别再拿它当判定。',
  ].join('\r\n')
  s = s.replace(oldLine, newLines)
  fs.writeFileSync(p, s, 'utf8')
  console.log('kernel frozen')
}
// ② passport：弱标视图标一句
{
  const p = 'src/modules/passport.js'
  let s = fs.readFileSync(p, 'utf8')
  const anchor = "  if (s.weakLater && String(opt && opt.weak) === 'on') {"
  if (!s.includes(anchor)) { console.error('passport anchor not found'); process.exit(1) }
  if (s.includes('弱标视图：已证伪')) { console.log('passport already marked'); process.exit(0) }
  s = s.replace(anchor, "  // 弱标视图：已证伪（同主题大量是词撞车），默认关、冻结。只给回放对照用。\r\n" + anchor)
  fs.writeFileSync(p, s, 'utf8')
  console.log('passport marked')
}
