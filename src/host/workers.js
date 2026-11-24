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
import { tickExtraction, tickExtractionMerged } from '../modules/extract_queue.js'
import { runNightly, dueDiaryDays, hasDiaryMaterial } from '../modules/nightly.js'
import { repairPending, repairOldDiaries, defaultDiaryChat } from '../modules/diary.js'
import { getFlag, setFlag, model } from '../kernel.js'
import { localDay } from '../db.js'
import * as R from '../modules/relations.js'
import { tickRelationRead } from '../modules/relations_extract.js'
import { cutAndIngest, cutDayBatch, dayCutGate, latestFragmentAt } from '../modules/event_write.js'
import { localBusy, localComplete, LOCAL_PRIORITY } from '../modules/local_llm.js'
import { cutDayV4 } from '../modules/event_cut_v4.js'
import { writeEventsV2 } from '../modules/event_split_v2.js'

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
        // 2026-11-13：合并读——一次取几条队列、只请模型读一次（flags: memory.extract.merge，默认 5，范围 1~10）。
        let mergeN = 5
        try { mergeN = Math.max(1, Math.min(10, Number(getFlag(d, 'memory.extract.merge')) || 5)) } catch { /* 读不到就用默认 */ }
        await tickExtractionMerged(d, aid, (turns) => ingest(d, aid, { turns }), { max: mergeN })
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

  // ---------------- 事件库：每天切前一天 ----------------

  let eventCutTimer = null
  let eventCutBusy = false

  /**
   * 最近有没有真人在说话。只看 role='user' 的行——assistant 自己的话不算「有人在聊」。
   * 返回 true = 安静，切事可以跑；false = 刚有人说话，让路。
   * 窗口参数 memory.cut.pause.minutes（默认 1 分钟；0 = 不让路）。
   */
  function humanQuiet(db, aid) {
    try {
      // 本地模型正被别的活占着（摘要 / v4 产帧 / 另一轮切事）→ 让路，别叠上去。
      if (localBusy() > 0) return false
      const m = Number(getParam(db, aid, 'memory.cut.pause.minutes'))
      const win = Number.isFinite(m) && m >= 0 ? m : 1
      if (win <= 0) return true
      const row = db.prepare("SELECT created_at FROM chat_turns WHERE agent_id=? AND role='user' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(aid)
      if (!row || !row.created_at) return true
      const last = Date.parse(row.created_at)
      if (!Number.isFinite(last)) return true
      const gap = Date.now() - last
      // 时钟异常（最后一条是未来时间）别把切事永远卡住：当安静处理。
      if (gap < 0) return true
      return gap >= win * 60000
    } catch { return true }
  }

  /**
   * 把「前一天」和「所有没切完的天」逐天切 → 冷库 → 热库 born。
   *
   * 2026-11-13 B2：改用 cutDayBatch——
   *   - 每切完一块就落库、存进度（events.cut.<day>.pos），断了从断点续，不再一次赌到底；
   *   - 不设次数上限：冷库要完整，切不完全部续切，不把一天丢下；
   *   - 欠账补切：近 30 天里有碎片、但没有落 done 的天，全部捡起来切（不只前一天）；
   *   - 续跑：flags 里 state 是 pending / retry 的天，也会被捡起来。
   * 幂等：写入器按稳定 id 去重；即使进度丢了，重切也不会写两遍。
   */
  async function cutEventsTick(reason) {
    if (eventCutBusy) return
    let d
    try { d = ensureDb() } catch { return }
    // 2026-11-18：切事件 v2 影子——只写 events_v2，不碰冷/热库；开关 flags.events.cut.v2.mode=shadow。
    // 旧的冻结照旧（events.cut.enabled=off），所以影子期间只有新表在被写；要回滚就把模式改回 off。
    try {
      const v2Mode = String(getFlag(d, 'events.cut.v2.mode') || 'off')
      if (v2Mode === 'shadow' || v2Mode === 'on') {
        const aidsV2 = enabledAgentIds(d)
        if (aidsV2.length) {
          eventCutBusy = true
          try {
            for (const aid of aidsV2) {
              if (!humanQuiet(d, aid)) continue
              // 影子只切「前一天」。历史天不补：旧链 cold_events 已经覆盖，影子补 20 天要跑好几小时，
              // 而且会挤本地队列。要补某天就手动跑 `scratch/run-shadow-real.mjs <day>`。
              const daysV2 = new Set([localDay(new Date(Date.now() - 86400000))])
              for (const dDay of [...daysV2].sort()) {
                if (!humanQuiet(d, aid)) break
                const last = latestFragmentAt(d, aid, dDay)
                if (!last) continue
                const doneKey = 'events.cut.v2.' + dDay + '.doneAt'
                if (String(getFlag(d, doneKey) || '') === last) continue
                try {
                  // 2026-11-18：可选把事帧的「事」当判缝的第二份参考（flag 默认 off，先离线对比再翻）
                  const withFrame = String(getFlag(d, 'events.cut.v2.with_frame') || 'off') === 'on'
                  // 机器量的那几项边界数据：默认 on；off 时判缝只看原文+记叙（对照用）
                  const withFeat = String(getFlag(d, 'events.cut.v2.with_feat') || 'on') !== 'off'
                  // 2026-11-19：判缝上下文加宽（前/后各 4 句，默认 on；off 回退 2 句）
                  const wideCtx = String(getFlag(d, 'events.cut.v2.wide_ctx') || 'on') !== 'off'
                  // 2026-11-19：件标题后置综合（默认 on；off 回退「第一段标题 + 专名」）
                  const titleSynth = String(getFlag(d, 'events.cut.v2.title.synth') || 'on') !== 'off'
                  const out = await cutDayV4(d, aid, dDay, {
                    withFrame, withFeat, wideCtx, titleSynth,
                    // localComplete 返回 { text, ms, ... }；cutDayV4 要字符串
                    complete: async (req) => {
                      // 2026-11-22 三块排队：切事属于夜间整理块
                      const r = await localComplete(d, { ...req, priority: LOCAL_PRIORITY.split, block: 'night', label: 'cut-v4', timeoutMs: 120000 })
                      return typeof r === 'string' ? r : String((r && r.text) || '')
                    },
                    embed: (list) => model.embed(list),
                  })
                  // 2026-11-19：重切 = 那天旧件清掉重写（默认 on；off 退回「只追加、幂等跳过」）
                  const replace = String(getFlag(d, 'events.cut.v2.replace') || 'on') !== 'off'
                  const w = writeEventsV2(d, aid, { day: dDay, events: out.events, replace })
                  setFlag(d, doneKey, last)
                  __probe('event-cut-v2(' + reason + ') aid=' + aid.slice(0, 8) + ' day=' + dDay
                    + ' seg=' + out.stats.segments + ' events=' + out.stats.events + ' calls=' + out.stats.calls
                    + ' added=' + w.added + ' skipped=' + w.skipped + ' failed=' + w.failed)
                } catch (e) {
                  __probe('event-cut-v2-err(' + reason + ') day=' + dDay + ':' + (e && e.message))
                }
              }
            }
          } finally { eventCutBusy = false }
        }
        return
      }
    } catch { /* 读不到开关就照旧走旧链 */ }
    // 2026-11-17：切事件整体冻结。新基石（docs/功能/2-记忆-写与切事/切事件-基石/）落地前一律不切，
    // 等新写入器接上再回填。开关：flags.events.cut.enabled = off。
    try { if (String(getFlag(d, 'events.cut.enabled') || 'on') === 'off') return } catch { /* 读不到就当没冻结 */ }
    const aids = enabledAgentIds(d)
    if (!aids.length) return
    eventCutBusy = true
    try {
      const day = localDay(new Date(Date.now() - 86400000))
      for (const aid of aids) {
        if (!humanQuiet(d, aid)) {
          __probe('event-cut-pause(' + reason + ') aid=' + aid.slice(0, 8) + ' 有人刚在说话')
          continue
        }
        // 1) 前一天 + 所有挂着没切完的天
        const days = new Set([day])
        try {
          for (const r of d.prepare("SELECT key,value FROM flags WHERE key LIKE 'events.cut.%'").all()) {
            const m = /^events\.cut\.(\d{4}-\d{2}-\d{2})\.(.+?)(\.(state|pos|calls))?$/.exec(String(r.key))
            if (!m || m[2] !== aid) continue
            const v = String(r.value || '')
            if (m[4] === 'state') { if (v !== 'done' && v !== 'hold') days.add(m[1]) }
            else if (v === 'retry') days.add(m[1])
          }
        } catch { /* 读不到旧闸就只切前一天 */ }
        // 2) 欠账：有碎片、但没落 done 的天（包括从没切过的）——冷库要完整，不能留洞
        try {
          const cutoff = localDay(new Date(Date.now() - 30 * 86400000))
          for (const r of d.prepare('SELECT DISTINCT day FROM fragments WHERE agent_id=? AND day>=?').all(aid, cutoff)) {
            if (r.day && String(r.day) < day) days.add(String(r.day))
          }
        } catch { /* 读不到碎片就只切已知的 */ }
        for (const dDay of [...days].sort()) {
          if (dDay > day) continue
          // 切一天可能要几分钟，中间主人来消息就让开，等下一轮再续（进度已落库）。
          if (!humanQuiet(d, aid)) {
            __probe('event-cut-pause-mid(' + reason + ') aid=' + aid.slice(0, 8))
            break
          }
          // 2026-11-14（D39）：闸改了——done 必须带指纹，指纹之后又来了新碎片就要续切。
          // 老闸（只有 agt=done、没有指纹）不批量重切，只补指纹并留一条记录。
          let gate
          try { gate = dayCutGate(d, aid, dDay) } catch { gate = { cut: true, reason: 'gate-error' } }
          if (!gate.cut) {
            if (gate.reason === 'legacy-done' && gate.backfillGap) {
              try { setFlag(d, 'events.cut.' + dDay + '.doneAt', gate.latest) } catch { /* 补不上就下次再补 */ }
              __probe('event-cut-legacy-stamp(' + reason + ') day=' + dDay + ' latest=' + gate.latest)
            }
            continue
          }
          try {
            // 不设次数上限：切不完下一跳接着切，断点续保证不会重付。
            // 每块之间都问一次 humanQuiet：主人一说话就停在这一块之前，下一拍接着切。
            const out = await cutDayBatch(d, aid, dDay, { canContinue: () => humanQuiet(d, aid) })
            if (!out.ok) {
              __probe('event-cut-skip(' + reason + ') aid=' + aid.slice(0, 8) + ' day=' + dDay + ' reason=' + out.reason)
              continue
            }
            const w = out.write || {}
            __probe('event-cut(' + reason + ') aid=' + aid.slice(0, 8) + ' day=' + dDay
              + ' state=' + out.state + ' calls=' + out.calls
              + ' events=' + (out.events || 0) + ' added=' + (w.added || 0)
              + ' skipped=' + (w.skipped || 0) + ' rejected=' + (w.rejected || 0))
          } catch (e) {
            __probe('event-cut-err(' + reason + '):' + (e && e.message))
          }
        }
      }
    } finally {
      eventCutBusy = false
    }
  }

  function startEventCutWorker() {
    // 启动后先补一次（关机期间错过的那天，这里接上），避开启动迁移
    const boot = setTimeout(() => { cutEventsTick('boot').catch(() => {}) }, 60000)
    if (boot.unref) boot.unref()
    // 每半小时兜底：跨天、休眠、准点被挂起都能接上
    eventCutTimer = setInterval(() => { cutEventsTick('tick').catch(() => {}) }, 30 * 60 * 1000)
    if (eventCutTimer.unref) eventCutTimer.unref()
  }

  // ---------------- 判边 worker（2026-11-17） ----------------
  // 切事哪天 done 了，就判那天；跟切事同一个 30 分钟 tick，不靠 23:30 的定时消息、也不等 DSH 会话。
  // 半夜关机也没事：下次开机 tick 看到「哪天 done 了但没判」，自己补上。

  let causalJudgeTimer = null
  let causalJudgeBusy = false
  const CAUSAL_JUDGE_LOOKBACK_DAYS = 3

  async function causalJudgeTick(reason) {
    if (causalJudgeBusy) return
    let d
    try { d = ensureDb() } catch { return }
    causalJudgeBusy = true
    try {
      // 从最近往前找「切完了但还没判」的那一天；一轮只判一天，防卡
      let target = ''
      for (let i = 0; i < CAUSAL_JUDGE_LOOKBACK_DAYS; i++) {
        const day = localDay(new Date(Date.now() - i * 86400000))
        let cut = ''
        try { cut = String(getFlag(d, 'events.cut.' + day + '.state') || '') } catch { cut = '' }
        if (cut !== 'done') continue
        let judged = ''
        try { judged = String(getFlag(d, 'event.causal.judged.' + day) || '') } catch { judged = '' }
        if (judged) continue
        target = day
        break
      }
      if (!target) return
      const aid = (enabledAgentIds(d) || [])[0]
      if (!aid) return
      __probe('causal-judge-start(' + reason + ') day=' + target)
      // 在插件进程内直接判（2026-11-17）：宿主主模型只有这里调得到——独立脚本里没有宿主上下文，
      // 会报 `chain: no adapter for chat`。所以不再 spawn 脚本。
      const E = await import('../modules/event_causal.js')
      const out = await E.judgeDay(d, aid, target, { via: 'main', limit: 400, canContinue: () => humanQuiet(d, aid) })
      // 让路了（主人刚说话 / 本地模型被占着）：判过的已经记进 events，这天不写"判完"标记，下一轮接着判
      if (out.stopped) {
        __probe('causal-judge-yield(' + target + ') calls=' + out.calls + ' pairs=' + out.pairs)
        // 别等半小时：让路之后 1 分钟就再试一次（让路窗口本身就是 1 分钟，主人一安静就能接上）
        const retry = setTimeout(() => { causalJudgeTick('retry').catch(() => {}) }, 60 * 1000)
        if (retry.unref) retry.unref()
        return
      }
      // 一件都没判成：分两种——
      //   待判本来就是 0（这天早判过了）：记标记收工，别每 5 分钟空转；
      //   还有待判但一条没成（模型没通/全失败）：不记标记，下一轮重来。
      if (out.calls === 0 && out.total > 0) {
        if (!out.pending) {
          try { setFlag(d, 'event.causal.judged.' + target, new Date().toISOString()) } catch { /* 记不上也无害 */ }
          __probe('causal-judge-done(' + target + ') 早判过了，没有待判的')
          return
        }
        __probe('causal-judge-nothing(' + target + ') total=' + out.total + ' pending=' + out.pending)
        return
      }
      let wrote = 0
      if (String(getFlag(d, 'event.causal.write') || 'off') === 'on') {
        for (const item of out.judged) {
          try { wrote += E.writeJudgedEdges(d, aid, [item], { nowMs: Date.now() }).written } catch { /* 单条失败不连累 */ }
        }
      }
      try { setFlag(d, 'event.causal.judged.' + target, new Date().toISOString()) } catch { /* 记不上下次会重判，无害 */ }
      __probe('causal-judge(' + target + ') calls=' + out.calls + ' pairs=' + out.pairs + ' usable=' + out.usable + ' wrote=' + wrote + ' judges=' + JSON.stringify(out.judges || {}))
    } catch (e) {
      __probe('causal-judge-err(' + reason + '):' + (e && e.message))
    } finally {
      causalJudgeBusy = false
    }
  }

  function startCausalJudgeWorker() {
    // 启动后等 90 秒（让切事和迁移先跑），之后每 30 分钟看一眼
    const boot = setTimeout(() => { causalJudgeTick('boot').catch(() => {}) }, 90 * 1000)
    if (boot.unref) boot.unref()
    causalJudgeTimer = setInterval(() => { causalJudgeTick('tick').catch(() => {}) }, 30 * 60 * 1000)
    if (causalJudgeTimer.unref) causalJudgeTimer.unref()
  }

  return {
    startExtractionWorker,
    startRelationWorker,
    startDiaryRetryWorker,
    startNightlyWorker,
    startGrowPrefsWorker,
    startWeChatInboxWorker,
    startEventCutWorker,
    startCausalJudgeWorker,
    /** 对话刚入队后立刻踢一脚，不等 30 秒轮询。 */
    kickExtractionTick: () => { runExtractionTick() },
    kickRelationReadTick: () => { runRelationReadTick() },
    // 测试 / 诊断用：脚本路径可核对
    _wechatWinScript: () => WECHAT_WIN_SCRIPT,
    _wechatWinScriptExists: () => fs.existsSync(WECHAT_WIN_SCRIPT),
    _humanQuiet: (db, aid) => humanQuiet(db, aid),
  }
}
