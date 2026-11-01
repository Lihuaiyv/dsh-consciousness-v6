/**
 * 宿主契约自检：用 mock 宿主验证 src/host/dsh.js 的探测 / 安装 / 降级 / 兜底。
 * 不启动 DSH、不碰数据库，纯函数级。
 *
 * 用法：node scripts/check-host.mjs
 *
 * DSH 破坏性更新时先跑这个：全绿说明接缝还认得；某个用例红了，
 * 红的那条就是 adapter 需要改的地方（对应 ping 报告里的 seam）。
 */
import assert from 'node:assert'
import { createHost, readEvent, messageText, HOST_EVENTS, SEAMS } from '../src/host/dsh.js'

const pass = []
const fail = []
const cases = []

/** 先登记，最后统一按登记顺序跑（允许 async 用例）。 */
function check(name, fn) {
  cases.push({ name, fn })
}

/** 仿 cordis 的宿主：inject 回调拿到 child，child 上挂服务；on 记下监听器。 */
function mockCtx(opts = {}) {
  const seen = {
    sections: [], routes: [], listeners: new Map(),
    tools: [], guards: [], commands: [], disposed: 0,
  }
  const ctx = {}

  if (opts.on !== false) {
    ctx.on = (name, fn) => {
      seen.listeners.set(name, fn)
      return () => {}
    }
  }

  if (opts.inject !== false) {
    ctx.inject = (deps, fn) => {
      if (opts.injectThrows) throw new Error('inject is not a function on this host')
      const child = { effect: (f) => f() }
      if (opts.systemPrompt === null) {
        // 宿主没有 systemPrompt 服务
      } else if (opts.systemPrompt !== undefined) {
        child.systemPrompt = opts.systemPrompt
      } else {
        child.systemPrompt = { section: (sec) => { seen.sections.push(sec); return () => {} } }
      }
      if (opts.webServer === null) {
        // 宿主没有 webServer 服务
      } else if (opts.webServer !== undefined) {
        child.webServer = opts.webServer
      } else {
        child.webServer = { register: (route) => { seen.routes.push(route); return () => {} } }
      }
      const off = () => { seen.disposed++ }
      if (opts.tools === null) {
        // 宿主没有 tools 服务
      } else if (opts.tools !== undefined) {
        child.tools = opts.tools
      } else {
        child.tools = { register: (t) => { seen.tools.push(t); return off }, guard: (g) => { seen.guards.push(g); return off } }
      }
      if (opts.commands === null) {
        // 宿主没有 commands 服务
      } else if (opts.commands !== undefined) {
        child.commands = opts.commands
      } else {
        child.commands = { register: (c) => { seen.commands.push(c); return off } }
      }
      fn(child)
    }
  }

  if (opts.direct) {
    ctx.effect = (f) => f()
    ctx.systemPrompt = { section: (sec) => { seen.sections.push(sec); return () => {} } }
    ctx.webServer = { register: (route) => { seen.routes.push(route); return () => {} } }
    ctx.tools = { register: (t) => { seen.tools.push(t); return () => {} }, guard: (g) => { seen.guards.push(g); return () => {} } }
    ctx.commands = { register: (c) => { seen.commands.push(c); return () => {} } }
  }

  return { ctx, seen }
}

/** 一份「正常宿主上应该长这样」的接缝配置。 */
function goodSpec() {
  return {
    systemPrompt: { name: 'dsh-consciousness', order: 12, text: () => 'x' },
    preStep: (payload, next) => next(),
    sessionEvent: () => {},
    webServer: (child) => {
      const offs = ['/a', '/b', '/c'].map((path) => child.webServer.register({ kind: 'exact', path, handler() {} }))
      return () => { for (const off of offs) if (typeof off === 'function') off() }
    },
    tools: [{
      name: 'relation_lookup',
      description: '查一个人是谁',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      output: { schema: { type: 'object', properties: { card: { type: 'string' } } }, render: () => [{ type: 'text', text: 'x' }] },
      async execute() { return { card: '' } },
    }],
    toolGuards: [() => undefined],
    commands: [{
      name: 'whois',
      description: '查一个人是谁（人物卡）',
      input: { hint: '名字' },
      async handler() { return { kind: 'success', text: 'ok' } },
    }],
  }
}

const seam = (report, id) => report.seams.find((s) => s.seam === id)

