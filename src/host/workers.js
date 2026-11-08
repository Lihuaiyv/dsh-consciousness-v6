/**
 * 后台 workers：抽取 / 关系读人 / 日记补写 / 夜间巩固 / 偏好自长 / 微信收信。
 * 从 index.js 纯搬家；行为与定时间隔不变。
 *
 * 装配口：createWorkers({ ensureDb, enabledAgentIds, summarizeForDiary, probe })
 * index 的 ensureDb 成功后调用返回的 start* 即可。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getParam } from '../core.js'
import { ingest, autoGrowPreferences, chatReply } from '../features.js'
import { getConfig as getActionConfig, sendMessage as sendViaChannel } from '../modules/actions/channels.js'
import { detectPython } from '../modules/actions/wechat.js'
import { pollWeChatInbox } from '../modules/wechat_inbox.js'
import { startWeChatTyping } from '../modules/wechat_typing.js'
import { defaultAgentId } from '../modules/conversations.js'
import { tickExtraction } from '../modules/extract_queue.js'
import { runNightly, dueDiaryDays, hasDiaryMaterial } from '../modules/nightly.js'
import { repairPending, repairOldDiaries, defaultDiaryChat } from '../modules/diary.js'
import { model } from '../kernel.js'
import * as R from '../modules/relations.js'
import { tickRelationRead } from '../modules/relations_extract.js'

const WECHAT_WIN_SCRIPT = fileURLToPath(new URL('../../scripts/wechat_win.py', import.meta.url))

/**
 * @param {{
 *   ensureDb: () => any,
 *   enabledAgentIds: (db: any) => string[],
 *   summarizeForDiary: () => ((turns: any) => any) | null,
 *   probe: (msg: string) => void,
 * }} deps
 */
