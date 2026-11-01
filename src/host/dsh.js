/**
 * 宿主适配层 —— 整个插件里唯一认识 DSH 的文件。
 *
 * 业务代码（src/ 其余部分）不 import 任何宿主 API；四个接缝都在这里：
 *
 *   systemPrompt   注册一段系统提示（人格 / 情绪 / 关系 / 记忆）
 *   agent/pre-step 每个 step 前拿用户那句话去召回（waterfall，必须调 next() 才能继续）
 *   session/event  旁听对话事件（用户说了什么、模型回了什么）
 *   webServer      挂 HTTP 路由（API / SSE / ping）
 *
 * 每个接缝独立探测、独立安装、独立降级：断一个不影响另外两个；
 * 断了的那一项在 GET /dsh-consciousness/ping 的 host.seams 里给出
 * level + reason + contract + hits，一眼看出是「全线失效」还是「只丢了 UI」。
 *
 * hits 是「装上了而且真被调用过」的证据：契约没变但没人调，
 * 说明上游链路改了（比如 waterfall 被换成 emit），注册成功也会显示 hits=0。
 *
 * 契约（对照 0.2.1-rc.2 实测）：
 *   systemPrompt.section({ name, order, text, interpolate? })      -> disposer
 *   ctx.on('agent/pre-step', (payload, next) => next())            -> disposer
 *   ctx.on('session/event', (session, event) => void)              -> disposer
 *   webServer.register({ kind, path, handler })                    -> disposer
 *
 * DSH 破坏性更新时：先跑 `npm run check:host`（mock 宿主，不需要 DSH），
 * 再按报告里的 seam 改这一个文件；改完再跑一次就够。
 */

/** 本插件消费的宿主事件名。宿主改名时只改这里。 */
export const HOST_EVENTS = Object.freeze({
  userMessage: 'user/message',
  assistantMessage: 'assistant/message',
  preStep: 'agent/pre-step',
})

/** 六个接缝的 id，顺序即报告顺序。 */
export const SEAMS = Object.freeze(['systemPrompt', HOST_EVENTS.preStep, 'session/event', 'webServer', 'tools', 'commands'])

