    /* ==================== 模型调用看板（常驻右下角小浮层，2026-11-22）
       主人要的：中文、不丑、别挤输入框、一眼看懂哪个任务在用哪个模型。
       数据来自 /local/live（只读，1.5 秒一次）。收起时只留一行小胶囊。 */
    const MB_C = {
      bg: 'var(--dsw-alias-bg-overlay, #242427)',
      layer: 'var(--dsw-alias-bg-layer-2, #2c2c30)',
      line: 'var(--dsw-alias-border-l1, rgba(255,255,255,.12))',
      ink: 'var(--dsw-alias-label-primary, #e9e9ec)',
      dim: 'var(--dsw-alias-label-secondary, #9a9aa2)',
      acc: 'var(--dsw-alias-brand-primary, #5b8cff)',
      ok: 'var(--dsw-alias-state-success-primary, #3fb950)',
      warn: 'var(--dsw-alias-state-warn-primary, #d29922)',
      bad: 'var(--dsw-alias-state-error-primary, #f85149)',
    }
    // 把机器名翻成人话
    const MB_TASK = {
      'chat': '普通调用', 'affect:judge': '情绪判断', 'affect:summary': '情绪摘要',
      'affect:summary:retry': '情绪摘要(重试)', 'affect:topic': '情绪话题',
      'split:work': '切事摘要', 'split:daily': '切事兜底', 'cut-v4': '切事',
      'warm:chat': '预热14B', 'warm:embed': '预热语义',
      'causal:main': '判边', 'causal:judge': '判边判断', 'vector': '向量',
      'exp': '实验', 'exp-judge': '实验判官', 'judge:frame': '帧判官', 'judge:frame2': '帧判官',
    }
    const MB_TIER = { 1: '聊天', 2: '向量', 3: '实验', 5: '切事', 6: '普通', 7: '批量' }
    const mbTask = (label) => MB_TASK[label] || String(label || '调用').replace(/^affect:/, '情绪:')
    const mbModel = (name) => String(name || '')
      .replace('qwen2.5:14b-instruct', '14B').replace('qwen3-embedding:0.6b', '语义')
      .replace('qwen3:14b', 'qwen3-14B')
    const mbProc = (name) => String(name || '')
      .replace('ollama-noconsole', 'ollama 本体').replace('llama-server', '模型进程').replace('ollama', 'ollama 本体')
    const mbSec = (ms) => {
      const n = Math.max(0, Number(ms) || 0)
      return n < 1000 ? Math.round(n) + '毫秒' : (n / 1000).toFixed(n < 10000 ? 1 : 0) + '秒'
    }
    const mbTime = (iso) => { try { return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }) } catch { return '' } }
    const mbChip = (text, tone) => h('span', {
      style: {
        fontSize: 10.5, lineHeight: '16px', padding: '0 6px', borderRadius: 999, whiteSpace: 'nowrap',
        border: '1px solid ' + (tone === 'ok' ? MB_C.ok : tone === 'warn' ? MB_C.warn : tone === 'bad' ? MB_C.bad : MB_C.line),
        color: tone === 'ok' ? MB_C.ok : tone === 'warn' ? MB_C.warn : tone === 'bad' ? MB_C.bad : MB_C.dim,
      },
    }, text)

    function ModelBoardPanel() {
      const [open, setOpen] = useState(false)
      const [data, setData] = useState(null)
      const [err, setErr] = useState('')
      const [paused, setPaused] = useState(false)
      // 2026-11-22 主人：面板平时不能拖累主进程。
      // 默认只读 /local/status（纯内存快照，不打 ollama、不起 PowerShell）；
      // 进程和显存要点「看进程」才去拉 /local/live，拉完停住，不自动轮询。
      const [okAt, setOkAt] = useState(0)
      const [procsState, setProcsState] = useState(null)

      useEffect(() => {
        let alive = true
        let timer = null
        const pull = async () => {
          if (paused) return
          try {
            const g = await call('POST', '/local/status', {})
            if (!alive) return
            setData({ gateway: g })
            setErr('')
            setOkAt(Date.now())
          } catch (e) {
            if (!alive) return
            setErr(String((e && e.message) || e).slice(0, 60))
          }
        }
        pull()
        timer = setInterval(pull, 1500)
        return () => { alive = false; clearInterval(timer) }
      }, [paused])

      const loadProcs = async () => {
        try {
          const d = await call('POST', '/local/live', {})
          setData(d)
          setProcsState(d.procs || null)
          setOkAt(Date.now())
          setErr('')
        } catch (e) {
          setErr('拉进程失败：' + String((e && e.message) || e).slice(0, 50))
        }
      }

      const g = (data && data.gateway) || {}
      const slots = g.slots || {}
      const running = g.runningItems || []
      const waiting = g.queue || []
      const models = g.models || []
      const procs = (data && data.procs) || procsState || {}
      const pItems = procs.items || []
      const pEvents = (procs.events || []).slice(-3).reverse()
      const recent = (g.recent || []).slice(-5).reverse()
      const curOf = (slot) => running.find((x) => x.slot === slot)
      const stale = okAt > 0 && Date.now() - okAt > 4000
      const dot = err ? MB_C.bad : (stale ? MB_C.warn : (g.up ? MB_C.ok : MB_C.warn))
      const chatCur = curOf('chat')
      const embedCur = curOf('embed')
      // 2026-11-22 主人：本地调用只有几十到几百毫秒，1.5 秒采样很容易全错过，
      // 「在跑 0」不代表没跑。所以主口径改成「最近一分钟跑了几次」。
      const s60 = g.last60s || {}
      const n60chat = (s60.by && s60.by.chat && s60.by.chat.n) || 0
      const n60emb = (s60.by && s60.by.embed && s60.by.embed.n) || 0
      const summary = (chatCur ? '14B 在忙：' + mbTask(chatCur.label || chatCur.lane) : '14B 闲着')
        + ' · ' + (embedCur ? '语义在忙' : '语义闲着')
        + ' · 近一分钟 ' + (n60chat + n60emb) + ' 次'
        + (waiting.length ? ' · ' + waiting.length + ' 个在排' : '')

      const head = h('div', {
        key: 'head',
        onClick: () => setOpen((v) => !v),
        style: { display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', userSelect: 'none' },
      }, [
        h('span', { key: 'd', style: { width: 7, height: 7, borderRadius: 999, background: dot, boxShadow: '0 0 6px ' + dot, flex: '0 0 auto' } }),
        h('span', { key: 't', style: { fontSize: 12, fontWeight: 600 } }, '模型调用'),
        h('span', { key: 's', style: { fontSize: 11, color: MB_C.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 190 } }, summary),
        h('span', {
          key: 'time',
          style: { fontSize: 10, color: stale ? MB_C.warn : MB_C.dim, whiteSpace: 'nowrap' },
        }, okAt ? (stale ? '停了 ' + mbTime(new Date(okAt).toISOString()) : mbTime(new Date(okAt).toISOString())) : '没连上'),
        h('span', { key: 'c', style: { marginLeft: 'auto', fontSize: 10.5, color: MB_C.dim } }, open ? '收起' : '展开'),
      ])

      const slotLine = (slot, title) => {
        const cur = curOf(slot)
        const q = waiting.filter((x) => x.slot === slot)
        const model = (cur && cur.model) || (slot === 'embed' ? 'qwen3-embedding:0.6b' : 'qwen2.5:14b-instruct')
        const pct = cur ? Math.min(100, Math.round((Number(cur.runningMs) || 0) / Math.max(1, Number(cur.timeoutMs) || 1) * 100)) : 0
        return h('div', { key: slot, style: { marginTop: 9 } }, [
          h('div', { key: 'h', style: { display: 'flex', alignItems: 'baseline', gap: 6 } }, [
            h('span', { key: 'm', style: { fontSize: 12, fontWeight: 600, color: MB_C.acc } }, mbModel(model)),
            h('span', { key: 't', style: { fontSize: 10.5, color: MB_C.dim } }, title),
            h('span', { key: 'q', style: { marginLeft: 'auto', fontSize: 10.5, color: MB_C.dim } },
              '在跑 ' + ((slots[slot] || {}).running || 0) + ' · 在排 ' + q.length),
          ]),
          h('div', { key: 'r', style: { display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 2 } }, [
            h('span', { key: 'l', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: cur ? MB_C.ink : MB_C.dim } },
              cur ? mbTask(cur.label || cur.lane) : '空着'),
            cur ? mbChip(MB_TIER[cur.priority] || ('p' + cur.priority)) : null,
            cur ? h('span', { key: 's', style: { fontSize: 10.5, color: MB_C.dim, whiteSpace: 'nowrap' } },
              mbSec(cur.runningMs) + ' / 限 ' + mbSec(cur.timeoutMs)) : null,
          ]),
          h('div', { key: 'bar', style: { height: 3, borderRadius: 2, marginTop: 4, background: MB_C.layer, overflow: 'hidden' } },
            h('div', { style: { width: pct + '%', height: '100%', background: MB_C.acc, transition: 'width .5s linear' } })),
          q.length ? h('div', { key: 'ql', style: { marginTop: 3, display: 'flex', flexDirection: 'column', gap: 2 } },
            q.slice(0, 3).map((x, i) => h('div', { key: i, style: { display: 'flex', gap: 6, fontSize: 10.5, color: MB_C.dim } }, [
              h('span', { key: 'l', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, mbTask(x.label || x.lane)),
              h('span', { key: 'w', style: { marginLeft: 'auto', whiteSpace: 'nowrap' } }, '等了 ' + mbSec(x.waitedMs)),
            ]))) : null,
        ])
      }

      const body = open ? h('div', { key: 'body', style: { marginTop: 8, borderTop: '1px solid ' + MB_C.line, paddingTop: 4 } }, [
        h('div', { key: 'm60', style: { fontSize: 11, color: MB_C.dim, marginTop: 4 } },
          '最近一分钟：14B 跑了 ' + n60chat + ' 次'
          + (s60.by && s60.by.chat && s60.by.chat.maxMs ? '（最长 ' + mbSec(s60.by.chat.maxMs) + '）' : '')
          + ' · 语义跑了 ' + n60emb + ' 次'
          + (s60.lastAt ? ' · 最后一条 ' + mbTime(s60.lastAt) + ' ' + mbTask(s60.lastLabel || '') : '')),
        slotLine('chat', '14B 槽（聊天 / 切事 / 实验）'),
        slotLine('embed', '向量槽'),
        models.length ? h('div', { key: 'models', style: { marginTop: 10 } }, [
          h('div', { key: 't', style: { fontSize: 10.5, color: MB_C.dim } }, '显卡上挂着'),
          h('div', { key: 'l', style: { display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 3 } },
            models.map((m) => mbChip(mbModel(m.name) + ' · ' + ((Number(m.vram || m.size) || 0) / (1024 ** 3)).toFixed(2) + 'G'))),
        ]) : null,
        h('div', { key: 'procs', style: { marginTop: 10 } }, [
          h('div', { key: 't', style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 10.5, color: MB_C.dim } }, [
            '模型进程',
            h('button', {
              key: 'r',
              onClick: (e) => { e.stopPropagation(); loadProcs() },
              style: { appearance: 'none', cursor: 'pointer', fontSize: 10, padding: '0 6px', borderRadius: 999, color: MB_C.dim, background: 'transparent', border: '1px solid ' + MB_C.line },
            }, '看进程'),
            h('span', { key: 'n', style: { marginLeft: 'auto' } }, pItems.length + ' 个' + (pItems.length > 2 ? ' ⚠ 多了' : '')),
          ]),
          h('div', { key: 'l', style: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 3 } },
            pItems.length ? pItems.map((p, i) => h('div', { key: i, style: { display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 11 } }, [
              h('span', { key: 'n', style: { width: 86, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, mbProc(p.name)),
              h('span', { key: 'p', style: { color: MB_C.dim } }, '#' + p.pid),
              h('span', { key: 'm', style: { marginLeft: 'auto', color: MB_C.dim } }, p.memMB + 'M'),
              p.fresh ? mbChip('新起', 'warn') : null,
            ])) : h('span', { style: { fontSize: 11, color: MB_C.dim } }, '没有模型进程在跑')),
        ]),
        pEvents.length ? h('div', { key: 'ev', style: { marginTop: 8 } }, [
          h('div', { key: 't', style: { fontSize: 10.5, color: MB_C.dim } }, '进程变化'),
          ...pEvents.map((e, i) => h('div', { key: 'e' + i, style: { display: 'flex', gap: 6, fontSize: 11, marginTop: 2 } }, [
            mbChip(e.kind === 'start' ? '起来' : '退出', e.kind === 'start' ? 'ok' : 'bad'),
            h('span', { key: 'n' }, mbProc(e.name) + ' #' + e.pid),
            h('span', { key: 'a', style: { marginLeft: 'auto', color: MB_C.dim } }, mbTime(e.at)),
          ])),
        ]) : null,
        recent.length ? h('div', { key: 'rec', style: { marginTop: 8 } }, [
          h('div', { key: 't', style: { fontSize: 10.5, color: MB_C.dim } }, '最近调用'),
          ...recent.map((r, i) => h('div', { key: 'r' + i, style: { display: 'flex', gap: 6, fontSize: 11, marginTop: 2 } }, [
            h('span', { key: 't', style: { color: MB_C.dim, width: 50 } }, mbTime(r.at)),
            h('span', { key: 'l', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, mbTask(r.label || r.lane)),
            h('span', { key: 'm', style: { color: MB_C.dim } }, mbSec(r.ms)),
            mbChip(r.ok ? '好' : '失败', r.ok ? 'ok' : 'bad'),
          ])),
        ]) : null,
        g.swapModel ? h('div', { key: 'swap', style: { marginTop: 8, fontSize: 11, color: MB_C.warn } }, '正在换模型：' + mbModel(g.swapModel)) : null,
        (err || g.lastError) ? h('div', { key: 'err', style: { marginTop: 8, fontSize: 10.5, color: MB_C.bad, wordBreak: 'break-all' } },
          String(err || g.lastError).slice(0, 120)) : null,
        h('div', { key: 'foot', style: { marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, borderTop: '1px dashed ' + MB_C.line, paddingTop: 5 } }, [
          h('span', { key: 'f', style: { fontSize: 10, color: MB_C.dim } }, '只读 · 1.5 秒刷新'),
          h('button', {
            key: 'p',
            onClick: (e) => { e.stopPropagation(); setPaused((v) => !v) },
            style: { marginLeft: 'auto', appearance: 'none', cursor: 'pointer', fontSize: 10.5, padding: '1px 8px', borderRadius: 999, color: MB_C.dim, background: 'transparent', border: '1px solid ' + MB_C.line },
          }, paused ? '继续' : '暂停'),
        ]),
      ]) : null

      return h('div', {
        style: {
          position: 'fixed', right: 18, bottom: 18, zIndex: 60,
          width: open ? 322 : 'auto', maxWidth: 'calc(100vw - 36px)', maxHeight: 'calc(100vh - 36px)', overflowY: 'auto',
          padding: open ? '10px 12px 11px' : '6px 11px', borderRadius: 12,
          background: MB_C.bg, border: '1px solid ' + MB_C.line, color: MB_C.ink,
          boxShadow: '0 16px 42px -22px rgba(0,0,0,.7)', backdropFilter: 'blur(10px)',
          font: '12px/1.5 ui-sans-serif, system-ui, "Microsoft YaHei UI", sans-serif',
        },
      }, [head, body])
    }
