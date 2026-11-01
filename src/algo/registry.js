/**
 * 算法注册表（INV11 最小闭环）
 * 键：name@version → AlgoSpec
 * 未登记不得运行。
 */

const map = new Map()

function keyOf(name, version) {
  return String(name) + '@' + String(version)
}

/**
 * @param {{ name: string, version: string, kind?: string, metrics?: string[], run: Function }} spec
 */
export function register(spec) {
  if (!spec || !spec.name || !spec.version || typeof spec.run !== 'function') {
    throw new Error('AlgoSpec 需要 name、version、run')
  }
  const key = keyOf(spec.name, spec.version)
  if (map.has(key)) {
    // 热重载：同版本的新实现直接替换（算法版本由注册表共存管理，重复注册不应炸插件）
    const prev = map.get(key)
    if (prev && prev.run === spec.run) return key
    map.set(key, {
      name: String(spec.name),
      version: String(spec.version),
      kind: spec.kind || spec.name,
      metrics: Array.isArray(spec.metrics) ? spec.metrics : [],
      run: spec.run,
    })
    return key
  }
  map.set(key, {
    name: String(spec.name),
    version: String(spec.version),
    kind: spec.kind || spec.name,
    metrics: Array.isArray(spec.metrics) ? spec.metrics : [],
    run: spec.run,
  })
  return key
}

export function has(name, version) {
  return map.has(keyOf(name, version))
}

export function get(name, version) {
  const key = keyOf(name, version)
  const spec = map.get(key)
  if (!spec) throw new Error('算法未登记：' + key)
  return spec
}

export function list(name = null) {
  const out = []
  for (const spec of map.values()) {
    if (name == null || spec.name === name) out.push({ name: spec.name, version: spec.version, kind: spec.kind, metrics: spec.metrics })
  }
  return out.sort((a, b) => (a.name + a.version).localeCompare(b.name + b.version))
}

export function run(name, version, ctx, input) {
  return get(name, version).run(ctx, input || {})
}

/** 测试用：清空登记（随后需重新 bootstrap） */
