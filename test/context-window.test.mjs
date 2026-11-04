/**
 * 上下文窗口：前几句超过 600 字时要留末尾（最新的），不能切尾巴。
 * 运行：node test/context-window.test.mjs
 */
import { contextForUser } from '../src/model.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

check('没上下文就只放这一句', contextForUser('', '现在这句') === '现在这句')
check('只有空白也算没上下文', contextForUser('   \n ', '现在这句') === '现在这句')

const short = '前一句甲\n前一句乙'
const u1 = contextForUser(short, '现在这句')
check('短的上下文原样带上', u1.includes('前一句甲') && u1.includes('前一句乙'), { u1 })
check('格式里有「前几句」和「现在这句」', u1.startsWith('前几句：') && u1.includes('现在这句：'), { u1 })

/* 六句、每句 120 字 = 720 字，超过 600 的窗口 */
const six = Array.from({ length: 6 }, (_, i) => `第${i + 1}句` + 'x'.repeat(116)).join('\n')
const u2 = contextForUser(six, '你想怎么样？')
check('超长时不再原样放', u2.length < six.length + 40, { len: u2.length, raw: six.length })
check('最新的那一句必须还在', u2.includes('第6句'), { tail: u2.slice(-80) })
check('最早的那句被切掉了', !u2.includes('第1句'), { head: u2.slice(0, 80) })
check('留了省略号表示前面还有', u2.includes('…'), { head: u2.slice(0, 40) })

const huge = 'y'.repeat(5000)
const u3 = contextForUser('', huge)
check('单句过长截到 2000', u3.length === 2000, { len: u3.length })

const u4 = contextForUser(six, '你想怎么样？')
check('现在这句不会被上下文挤掉', u4.endsWith('你想怎么样？'), { tail: u4.slice(-30) })

/* 边界：正好 600 字不合省略号 */
const exact = 'z'.repeat(600)
const u5 = contextForUser(exact, 't')
check('正好窗口大小不加省略号', !u5.includes('…'), { head: u5.slice(0, 20) })

const over = 'w'.repeat(601)
const u6 = contextForUser(over, 't')
check('超一个字就加省略号', u6.includes('…'), { head: u6.slice(0, 20) })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