/** 从一条会话消息里取出纯文本：content 可能是字符串，也可能是 block 数组。 */
export function messageText(message) {
  if (!message) return ''
  const c = message.content
  if (typeof c === 'string') return c.trim()
  if (!Array.isArray(c)) return ''
  return c
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/**
 * 把一条 session/event 归一成 { kind, text }。
 * 事件名和 data 形状都只在这里出现：user/message 的 data 就是消息本身，
 * assistant/message 的 data 是 { turn, step, message, usage?, stream? }。
 */
export function readEvent(event) {
  const type = event && typeof event.type === 'string' ? event.type : ''
  if (type === HOST_EVENTS.userMessage) return { kind: 'user', text: messageText(event.data) }
  if (type === HOST_EVENTS.assistantMessage) return { kind: 'assistant', text: messageText(event.data && event.data.message) }
  return { kind: 'other', text: '' }
}

function errorText(e) {
  return String((e && e.message) || e || 'unknown error')
}

function validateSection(sp) {
  if (!sp || typeof sp !== 'object') return '缺少 systemPrompt 配置'
  if (typeof sp.name !== 'string' || !sp.name) return 'name 必须是非空字符串'
  if (!Number.isFinite(sp.order)) return 'order 必须是有限数字'
  if (typeof sp.text !== 'function' && typeof sp.text !== 'string') return 'text 必须是字符串或函数'
  return ''
}

/**
 * 安全读一个可选服务。
 * cordis 的 ctx 是代理：没在 inject 里声明过的服务名，直接 `ctx.foo` 会**抛**
 * 「cannot get property "foo" without inject」，而不是返回 undefined。
 * 这里把它压成 undefined，让「直连没戏就走 inject」这条分支真的走得下去。
 */
function optionalService(ctx, name) {
  if (!ctx) return undefined
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

/** 宿主版本只作参考：能读到就记，读不到就是 null，不猜。 */
function detectVersion(ctx) {
  const host = optionalService(ctx, 'host')
  const candidates = [optionalService(ctx, 'version'), host && host.version, process.env.DSH_VERSION]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return null
}

/**
 * 建一个宿主适配器。
 * @param {{ log?: (msg: string) => void }} [options] log 只在降级/报错时调用，默认静默。
 */
export function createHost(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const seams = new Map()
  for (const id of SEAMS) seams.set(id, { level: 'unknown', reason: '', contract: '', hits: 0, at: '' })
  let handlerErrors = 0
  let hostVersion = null

  function mark(id, level, reason = '', contract = '') {
    const prev = seams.get(id)
    const rec = { level, reason: reason ? String(reason) : '', contract, hits: prev ? prev.hits : 0, at: new Date().toISOString() }
    seams.set(id, rec)
    if (level === 'error' || level === 'degraded') {
      log('[dsh-consciousness-v6] host seam ' + id + ': ' + level + ' — ' + (reason || 'no reason'))
    }
    return rec
  }

  function bump(id) {
    const rec = seams.get(id)
    if (rec) rec.hits++
  }

  // ---------------- systemPrompt ----------------

  function mountSection(owner, svc, sp, via) {
    // interpolate:false —— 记忆是用户原话，可能含 {{...}}，不交给宿主做变量插值。
    const section = { name: sp.name, order: sp.order, text: sp.text, interpolate: false }
    const run = () => {
      const off = svc.section(section)
      return typeof off === 'function' ? off : undefined
    }
    try {
      const ret = owner && typeof owner.effect === 'function' ? owner.effect(run) : run()
      const disposable = typeof ret === 'function'
      mark('systemPrompt', 'ok', '', via + ' · section{name,order,text} · disposable=' + disposable)
    } catch (e) {
      mark('systemPrompt', 'error', 'section() 抛错：' + errorText(e))
    }
  }

  function installSystemPrompt(ctx, sp) {
    if (!sp) return mark('systemPrompt', 'skipped', '未配置')
    const bad = validateSection(sp)
    if (bad) return mark('systemPrompt', 'error', '本地注入配置不合法：' + bad)

    const direct = optionalService(ctx, 'systemPrompt')
    if (direct && typeof direct.section === 'function') return mountSection(ctx, direct, sp, 'ctx.systemPrompt')

    if (!ctx || typeof ctx.inject !== 'function') {
      return mark('systemPrompt', 'absent', 'ctx 上没有 systemPrompt，也没有 inject()')
    }
    mark('systemPrompt', 'pending', '等待 systemPrompt 服务')
    try {
      ctx.inject(['systemPrompt'], (child) => {
        const svc = child && child.systemPrompt
        if (!svc) return mark('systemPrompt', 'absent', 'inject(systemPrompt) 回调里没有这个服务')
        if (typeof svc.section !== 'function') return mark('systemPrompt', 'degraded', 'systemPrompt 上没有 section()，可能改名了')
        mountSection(child, svc, sp, 'inject(systemPrompt)')
      })
    } catch (e) {
      mark('systemPrompt', 'error', 'inject(systemPrompt) 抛错：' + errorText(e))
    }
  }

  // ---------------- 监听类接缝（agent/pre-step、session/event） ----------------

  /** 普通观察者：payload 原样转发，业务异常不冒泡到宿主。 */
  function wrapObserver(id, handler) {
    return (...args) => {
      bump(id)
      try {
        return handler(...args)
      } catch (e) {
        handlerErrors++
        log('[dsh-consciousness-v6] ' + id + ' handler failed: ' + errorText(e))
        return undefined
      }
    }
  }

  /**
   * waterfall：必须把 next() 的返回值交回去，链路才会继续。
   * 业务抛错 / 返回 undefined 时由这里兜底调 next()，绝不让一步卡死整轮对话。
   */
  function wrapWaterfall(id, handler) {
    return (payload, next) => {
      bump(id)
      let continued = false
      let lastResult
      const cont = () => {
        if (continued) return lastResult
        continued = true
        lastResult = typeof next === 'function' ? next() : undefined
        return lastResult
      }
      const fail = (e) => {
        handlerErrors++
        log('[dsh-consciousness-v6] ' + id + ' handler failed: ' + errorText(e))
        return cont()
      }
      // 业务给了返回值就用它；没给就交回 next() 的结果（没调过 next 就现在调）。
      const settle = (v) => {
        if (v !== undefined) return v
        return continued ? lastResult : cont()
      }
      try {
        const out = handler(payload, cont)
        if (out && typeof out.then === 'function') return out.then(settle, fail)
        return settle(out)
      } catch (e) {
        return fail(e)
      }
    }
  }

  function installListener(id, ctx, handler, waterfall) {
    if (!handler) return mark(id, 'skipped', '未配置')
    if (typeof handler !== 'function') return mark(id, 'error', '本地事件处理不是函数')
    if (!ctx || typeof ctx.on !== 'function') {
      return mark(id, 'absent', 'ctx.on 不是函数（事件总线改名或不存在）')
    }
    try {
      const ret = ctx.on(id, waterfall ? wrapWaterfall(id, handler) : wrapObserver(id, handler))
      mark(
        id,
        'ok',
        '',
        "ctx.on('" + id + "')(" + (waterfall ? 'payload,next' : 'session,event') + ')'
          + (waterfall ? ' · 返回 next() 继续链路' : '')
          + ' · disposable=' + (typeof ret === 'function'),
      )
    } catch (e) {
      mark(id, 'error', "on('" + id + "') 抛错：" + errorText(e))
    }
  }

  // ---------------- webServer ----------------

  function mountRoutes(owner, svc, mount, via) {
    const run = () => {
      const off = mount(owner)
      return typeof off === 'function' ? off : undefined
    }
    try {
      const ret = owner && typeof owner.effect === 'function' ? owner.effect(run) : run()
      const disposable = typeof ret === 'function'
      mark('webServer', 'ok', '', via + ' · register({kind,path,handler}) · disposable=' + disposable)
    } catch (e) {
      mark('webServer', 'error', 'register() 抛错：' + errorText(e))
    }
  }

  function installWebServer(ctx, mount) {
    if (!mount) return mark('webServer', 'skipped', '未配置')
    if (typeof mount !== 'function') return mark('webServer', 'error', '本地路由挂载不是函数')

    const direct = optionalService(ctx, 'webServer')
    if (direct && typeof direct.register === 'function') return mountRoutes(ctx, direct, mount, 'ctx.webServer')

    if (!ctx || typeof ctx.inject !== 'function') {
      return mark('webServer', 'absent', 'ctx 上没有 webServer，也没有 inject()')
    }
    mark('webServer', 'pending', '等待 webServer 服务')
    try {
      ctx.inject(['webServer'], (child) => {
        const svc = child && child.webServer
        if (!svc) return mark('webServer', 'absent', 'inject(webServer) 回调里没有这个服务')
        if (typeof svc.register !== 'function') return mark('webServer', 'degraded', 'webServer 上没有 register()，可能改名了')
        mountRoutes(child, svc, mount, 'inject(webServer)')
      })
    } catch (e) {
      mark('webServer', 'error', 'inject(webServer) 抛错：' + errorText(e))
    }
  }

  // ---------------- tools / commands ----------------
  //
  // 工具：ToolDefinition{ name, description, parameters, output:{schema,render}, execute(args,exec) }
  // 守卫：ToolGuard(execution) => string|undefined，返回字符串就是拒绝理由
  // 命令：CommandDefinition{ name, description, input?:{hint}, handler(inv)=>CommandResult }
  // 任何一项注册失败都只丢那一项，不拖累另外五个接缝。

  function validateTool(d) {
    if (!d || typeof d !== 'object') return '不是对象'
    if (!d.name || typeof d.name !== 'string') return 'name 缺失'
    if (!d.description || typeof d.description !== 'string') return 'description 缺失'
    if (typeof d.execute !== 'function') return 'execute 不是函数'
    if (!d.output || typeof d.output !== 'object') return 'output 缺失（必须有 schema + render）'
    if (!d.output.schema || typeof d.output.schema !== 'object') return 'output.schema 缺失'
    if (typeof d.output.render !== 'function') return 'output.render 不是函数'
    return ''
  }

  function validateCommand(d) {
    if (!d || typeof d !== 'object') return '不是对象'
    if (!d.name || typeof d.name !== 'string') return 'name 缺失'
    if (typeof d.handler !== 'function') return 'handler 不是函数'
    return ''
  }

  function mountRegistry(id, owner, svc, items, guards, validate) {
    const fails = []
    let registered = 0
    const run = () => {
      const offs = []
      for (const item of items || []) {
        const why = validate(item)
        if (why) { fails.push((item && item.name ? item.name : '?') + ': ' + why); continue }
        try {
          const off = svc.register(item)
          if (typeof off === 'function') offs.push(off)
          registered++
        } catch (e) { fails.push((item && item.name) + ': ' + errorText(e)) }
      }
      for (const g of guards || []) {
        try {
          const off = svc.guard(g)
          if (typeof off === 'function') offs.push(off)
        } catch (e) { fails.push('guard: ' + errorText(e)) }
      }
      return () => offs.forEach((f) => { try { f() } catch { /* 已卸载 */ } })
    }
    try {
      const ret = owner && typeof owner.effect === 'function' ? owner.effect(run) : run()
      if (ret === undefined && registered === 0 && fails.length) {
        // effect 内抛错会被 Cordis 吞掉时，至少把失败原因报出来
      }
      mark(id, fails.length ? 'degraded' : 'ok', fails.join(' | '),
        'register x' + registered + (guards && guards.length ? ' + guard x' + guards.length : '')
          + ' · disposable=' + (typeof ret === 'function'))
    } catch (e) {
      mark(id, 'error', 'register() 抛错：' + errorText(e))
    }
  }

  function installRegistry(id, ctx, items, guards, validate, serviceKey) {
    if (!items || !items.length) return mark(id, 'skipped', '未配置')
    const direct = optionalService(ctx, serviceKey)
    if (direct && typeof direct.register === 'function') {
      return mountRegistry(id, ctx, direct, items, guards, validate)
    }
    if (!ctx || typeof ctx.inject !== 'function') {
      return mark(id, 'absent', 'ctx 上没有 ' + serviceKey + '，也没有 inject()')
    }
    mark(id, 'pending', '等待 ' + serviceKey + ' 服务')
    try {
      ctx.inject([serviceKey], (child) => {
        const svc = child && child[serviceKey]
        if (!svc) return mark(id, 'absent', 'inject(' + serviceKey + ') 回调里没有这个服务')
        if (typeof svc.register !== 'function') return mark(id, 'degraded', serviceKey + ' 上没有 register()，可能改名了')
        mountRegistry(id, child, svc, items, guards, validate)
      })
    } catch (e) {
      mark(id, 'error', 'inject(' + serviceKey + ') 抛错：' + errorText(e))
    }
  }

  // ---------------- 对外 ----------------

  function install(ctx, spec = {}) {
    try { hostVersion = detectVersion(ctx) } catch { hostVersion = null }
    const safe = (id, fn) => {
      try { fn() } catch (e) { mark(id, 'error', '适配层异常：' + errorText(e)) }
    }
    safe('systemPrompt', () => installSystemPrompt(ctx, spec.systemPrompt))
    safe(HOST_EVENTS.preStep, () => installListener(HOST_EVENTS.preStep, ctx, spec.preStep, true))
    safe('session/event', () => installListener('session/event', ctx, spec.sessionEvent, false))
    safe('webServer', () => installWebServer(ctx, spec.webServer))
    safe('tools', () => installRegistry('tools', ctx, spec.tools, spec.toolGuards, validateTool, 'tools'))
    safe('commands', () => installRegistry('commands', ctx, spec.commands, null, validateCommand, 'commands'))
    return report()
  }

  function report() {
    const items = SEAMS.map((id) => ({ seam: id, ...seams.get(id) }))
    const attempted = items.filter((i) => i.level !== 'skipped')
    const ok = attempted.filter((i) => i.level === 'ok').length
    const status = attempted.length === 0
      ? 'off'
      : ok === attempted.length
        ? 'ok'
        : ok === 0
          ? 'broken'
          : 'partial'
    return {
      status,
      ok,
      attempted: attempted.length,
      handler_errors: handlerErrors,
      version: hostVersion,
      summary: items.map((i) => i.seam + '=' + i.level + '/' + i.hits).join(' '),
      seams: items,
      at: new Date().toISOString(),
    }
  }

  return { install, report }
}