console.log('宿主契约自检（mock 宿主，不需要 DSH / 数据库）')

check('六个接缝都 ok 时 status=ok', () => {
  const { ctx, seen } = mockCtx()
  const rep = createHost().install(ctx, goodSpec())
  assert.equal(rep.status, 'ok')
  assert.equal(rep.ok, 6)
  assert.equal(rep.attempted, 6)
  assert.equal(seen.sections.length, 1)
  assert.equal(seen.routes.length, 3)
  assert.equal(seen.listeners.size, 2)
  assert.equal(seen.tools.length, 1)
  assert.equal(seen.guards.length, 1)
  assert.equal(seen.commands.length, 1)
  assert.ok(seen.listeners.has('agent/pre-step'))
  assert.ok(seen.listeners.has('session/event'))
  assert.ok(SEAMS.every((id) => seam(rep, id).level === 'ok'))
})

check('section 字段按真实契约送：name/order/text + interpolate:false', () => {
  const { ctx, seen } = mockCtx()
  createHost().install(ctx, goodSpec())
  const s = seen.sections[0]
  assert.equal(s.name, 'dsh-consciousness')
  assert.equal(s.order, 12)
  assert.equal(typeof s.text, 'function')
  assert.equal(s.text(), 'x')
  // 记忆是用户原话，可能含 {{ }}，不能交给宿主做变量插值
  assert.equal(s.interpolate, false)
})

check('宿主没有 systemPrompt 服务 → 只丢这一项（absent），其余照旧', () => {
  const { ctx, seen } = mockCtx({ systemPrompt: null })
  const rep = createHost().install(ctx, goodSpec())
  assert.equal(seam(rep, 'systemPrompt').level, 'absent')
  assert.equal(seam(rep, 'agent/pre-step').level, 'ok')
  assert.equal(seam(rep, 'session/event').level, 'ok')
  assert.equal(seam(rep, 'webServer').level, 'ok')
  assert.equal(rep.status, 'partial')
  assert.equal(seen.routes.length, 3)
})

check('服务在但 section() 改名 → degraded，报告里带原因', () => {
  const { ctx } = mockCtx({ systemPrompt: {} })
  const rep = createHost().install(ctx, goodSpec())
  const s = seam(rep, 'systemPrompt')
  assert.equal(s.level, 'degraded')
  assert.match(s.reason, /section/)
  assert.equal(rep.status, 'partial')
})

check('section() 抛错 → error，且不影响另外三个接缝', () => {
  const { ctx, seen } = mockCtx({ systemPrompt: { section() { throw new TypeError('order must be a finite number') } } })
  const rep = createHost().install(ctx, goodSpec())
  const s = seam(rep, 'systemPrompt')
  assert.equal(s.level, 'error')
  assert.match(s.reason, /order/)
  assert.equal(seam(rep, 'webServer').level, 'ok')
  assert.equal(seen.routes.length, 3)
})

check('没有 ctx.on → 两个监听接缝都是 absent', () => {
  const { ctx } = mockCtx({ on: false })
  const rep = createHost().install(ctx, goodSpec())
  assert.equal(seam(rep, 'agent/pre-step').level, 'absent')
  assert.equal(seam(rep, 'session/event').level, 'absent')
  assert.equal(rep.status, 'partial')
  assert.equal(rep.ok, 4)
})

check('服务直接挂在 ctx 上（无 inject）→ 走直连路径也能装上', () => {
  const { ctx, seen } = mockCtx({ inject: false, direct: true })
  const rep = createHost().install(ctx, goodSpec())
  assert.equal(rep.status, 'ok')
  assert.equal(seen.sections.length, 1)
  assert.equal(seen.routes.length, 3)
  assert.match(seam(rep, 'systemPrompt').contract, /ctx\.systemPrompt/)
})

check('mount 不返回 disposer → 仍算 ok，只是标注 disposable=false', () => {
  const { ctx } = mockCtx()
  const spec = {
    ...goodSpec(),
    webServer: (child) => { child.webServer.register({ kind: 'exact', path: '/only', handler() {} }) },
  }
  const rep = createHost().install(ctx, spec)
  const s = seam(rep, 'webServer')
  assert.equal(s.level, 'ok')
  assert.match(s.contract, /disposable=false/)
})

