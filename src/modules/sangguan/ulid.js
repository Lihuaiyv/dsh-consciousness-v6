/**
 * ULID：48 位毫秒 + 80 位随机，Crockford base32，26 位。
 * 时间由调用方传入（事件时间），本模块不读时钟；同毫秒内单调递增，保证同毫秒有序。
 */
import { randomBytes } from 'node:crypto'

const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const MAX_MS = 2 ** 48 - 1

let lastMs = -1
let lastRand = null // 16 位 base32 数字（0..31）

function freshRand() {
  const b = randomBytes(10)
  const out = []
  // 80 位 → 16 个 5 位组
  let acc = 0
  let bits = 0
  for (const byte of b) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out.push((acc >> bits) & 31)
    }
    acc &= (1 << bits) - 1
  }
  return out
}

function bump(digits) {
  const d = digits.slice()
  for (let i = d.length - 1; i >= 0; i--) {
    if (d[i] < 31) { d[i]++; return d }
    d[i] = 0
  }
  throw new Error('ULID 随机段溢出')
}

export function ulid(ms) {
  const t = Number(ms)
  if (!Number.isInteger(t) || t < 0 || t > MAX_MS) throw new Error('ULID 需要合法的毫秒时间')
  lastRand = t === lastMs && lastRand ? bump(lastRand) : freshRand()
  lastMs = t
  let head = ''
  let x = t
  for (let i = 0; i < 10; i++) {
    head = ENC[x % 32] + head
    x = Math.floor(x / 32)
  }
  return head + lastRand.map((v) => ENC[v]).join('')
}

export function decodeTime(id) {
  let t = 0
  for (const ch of String(id).slice(0, 10)) {
    const v = ENC.indexOf(ch)
    if (v < 0) return NaN
    t = t * 32 + v
  }
  return t
}