export function createWorkers(deps) {
  const { ensureDb, enabledAgentIds, summarizeForDiary, probe: __probe } = deps

  // ---------------- P2 抽取 worker ----------------

  let extractTimer = null

  /** 跑一次抽取队列（不阻塞对话；失败按队列里的退避规则重试）。 */
  async function runExtractionTick() {
    let d
    try { d = ensureDb() } catch { return }
    // 自动记忆关着就不往库里写：队列先留着，打开后下一轮会慢慢补上
    for (const aid of enabledAgentIds(d)) {
      // 自动记忆关着就不往库里写：队列先留着，打开后下一轮会慢慢补上
      try { if (getParam(d, aid, 'memory.auto') === false) continue } catch { /* 参数读不到就照常跑 */ }
      try {
        await tickExtraction(d, aid, (turns) => ingest(d, aid, { turns }), { max: 1 })
      } catch { /* 这一轮失败，下一轮再来 */ }
    }
  }

  function startExtractionWorker() {
    if (extractTimer) return
    extractTimer = setInterval(() => { runExtractionTick() }, 30000)
    if (extractTimer.unref) extractTimer.unref()
    setTimeout(() => { runExtractionTick() }, 6000)
  }

  // ---------------- 关系读人 worker ----------------

  let relationTimer = null

  /** 规则已经把名字记下了；这一层让模型补「谁是谁的谁」（小周是主人同事）。 */
  async function runRelationReadTick() {
    let d
    try { d = ensureDb() } catch { return }
    // 多实例：每个实例各自的关系账本各自读。
    for (const aid of enabledAgentIds(d)) {
      try {
        await tickRelationRead(d, aid, { complete: (a) => model.complete(a) })
      } catch { /* 这一条失败，下一轮再来 */ }
    }
  }

  function startRelationWorker() {
    if (relationTimer) return
    relationTimer = setInterval(() => { runRelationReadTick() }, 30000)
    if (relationTimer.unref) relationTimer.unref()
    setTimeout(() => { runRelationReadTick() }, 9000)
  }

  // ---------------- 日记待补 worker ----------------
  // 模型回来之后，30 分钟内把「当天没写成」的日记补上；一次只补一天/一个旧篇，避免一口气烧 token。
  let diaryRetryTimer = null
  async function runDiaryRetryTick() {
    let d
    try { d = ensureDb() } catch { return }
    if (defaultDiaryChat() === null) return
    for (const aid of enabledAgentIds(d)) {
      try { await repairPending(d, aid, { limit: 1 }) } catch { /* 单条失败下轮再来 */ }
      try { await repairOldDiaries(d, aid) } catch { /* 同上 */ }
    }
  }
  function startDiaryRetryWorker() {
    if (diaryRetryTimer) return
    diaryRetryTimer = setInterval(() => { runDiaryRetryTick() }, 30 * 60 * 1000)
    if (diaryRetryTimer.unref) diaryRetryTimer.unref()
    const boot = setTimeout(() => { runDiaryRetryTick() }, 45000)
    if (boot.unref) boot.unref()
  }

  // ---------------- P4 夜间巩固 ----------------

  let nightlyTimer = null
  let nightlyBusy = false
  // 每天几点写日记；默认 23:00（本地时间），可用 DSHC_DIARY_HOUR 改。
  const DIARY_HOUR = Math.min(23, Math.max(0, Number(process.env.DSHC_DIARY_HOUR ?? 23)))
  // 关机 / 休眠错过时最多往回补几天；0 = 不补（只在到点那一刻写当天）。
  const DIARY_BACKFILL_DAYS = Math.min(30, Math.max(0, Number(process.env.DSHC_DIARY_BACKFILL_DAYS ?? 7)))

  /** 下一个 23:00（本地时间）的时间戳。 */
  function nextDiaryAt(from = Date.now()) {
    const d = new Date(from)
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), DIARY_HOUR, 0, 0, 0)
    if (t.getTime() <= from) t.setDate(t.getDate() + 1)
    return t.getTime()
  }

  /**
   * 补写：把「到点没赶上」的日记按天补上。
   * 关机 / 休眠 / 定时器被挂起，都不再丢一天；只补还有原料的天，补的标 late=1。
   */
  async function catchUpDiaries(reason) {
    if (nightlyBusy) return
    let d
    try { d = ensureDb() } catch { return }
    // 多实例：每个人各补各的日记（各按自己的 dueDiaryDays 判，谁缺补谁）
    const aids = enabledAgentIds(d)
    if (!aids.length) return
    nightlyBusy = true
    try {
      const summarize = summarizeForDiary()
      for (const aid of aids) {
        // 关系每天走一次时间：三轴回归基线 + 淡出 / 归档（§5.2）。
        // tick 按「上次见面时间」算绝对目标，一天跑几次结果一样，不会累积扣。
        try { R.tick(d, aid) } catch (e) { __probe('rel-tick-err:' + (e && e.message)) }
        const days = dueDiaryDays(d, aid, { hour: DIARY_HOUR, backfillDays: DIARY_BACKFILL_DAYS })
        if (!days.length) continue
        for (const day of days) {
          // 那天的原文一句都没有（一直没开机）就不写：日记不编不存在的一天。
          if (!hasDiaryMaterial(d, aid, day)) continue
          const out = await runNightly(d, aid, { day, summarize })
          __probe('nightly(' + reason + ') aid=' + aid.slice(0, 8) + ' day=' + day + ' late=' + (out.late === undefined ? '-' : out.late) + ' ms=' + (out.ms || 0) + ' diary=' + out.diary_day)
        }
        // 巩固完记忆，顺手长一次「喜欢 / 讨厌」：自动、只增不减，模型没接上就一条都不长
        try {
          const g = await autoGrowPreferences(d, aid)
          __probe('grow-prefs(' + reason + ') aid=' + aid.slice(0, 8) + ' added=' + g.added.length + ' reason=' + (g.reason || 'ok') + ' model=' + g.model)
        } catch (e) {
          __probe('grow-prefs-err(' + reason + '):' + (e && e.message))
        }
      }
    } catch (e) {
      __probe('nightly-err(' + reason + '):' + (e && e.message))
    } finally {
      nightlyBusy = false
    }
  }

  /** 23:00 的准点定时器：到点就检查一遍该写哪几篇（补写逻辑自己按天判断）。 */
  function scheduleNightly() {
    if (nightlyTimer) return
    const target = nextDiaryAt()
    const delay = Math.max(1000, target - Date.now())
    nightlyTimer = setTimeout(() => {
      nightlyTimer = null
      catchUpDiaries('clock').catch(() => {}).finally(() => scheduleNightly())
    }, delay)
    if (nightlyTimer.unref) nightlyTimer.unref()
  }

  function startNightlyWorker() {
    // 启动后补一次：关机 / 休眠期间错过的日记在这里补上（等 archive 迁移先跑完）
    const boot = setTimeout(() => { catchUpDiaries('boot') }, 15000)
    if (boot.unref) boot.unref()
    // 每半小时兜底一次：睡醒、久开后跨天、准点定时器被挂起，都能接上
    const tick = setInterval(() => { catchUpDiaries('tick') }, 30 * 60 * 1000)
    if (tick.unref) tick.unref()
    scheduleNightly()
  }

  /**
   * 「喜欢 / 讨厌」是它自己长的，不用人按按钮。
   *
   * 每 10 分钟问一次该不该长（features.growPrefsDue 判：离上次 ≥ 60 分钟，
   * 且至少多出 3 条新记忆），够条件才真的花一次模型调用；长出来的标 origin=auto，
   * 接口层一律不许删。首次启动等 4 分钟，避开启动期的迁移和补写。
   */
  let growPrefsTimer = null
  let growPrefsBusy = false

  async function growPrefsTick(reason) {
    if (growPrefsBusy) return
    let d
    try { d = ensureDb() } catch { return }
    const aids = enabledAgentIds(d)
    if (!aids.length) return
    growPrefsBusy = true
    try {
      // 多实例：每人的偏好自己长（够条件才花一次模型调用）
      for (const aid of aids) {
        try {
          const out = await autoGrowPreferences(d, aid)
          if (out.added && out.added.length) {
            __probe('auto-grow-prefs(' + reason + ') aid=' + aid.slice(0, 8) + ' added=' + out.added.length + ' ' + out.added.map((x) => x.tag).join(','))
          }
        } catch (e) {
          __probe('auto-grow-prefs-err(' + reason + '):' + (e && e.message))
        }
      }
    } finally {
      growPrefsBusy = false
    }
  }

  function startGrowPrefsWorker() {
    const boot = setTimeout(() => { growPrefsTick('boot').catch(() => {}) }, 4 * 60 * 1000)
    if (boot.unref) boot.unref()
    growPrefsTimer = setInterval(() => { growPrefsTick('tick').catch(() => {}) }, 10 * 60 * 1000)
    if (growPrefsTimer.unref) growPrefsTimer.unref()
  }

  /**
   * 主人在微信上说话：走完整条回复管线（召回 → 情绪 → 回一句 → 记账），再把这句话发回微信。
   *
   * 为什么用 chatReply：它已经把「记对话、写原文、认关系、压纪要」全做完了，
   * 另起一条会又是一套手脚、又是两份账。它记完这一轮，所以这里不许再记一遍。
   * 发不出去只能吞掉（话已经记了），下一条再说——别因为一次窗口卡住就把这轮拆成两条。
   */
  async function wechatOwnerTurn({ db, aid, name, username, text }) {
    // 先起「正在输入」：对面从这一刻就该看到她在打字，而不是干等她想了十几秒。
    let py = null
    let cfg = null
    try { cfg = getActionConfig(db, aid) } catch { cfg = null }
    try { py = await detectPython() } catch { py = null }
    const wantTyping = !!(cfg && cfg['wechat.typing.enable'] && py && py.ok)
    const typing = wantTyping
      ? startWeChatTyping({ target: name, python: py.cmd, pre: py.pre, leadMs: cfg['wechat.typing.lead_ms'] })
      : null

    let r = null
    try {
      r = await chatReply(db, aid, {
        text,
        speaker: { channel: 'wechat', handle: username },
        conversation_id: 'wechat:' + name,
      })
    } catch (e) {
      if (typing) typing.cancel()
      throw e
    }
    const reply = String((r && r.reply) || '').trim()
    if (!reply) { if (typing) typing.cancel(); return false }

    if (typing) {
      const out = await typing.finish(reply)
      if (out && out.ok) {
        __probe('wechat-typed-reply(' + name + ') sent=' + !!out.sent + ' waited=' + (out.waited_ms || 0) + 'ms chars=' + reply.length)
        return true
      }
      // 打字那条不成就退回普通发送：别为了「像在打字」把这话丢了
      __probe('wechat-typing-fallback(' + name + '): ' + (out && out.code) + ' ' + String((out && out.message) || '').slice(0, 120))
    }

    try {
      const out = await sendViaChannel(db, aid, { channel: 'wechat', target: name, text: reply })
      __probe('wechat-reply(' + name + ') ' + (out && out.status) + ' chars=' + reply.length)
    } catch (e) {
      __probe('wechat-reply-err(' + name + '): ' + (e && e.message))
    }
    return true
  }

  let wechatInboxTimer = null
  let wechatInboxBusy = false
  // 读不到（没装 Python 后端 / 微信没开 / 库没密钥）就退避 10 分钟，别每分钟刷一遍同样的错。
  let wechatInboxBackoffUntil = 0
  let wechatInboxFailLogged = false

  async function wechatInboxTick(reason) {
    if (wechatInboxBusy) return
    if (Date.now() < wechatInboxBackoffUntil) return
    let d
    try { d = ensureDb() } catch { return }
    // 微信只有一个号：只让「默认实例」收。别的实例也是 active（知识库助手就是），
    // 一起轮询 = 同一句话被两个实例各回一遍。
    const all = enabledAgentIds(d)
    const ownerAid = defaultAgentId(d)
    const aids = ownerAid ? all.filter((x) => x === ownerAid) : all.slice(0, 1)
    if (!aids.length) return
    wechatInboxBusy = true
    try {
      for (const aid of aids) {
        let cfg = null
        try { cfg = getActionConfig(d, aid) } catch { cfg = null }
        if (!cfg || cfg['wechat.sealed'] || !cfg['wechat.inbox.enable']) continue
        try {
          // 先找一个真装了 wechatauto 的解释器（机器上可能 3.14 在 PATH 前面、包在 3.12）。
          const py = await detectPython()
          if (!py.ok) {
            if (!wechatInboxFailLogged) {
              wechatInboxFailLogged = true
              __probe('wechat-inbox-skip: 没找到能 import wechatauto 的 Python（' + py.error + '）')
            }
            wechatInboxBackoffUntil = Date.now() + 30 * 60 * 1000
            continue
          }
          const out = await pollWeChatInbox({
            db: d, aid,
            skip: cfg['wechat.inbox.skip'],
            limit: cfg['wechat.inbox.limit'],
            python: py.cmd, pre: py.pre,
            onOwnerMessage: wechatOwnerTurn,
          })
          if (out.added) __probe('wechat-inbox(' + reason + ') aid=' + aid.slice(0, 8) + ' added=' + out.added + ' chats=' + out.chats.join(','))
          if (out.seeded && out.seeded.length) __probe('wechat-inbox-seeded: ' + out.seeded.join(','))
          if (!out.ok) {
            if (!wechatInboxFailLogged) {
              wechatInboxFailLogged = true
              __probe('wechat-inbox-skip: ' + out.note + '（10 分钟后再试）')
            }
            wechatInboxBackoffUntil = Date.now() + 10 * 60 * 1000
          } else {
            wechatInboxFailLogged = false
          }
        } catch (e) {
          __probe('wechat-inbox-err: ' + (e && e.message))
          wechatInboxBackoffUntil = Date.now() + 10 * 60 * 1000
        }
      }
    } finally {
      wechatInboxBusy = false
    }
  }

  function startWeChatInboxWorker() {
    // 启动后先等半分钟：让迁移、补写、桥都先跑完，别在开机那一堆活里再插一个 Python。
    const boot = setTimeout(() => { wechatInboxTick('boot').catch(() => {}) }, 30 * 1000)
    if (boot.unref) boot.unref()
    // 30 秒一轮：60 秒一轮的话，主人发一句要等半分钟才开始回，体感就是「不理我」。
    wechatInboxTimer = setInterval(() => { wechatInboxTick('tick').catch(() => {}) }, 30 * 1000)
    if (wechatInboxTimer.unref) wechatInboxTimer.unref()
    // 开机预热微信窗口：没人催的时候先拉起来，回话时就不用现等那几十秒。
    // 封存期间不预热——不然半夜自己把一个登录窗弹到主人屏幕上。
    const warm = setTimeout(() => {
      try {
        const d = ensureDb()
        const aid = defaultAgentId(d)
        const cfg = aid ? getActionConfig(d, aid) : null
        if (!cfg || cfg['wechat.sealed']) return
      } catch { return }
      wakeWeChatOnce().catch(() => {})
    }, 45 * 1000)
    if (warm.unref) warm.unref()
  }

  let wechatWakeBusy = false

  /** 把微信窗口先拉起来（开机预热）。已经开着就是一次快速探测，不打扰。 */
  async function wakeWeChatOnce() {
    if (wechatWakeBusy) return
    wechatWakeBusy = true
    try {
      if (!fs.existsSync(WECHAT_WIN_SCRIPT)) return
      const py = await detectPython()
      if (!py.ok) return
      await new Promise((resolve) => {
        let child = null
        try {
          child = spawn(py.cmd, [...py.pre, WECHAT_WIN_SCRIPT], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        } catch { resolve(); return }
        let out = ''
        let err = ''
        child.stdout.on('data', (b) => { if (out.length < 200) out += b.toString('utf8') })
        child.stderr.on('data', (b) => { if (err.length < 200) err += b.toString('utf8') })
        child.on('error', () => resolve())
        child.on('close', (code) => {
          __probe('wechat-wake exit=' + code + (out.trim() ? ' ' + out.trim() : '') + (err.trim() ? ' err=' + err.trim().slice(0, 120) : ''))
          resolve()
        })
      })
    } catch (e) {
      __probe('wechat-wake-err ' + (e && e.message))
    } finally {
      wechatWakeBusy = false
    }
  }

  return {
    startExtractionWorker,
    startRelationWorker,
    startDiaryRetryWorker,
    startNightlyWorker,
    startGrowPrefsWorker,
    startWeChatInboxWorker,
    /** 对话刚入队后立刻踢一脚，不等 30 秒轮询。 */
    kickExtractionTick: () => { runExtractionTick() },
    kickRelationReadTick: () => { runRelationReadTick() },
    // 测试 / 诊断用：脚本路径可核对
    _wechatWinScript: () => WECHAT_WIN_SCRIPT,
    _wechatWinScriptExists: () => fs.existsSync(WECHAT_WIN_SCRIPT),
  }
}