check('空 ctx + 空配置 → 六个 skipped，status=off', () => {
  const rep = createHost().install({}, {})
  assert.equal(rep.status, 'off')
  assert.ok(SEAMS.every((id) => seam(rep, id).level === 'skipped'))
})

check('空 ctx + 完整配置 → 六个都装不上，status=broken', () => {
  const rep = createHost().install({}, goodSpec())
  assert.equal(rep.status, 'broken')
  assert.equal(rep.ok, 0)
  assert.ok(SEAMS.every((id) => seam(rep, id).level === 'absent'))
})

check('inject 抛错 → 记成 error 而不是把异常扔出去', () => {
  const { ctx } = mockCtx({ injectThrows: true })
  const rep = createHost().install(ctx, goodSpec())
  assert.equal(seam(rep, 'systemPrompt').level, 'error')
  assert.equal(seam(rep, 'webServer').level, 'error')
  assert.equal(seam(rep, 'session/event').level, 'ok')
})

check('事件归一：user/message、assistant/message、其他类型', () => {
  assert.equal(HOST_EVENTS.userMessage, 'user/message')
  assert.equal(HOST_EVENTS.assistantMessage, 'assistant/message')
  assert.equal(HOST_EVENTS.preStep, 'agent/pre-step')
  assert.equal(readEvent({ type: 'user/message', data: { content: '你好' } }).text, '你好')
  assert.equal(
    readEvent({ type: 'user/message', data: { content: [{ type: 'text', text: '你' }, { type: 'tool-call' }, { type: 'text', text: '好' }] } }).text,
    '你\n好',
  )
  assert.equal(readEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我在' }] } } }).text, '我在')
  assert.equal(readEvent({ type: 'assistant/message', data: {} }).text, '')
  assert.equal(readEvent({ type: 'system/message', data: {} }).kind, 'other')
  assert.equal(readEvent(null).kind, 'other')
  assert.equal(messageText({ content: [{ type: 'image' }] }), '')
})

check('业务事件处理抛错不会冒泡到宿主，只累计 handler_errors', () => {
  const { ctx, seen } = mockCtx()
  const host = createHost()
  host.install(ctx, { ...goodSpec(), sessionEvent: () => { throw new Error('boom') } })
  const listener = seen.listeners.get('session/event')
  assert.doesNotThrow(() => listener({ id: 's1' }, { type: 'user/message', data: { content: 'hi' } }))
  assert.equal(host.report().handler_errors, 1)
})

check('pre-step：装上了会真被调用，hits 是链路的活证据', () => {
  const { ctx, seen } = mockCtx()
  const host = createHost()
  host.install(ctx, goodSpec())
  assert.equal(seam(host.report(), 'agent/pre-step').hits, 0)
  const out = seen.listeners.get('agent/pre-step')({ messages: [] }, () => 'continued')
  assert.equal(out, 'continued')
  assert.equal(seam(host.report(), 'agent/pre-step').hits, 1)
})

check('pre-step：业务忘了返回 next() 也会被兜底续上链路', () => {
  const { ctx, seen } = mockCtx()
  const host = createHost()
  host.install(ctx, { ...goodSpec(), preStep: () => { /* 忘了 next */ } })
  let calls = 0
  const out = seen.listeners.get('agent/pre-step')({}, () => { calls++; return 'continued' })
  assert.equal(calls, 1)
  assert.equal(out, 'continued')
  assert.equal(host.report().handler_errors, 0)
})

check('pre-step：业务抛错仍返回 next()，不卡住这一轮', () => {
  const { ctx, seen } = mockCtx()
  const host = createHost()
  host.install(ctx, { ...goodSpec(), preStep: () => { throw new Error('recall is not defined') } })
  let calls = 0
  const out = seen.listeners.get('agent/pre-step')({}, () => { calls++; return 'continued' })
  assert.equal(calls, 1)
  assert.equal(out, 'continued')
  assert.equal(host.report().handler_errors, 1)
})

check('cordis 代理：读未声明服务会抛，适配层应压成 undefined 并走 inject', () => {
  const { ctx } = mockCtx()
  // 真 cordis 的 ctx 是代理：没在 inject 里声明的服务名，直接读会抛，不返回 undefined
  const guarded = new Proxy(ctx, {
    get(target, key, receiver) {
      if (key === 'systemPrompt' || key === 'webServer' || key === 'version') {
        throw new Error('cannot get property "' + String(key) + '" without inject')
      }
      return Reflect.get(target, key, receiver)
    },
  })
  const rep = createHost().install(guarded, goodSpec())
  assert.equal(rep.status, 'ok')
  assert.equal(seam(rep, 'systemPrompt').level, 'ok')
  assert.equal(seam(rep, 'webServer').level, 'ok')
  assert.match(seam(rep, 'systemPrompt').contract, /inject/)
  assert.equal(rep.version, null)
})

check('pre-step：handler 自己调了 next() 再返回 undefined，不会续两次', () => {
  const { ctx, seen } = mockCtx()
  const host = createHost()
  host.install(ctx, {
    ...goodSpec(),
    preStep: (payload, next) => { next() },
  })
  let calls = 0
  const out = seen.listeners.get('agent/pre-step')({}, () => { calls++; return 'once' })
  assert.equal(calls, 1)
  assert.equal(out, 'once')
})

check('pre-step：async handler reject 也会续链路', async () => {
  const { ctx, seen } = mockCtx()
  const host = createHost()
  host.install(ctx, { ...goodSpec(), preStep: async () => { throw new Error('async boom') } })
  let calls = 0
  const out = seen.listeners.get('agent/pre-step')({}, () => { calls++; return 'continued' })
  assert.ok(out && typeof out.then === 'function')
  const v = await out
  assert.equal(calls, 1)
  assert.equal(v, 'continued')
  assert.equal(host.report().handler_errors, 1)
})

check('工具契约：按 ToolDefinition 注册，守卫单独挂，disposer 全部可调', () => {
  const { ctx, seen } = mockCtx()
  const host = createHost()
  const rep = host.install(ctx, goodSpec())
  assert.equal(seen.tools.length, 1)
  const t = seen.tools[0]
  assert.equal(t.name, 'relation_lookup')
  assert.equal(typeof t.execute, 'function')
  assert.equal(typeof t.output.render, 'function')
  assert.deepEqual(t.output.render({}, { card: '' }), [{ type: 'text', text: 'x' }])
  assert.equal(seen.guards.length, 1)
  assert.equal(typeof seen.guards[0], 'function')
  assert.equal(seam(rep, 'tools').level, 'ok')
  assert.match(seam(rep, 'tools').contract, /register x1 \+ guard x1/)
})

check('工具定义不合法 → 只丢这一个，接缝记 degraded 并写原因', () => {
  const { ctx, seen } = mockCtx()
  const spec = {
    ...goodSpec(),
    tools: [
      { name: 'bad_tool', description: '缺 render', parameters: {}, output: { schema: {} }, execute() {} },
      { ...goodSpec().tools[0], name: 'ok_tool' },
    ],
  }
  const rep = createHost().install(ctx, spec)
  const s = seam(rep, 'tools')
  assert.equal(s.level, 'degraded')
  assert.match(s.reason, /bad_tool/)
  assert.equal(seen.tools.length, 1)
  assert.equal(seen.tools[0].name, 'ok_tool')
})

check('命令契约：按 {name,description,input,handler} 注册，handler 直接返回结果', async () => {
  const { ctx, seen } = mockCtx()
  createHost().install(ctx, goodSpec())
  assert.equal(seen.commands.length, 1)
  const c = seen.commands[0]
  assert.equal(c.name, 'whois')
  assert.equal(c.input.hint, '名字')
  const out = await c.handler({ rawInput: '小周', agent: { id: 's1' } })
  assert.equal(out.kind, 'success')
})

check('宿主没有 tools/commands 服务 → 只丢这两项，其它四项照旧', () => {
  const { ctx, seen } = mockCtx({ tools: null, commands: null })
  const rep = createHost().install(ctx, goodSpec())
  assert.equal(seam(rep, 'tools').level, 'absent')
  assert.equal(seam(rep, 'commands').level, 'absent')
  assert.equal(seam(rep, 'systemPrompt').level, 'ok')
  assert.equal(seen.routes.length, 3)
})

for (const c of cases) {
  try {
    await c.fn()
    pass.push(c.name)
    console.log('PASS ' + c.name)
  } catch (e) {
    fail.push(c.name)
    console.log('FAIL ' + c.name + '  ' + String((e && e.message) || e))
  }
}

console.log(`\n通过 ${pass.length} / ${pass.length + fail.length}`)
if (fail.length) {
  console.log('失败:', fail)
  process.exit(1)
}
