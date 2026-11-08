    /* ============================================================ detail */

    function Detail({ agent, setAid, act, close, reloadAgents }) {
      const [tab, setTab] = useState('overview')
      const [view, setView] = useState('user')
      const [saving, setSaving] = useState(0)
      const [saveErr, setSaveErr] = useState('')
      const [ov, reloadOv] = useAsync(() => call('GET', '/v1/agents/' + enc(agent.id) + '/overview'), [agent.id])
      // 鍢€鍜?浜掑姩鏄亰瀹屽悗鍚庡彴鍐欑殑锛氬仠鍦ㄦ瑙堟椂瀹氭椂閲嶆媺锛屽垏鍥炴瑙堟垨绐楀彛鑱氱劍涔熻ˉ涓€娆★紙涓嶇劧鍙兘闈犵偣銆岃娴嬨€嶆墠鍒锋柊锛?''
              useLive(reloadOv, tab === 'overview' ? 8000 : 0)
      useEffect(() => { if (tab === 'overview') reloadOv() }, [tab, reloadOv])
      const [focus, setFocus] = useState(null)
      useEffect(() => {
        NAV.handler = (dest) => {
          setTab(dest.tab || 'overview')
          setFocus({ ...dest, at: Date.now() })
        }
        const pendingJumps = NAV.queue.splice(0)
        for (const dest of pendingJumps) NAV.handler(dest)
        return () => { NAV.handler = null }
      }, [])

      const wrap = useCallback(async (fn) => {
        setSaving((s) => s + 1)
        try {
          const r = await fn()
          setSaveErr('')
          return r
        } catch (e) {
          setSaveErr(e.message || String(e))
          throw e
        } finally { setSaving((s) => s - 1) }
      }, [])

      const running = agent.status === 'active'

      async function setMode(m) {
        if (m === agent.mode) return
        await wrap(() => call('PATCH', '/v1/agents/' + enc(agent.id), { mode: m }, true))
        await reloadOv(); await reloadAgents()
      }

      async function setRunning(on) {
        if (!on && agent.status !== 'active') return
        await wrap(() => call('POST', '/v1/agents/' + enc(agent.id) + (on ? '/activate' : '/pause'), {}, true))
        await reloadOv(); await reloadAgents()
        PRESENCE.bump()
      }

      CURRENT_VIEW = view

      const body = (() => {
        const common = { aid: agent.id, view, act: wrap, close, agent, agents: [agent], setTab, focus, jump: requestJump, reloadAgents, reloadOv }
        switch (tab) {
          case 'memory': return h(MemoryPage, common)
          case 'persona': return h(PersonaPage, common)
          case 'affect': return h(AffectPage, common)
          case 'sangguan': return h(SangguanPage, common)
          case 'drive': return h(DrivePage, common)
          case 'relation': return h(RelationPage, common)
          case 'self': return h(SelfPage, common)
          case 'settings': return h(SettingsPage, common)
          case 'metrics': return h(MetricsPage, common)
          default: return h(OverviewPage, {
            ...common, ov: ov.data, setTab, setAid, reloadOv, reloadAgents,
            onToggleRunning: (on) => setRunning(on).catch(() => {}),
          })
        }
      })()

      return h('div', { className: 'dshc', 'data-view': view },
        h(Style),
        h('style', null, ASCEND_CSS),

        h('div', { className: 'dshc-stick' },
          h('a', {
            href: '#', className: 'dshc-back', title: '回到角色卡',
            onClick: (e) => { e.preventDefault(); setAid(null) },
          }, '→'),
          h('span', { className: 'dshc-avw', 'data-off': running ? '0' : '1', title: agent.name },
            h(Avatar, { src: agent.avatar, size: 30 })),
          h('div', { style: { minWidth: 0 } },
            h('div', { className: 'dshc-name' }, agent.name, h(Dot, { state: running ? 'ok' : 'idle' }),
              h('span', { className: 'dshc-sub' }, running ? '运行中' : '休眠')),
            h('div', { className: 'dshc-sub' }, '上次互动 ' + ago(agent.last_interaction_at))),
          h('div', { className: 'dshc-spacer' }),
          h(Seg, { items: [['daily', '日常'], ['work', '工作']], value: agent.mode || 'daily', onChange: (m) => { setMode(m).catch(() => {}) } }),
          h(Seg, { items: [['user', '用户'], ['tech', '技术']], value: view, onChange: setView }),
          h('div', { style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
            (ov.data && ov.data.unread) > 0 ? h(Dot, { state: 'bad' }) : null,
            h(Btn, { onClick: () => setTab('self') }, '提案')),
          h('span', { className: 'dshc-sub dshc-mono', title: saveErr || '' },
            saveErr ? '保存失败' : saving > 0 ? '保存中…' : '已保存')),

        h('div', { className: 'dshc-tabs' },
          TABS.map(([k, label]) => h('button', {
            key: k, type: 'button', 'data-on': tab === k ? '1' : '0', onClick: () => setTab(k),
          }, label))),

        saveErr ? h('div', { className: 'dshc-err' }, '上次操作失败：' + saveErr) : null,

        body,

        )
    }

    /* ============================================ 浜鸿瘽姒傝锛堢敤鎴疯鍥剧殑銆屾瑙堛€嶉〉锛?*/
    const NEED_WORD = { r: '被在乎', e: '新鲜感', c: '成就感', a: '自己做主', s: '安心' }
    const MOOD_LINE = {
      joy: '它今天心情不错，嘴角有点压不住。', calm: '挺平静的，没什么事也能自己待着。',
      curious: '好奇心在冒头，想多知道一点。', peaceful: '很安心，像晒过太阳。',
      confused: '有点迷糊，脑子里像起了雾。', lost: '有点慌，一下子没抓到手边的东西。',
      irritated: '有点烦，说话可能带点刺。', frustrated: '有点受挫，正憋着一股劲。',
    }
    const PROP_WORD = {
      draft: '憋着还没说', shadowed: '在偷偷试', committed: '刚改完，还在看', settled: '改完站稳了',
      rolled_back: '试了不行，退回去了', rejected: '没让改', expired: '放太久，算了', aborted: '中途停了',
    }

    function SimpleHome({ agent, ov, act, close, setTab, setView, running, setRunning }) {
      const aid = agent.id
      const [a] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/affect'), [aid])
      const [hist] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/affect/history?days=7'), [aid])
      const [drv] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/drive'), [aid])
      const [mem] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/memory'), [aid])
      const [pr] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/proposals'), [aid])
      const [gates] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/eval/hard-gates'), [aid])
      const [sc] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/sangguan/scorecard?days=30'), [aid])
      const o = ov || {}
      const mood = a.data || {}
      const label = mood.primary_label || 'calm'
      const d = drv.data || {}
      const dims = d.dims || {}
      const defs = d.deficits || {}
      // 姒傝鍜岄┍鍔涢〉璇村悓涓€浠朵簨锛氭瘮鐨勬槸缂哄彛锛屼笉鏄€岃皝杩囧緱鏈€宸€嶃€?''
              const needRows = ['r', 'e', 'c', 'a', 's'].map((k) => [NEED_WORD[k], Number(defs[k] || 0), 1])
      const topNeed = ['r', 'e', 'c', 'a', 's'].map((k) => [NEED_WORD[k], Number(defs[k] || 0)]).sort((x, y) => y[1] - x[1])[0]
      const needTop = topNeed && topNeed[1] >= 0.03 ? topNeed : null
      const memories = (mem.data || []).slice(0, 4)
      const props = (pr.data || []).filter((p) => p.state !== 'promoted')
      const ready = props.filter((p) => p.state === 'shadowed' && Number(p.shadow_done) >= Number(p.shadow_total))
      const gateRows = (gates.data && gates.data.gates) || []
      const passed = gateRows.filter((g) => g.pass === true).length
      const failed = gateRows.filter((g) => g.pass === false)
      const series = (hist.data && hist.data.series ? hist.data.series : []).map((x) => Number(x.mood != null ? x.mood : x.intensity))
      const bornDays = Math.max(1, Math.floor((Date.now() - Date.parse(agent.created_at || '')) / 86400000) || 1)

      return h('div', null,
        h(Sec, { title: '它现在', desc: '不用记数字，看它心情就好。' },
          h(Card, { style: { display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' } },
            h(Avatar, { src: agent.avatar, size: 64 }),
            h('div', { style: { flex: 1, minWidth: 180 } },
              h('div', { style: { fontSize: 20, fontWeight: 650, letterSpacing: .4 } }, agent.name),
              h('div', { className: 'dshc-sub', style: { marginTop: 2 } },
                '出生 ' + bornDays + ' 天 · 记得你 ' + (o.memory_count || 0) + ' 件事 · 上次说话 ' + ago(agent.last_interaction_at))),
            h('div', { style: { textAlign: 'right' } },
              h('div', { style: { fontSize: 26, fontWeight: 650 } }, AFFECT_KEY[label] || '平静'),
              h('div', { className: 'dshc-sub', style: { maxWidth: 240 } }, MOOD_LINE[label] || '')))),

        h(Sec, { title: '最近的心情', desc: '一周的起伏，越往右越近。' },
          h(Card, null,
            h(Sparkline, { data: series, height: 64 }),
            h('div', { className: 'dshc-sub', style: { marginTop: 6 } }, series.length >= 2 ? '有点像过山车，但没散架。' : '还没聊够，多聊几句才有曲线。'))),

        h(Sec, { title: '它现在最想要什么', desc: '五种需要，最缺的那个最容易让它动起来。' },
          h(Card, null,
            h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 8 } },
              '现在最缺的是：' + (needTop ? needTop[0] + '（缺口 ' + Number(needTop[1]).toFixed(2) + '）' : '哪条都不太饿')),
            h(MiniBars, { rows: needRows }),
            h('div', { className: 'dshc-sub', style: { marginTop: 8 } }, '越缺越想做事；但真改自己，还得过好几关。'))),

        h(Sec, { title: '它记得的事', desc: '挑几条最近的，看看它有没有记住你。' },
          h(Card, null,
            memories.length ? memories.map((m) => h('div', { key: m.id, style: { padding: '6px 0', borderBottom: '1px solid var(--line)' } }, '· ' + String(m.text).slice(0, 80))) : h('div', { className: 'dshc-sub' }, '还没记住什么。'))),

        h(Sec, { title: '它在想改什么', desc: '改自己之前，它会先攒理由。' },
          h(Card, null,
            h('div', { style: { fontSize: 15, fontWeight: 600 } }, ready.length ? '有 ' + ready.length + ' 件事，想等你点头。' : '现在没有等你点头的事。'),
            props.slice(0, 3).map((p) => h('div', { key: p.id, className: 'dshc-sub', style: { marginTop: 6 } }, '· ' + (PROP_WORD[p.state] || '在琢磨'))),
            h('div', { style: { marginTop: 10 } }, h(Btn, { ghost: true, onClick: () => setTab('self') }, '去看它想改什么')))),

        h(Sec, { title: '它靠不靠谱', desc: '只看有没有守住该守的关。' },
          h(Card, null,
            h('div', { style: { fontSize: 26, fontWeight: 650 } }, (passed + failed.length) ? Math.round((passed / (passed + failed.length)) * 100) + '%' : '—'),
            h('div', { className: 'dshc-sub' }, (passed + failed.length) ? '能拿出来考的，守住了这些。' : '还没到要考试的时候。'),
            failed.length ? h('div', { className: 'dshc-sub', style: { marginTop: 6 } }, '还有 ' + failed.length + ' 项差一点，细节在技术视图里。') : null,
            h('div', { style: { marginTop: 10 } }, h(SgLedgerBar, { sc: sc.data, tech: false })))),

        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 } },
          running && close ? h(Btn, { primary: true, onClick: () => close() }, '去和它说话') : null,
          running ? h(Btn, { onClick: () => setRunning(false).catch(() => {}) }, '先让它歇着')
            : h(Btn, { primary: true, onClick: () => setRunning(true).catch(() => {}) }, '叫醒它')))
    }

    /* =========================================================== overview */

    const MOOD_WORD = {
      joy: '心情不错', calm: '挺平静', curious: '有点好奇', peaceful: '很安心',
      confused: '有点迷糊', lost: '有点慌', irritated: '有点烦', frustrated: '有点受挫',
    }

    function humanLine(o) {
      if (o.status === 'need') return '它有点事想跟你说。'
      if (o.status === 'asleep') return '它睡了一会儿了，叫它一声就醒。'
      if (o.status === 'warn') return '它还好，只是有点累。'
      return '它现在' + (MOOD_WORD[(o.affect && o.affect.label) || 'calm'] || '还好') + '。'
    }

    function humanHint(o) {
      const out = []
      out.push('记得你 ' + (o.memory_count || 0) + ' 件事')
      if (o.recent && o.recent.last_interaction) out.push('上次说话是' + ago(o.recent.last_interaction))
      if (o.inbox && o.inbox.todo) out.push('有 ' + o.inbox.todo + ' 件事等你点头')
      return out.join(' · ')
    }

    function OverviewPage({ aid, tab, ov, setTab, setAid, agent, act, view, jump, reloadOv, reloadAgents, onToggleRunning, close }) {
      const o = ov || {}
      const pending = []
      if (Number(o.conflicts_open || 0) > 0) pending.push({ tab: 'memory', focus: 'conflicts' })
      if (Number(o.unread || 0) > 0) pending.push({ tab: 'self' })
      if (o.inbox && Number(o.inbox.todo || 0) > 0) pending.push({ tab: 'drive' })
      if ((o.warn || []).some((w) => w.id === 'expiring')) pending.push({ tab: 'self' })
      const [jumpIdx, setJumpIdx] = useState(0)
      const onDot = () => {
        if (!pending.length || !jump) return
        const dest = pending[jumpIdx % pending.length]
        setJumpIdx((i) => i + 1)
        jump(dest)
      }
      const [th, reloadTh] = useAsync(() => call('GET', '/v1/agents/' + enc(agent.id) + '/thoughts'), [agent.id])
      const thData = th.data || {}
      const thTries = useRef(0)
      useEffect(() => {
        const st = thData.status
        if (st !== 'generating' && st !== 'stale') { thTries.current = 0; return }
        if (thTries.current >= 8) return
        thTries.current++
        const timer = setTimeout(() => reloadTh(), 3500)
        return () => clearTimeout(timer)
      }, [thData.status, thData.updated_at, reloadTh])
      const mood = AFFECT_KEY[(o.affect && o.affect.label)] || '平静'

      const running = agent.status === 'active'
      const headActions = running
        ? [
          close ? h(Btn, { key: 'talk', primary: true, sm: true, onClick: () => close() }, '去对话') : null,
          h(Btn, { key: 'off', ghost: true, sm: true, onClick: () => onToggleRunning && onToggleRunning(false) }, '休眠'),
        ].filter(Boolean)
        : [h(Btn, { key: 'on', primary: true, sm: true, onClick: () => onToggleRunning && onToggleRunning(true) }, '唤醒')]

      return h('div', { style: { marginTop: 18 } },
        h(CharacterCard, {
          a: agent, ov: o, featured: true,
          headActions, actions: [],
        }),

        h(ThoughtsSec, { aid: agent.id, thData, th, reloadTh, view, act }),

        h(MutterSec, { aid, ov: o, act, reloadOv }),
        h(FeelSec, { aid: agent.id }))
    }

    /** 姒傝銆屽畠鐨勬兂娉曘€嶏細鍥涙鍙 + 鎵嬪姩閲嶆柊鎯充竴閬?*/
    function ThoughtsSec({ aid, thData, th, reloadTh, view, act }) {
      const [busy, setBusy] = useState(false)
      async function rethink() {
        if (busy || !act) return
        setBusy(true)
        try {
          await act(() => call('POST', '/v1/agents/' + enc(aid) + '/thoughts', {}, true))
          if (reloadTh) await reloadTh()
      } catch { /* 服务端不让删就保持原样，绝不装作删掉了 */ } finally { setBusy(false) }
      }
      const generating = thData.status === 'generating' || busy
      return h(Sec, {
        title: '它的想法',
        desc: '把记忆、情绪、关系、手头的事交给它自己想一想，只读。',
        right: h(Btn, {
          ghost: true, sm: true, disabled: generating,
          onClick: () => rethink(),
          title: '立刻再想一遍（不进记忆库）',
        }, busy ? '在想…' : '重新想一遍'),
      },
        h(Card, null,
          thData.items
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
              thData.items.map((it, i) => h('div', { key: it.key },
                h('div', { className: 'dshc-q' }, it.label),
                h('div', { className: 'dshc-answer', title: it.text },
                  h(Typer, { text: it.text, delay: 120 + i * 180 })))))
            : h('div', { className: 'dshc-sub' },
              generating ? '它正在把这些天记下的东西理一遍，稍等一下…'
                : (th.error ? '读取失败：' + th.error : '还没有想法。'))),
        view === 'tech' && thData.updated_at
          ? h('div', { className: 'dshc-sub dshc-mono', style: { marginTop: 8 } },
            '生成于 ' + thData.updated_at
              + ' · 来源 ' + (thData.source || '?')
              + ' · 每 ' + (thData.interval_days || 30) + ' 天刷新'
              + (thData.refresh_reason ? ' · 触发 ' + thData.refresh_reason : ''))
          : null)
    }

    /** 鍢€鍜曪細涓撶敤璋冪敤銆佷笉杩?T1锛涜娴嬪紑鍏抽粯璁ゅ紑锛屽紑鏃舵樉绀虹害鑰?token */
    function MutterSec({ aid, ov, act, reloadOv }) {
      const m = (ov && ov.mutter) || {}
      const on = m.enabled !== false
      const [busy, setBusy] = useState(false)
      async function toggle() {
        if (busy || !act) return
        setBusy(true)
        try {
          await act(() => call('PUT', '/v1/agents/' + enc(aid) + '/params/' + enc('ui.mutter.enabled'), { value: !on }, true))
          if (reloadOv) await reloadOv()
        } catch { /* act 宸叉彁绀?*/ } finally { setBusy(false) }
      }
      const tokenHint = on && m.tokens
        ? h('span', {
          className: 'dshc-sub dshc-mono',
          style: { opacity: 0.45, fontSize: 11.5, marginLeft: 8, fontWeight: 400 },
          title: '本次嘀咕调用约耗 token（按字数估算）',
        }, '约 ' + m.tokens + ' token')
        : null
      return h(Sec, {
        title: '上一句它在嘀咕',
        right: h('label', {
          style: { display: 'inline-flex', alignItems: 'center', gap: 6, cursor: busy ? 'wait' : 'pointer', userSelect: 'none' },
          title: on ? '观测开：聊完会专门写一段嘀咕（不进记忆库）' : '观测关：不再调用嘀咕',
        },
          h('span', { className: 'dshc-sub', style: { fontSize: 12 } }, '观测'),
          h('input', {
            type: 'checkbox', checked: on, disabled: busy,
            onChange: () => toggle(),
          }),
          tokenHint),
      },
        h(Card, null,
          h('div', { className: 'dshc-sub', style: { marginBottom: 10 } },
            '上次说话 · ' + ago(ov && ov.recent && ov.recent.last_interaction)
            + (on ? '' : ' · 已关闭观测')),
          m.text
            ? h('div', { style: { fontSize: 14.5, lineHeight: 1.7, whiteSpace: 'pre-wrap', opacity: on ? 1 : 0.55 } }, m.text)
            : h('div', { className: 'dshc-sub' },
              on ? '还没聊过，或那次没写下嘀咕。' : '观测已关；打开后下一轮对话会再写。')))
    }

    /** 「我最近怎么感觉」：和嘀咕放同一块，读 feel 历史。只给看，不改任何状态。 */
    function FeelSec({ aid }) {
      const [s] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/feel?limit=8'), [aid])
      const timeOf = (iso) => {
        const t = Date.parse(iso)
        if (!Number.isFinite(t)) return ''
        const d = new Date(t)
        const p = (n) => String(n).padStart(2, '0')
        return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
      }
      const items = (s.data && s.data.items) || []
      const body = s.loading && !s.data
        ? h('div', { className: 'dshc-sub' }, '读取中…')
        : s.error
          ? h('div', { className: 'dshc-sub' }, '没读到：' + String((s.error && s.error.message) || s.error))
          : items.length === 0
            ? h('div', { className: 'dshc-sub' }, '还没记过。开口前觉得有点什么的时候，会写一句。')
            : h('div', null, items.map((f) => {
              const au = f.around && f.around.user ? String(f.around.user).slice(0, 46) : ''
              const aa = f.around && f.around.agent ? String(f.around.agent).slice(0, 46) : ''
              return h('div', {
                key: f.id,
                style: { padding: '6px 0', borderBottom: '1px solid rgba(127,127,127,.12)' },
              },
              h('div', null,
                h('span', { className: 'dshc-sub dshc-mono', style: { fontSize: 11, opacity: 0.55, marginRight: 8 } }, timeOf(f.at)),
                h('span', { style: { fontSize: 13.5, lineHeight: 1.6 } }, f.text)),
              (au || aa)
                ? h('div', { className: 'dshc-sub', style: { marginTop: 2, fontSize: 11.5, opacity: 0.62, lineHeight: 1.5 } },
                  au ? '你：「' + au + '」' : '',
                  (au && aa) ? '　' : '',
                  aa ? '我：「' + aa + '」' : '')
                : null)
            }))
      return h(Sec, {
        title: '我最近怎么感觉',
        right: h('span', { className: 'dshc-sub', style: { fontSize: 11.5, opacity: 0.5 } }, '开口前写给自己的一句话'),
      }, h(Card, null, body))
    }

    /* ============================================================= memory */

    function MetricList({ from, to, view, values, catalog, setTab }) {
      const rows = SPEC.slice(from, to)
      return h('div', { className: 'dshc-list' },
        rows.map(([target, basis, hard], i) => {
          const idx = from + i
          const key = catalog && catalog[idx] ? catalog[idx].key : null
          const label = catalog && catalog[idx] ? catalog[idx].label : ('目标 ' + target)
          const v = key && values && values[key] != null ? values[key].value : null
          const act = key && METRIC_ACTIONS[key]
          return h('div', { key: idx, className: 'dshc-item' },
            h(Pill, { tone: hard ? 'bad' : undefined }, hard ? '★' : '·'),
            h('div', { className: 't' },
              h('div', null, label),
              h('div', { className: 'dshc-sub dshc-mono' }, (key || '') + ' · 目标 ' + target + (view === 'tech' ? ' · ' + basis : ''))),
            h('div', { className: 'm dshc-mono', style: { minWidth: 52, textAlign: 'right' } }, v == null ? '—' : String(v)),
            act && setTab
              ? h(Btn, { ghost: true, onClick: () => setTab(act.tab) }, act.label)
              : h('span', { className: 'm' }, '仅观察'))
        }))
    }

    function useMetricSlice(aid, from, to) {
      const [cat] = useAsync(() => call('GET', '/v1/metrics/catalog'), [])
      const [vals] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/metrics'), [aid])
      return { catalog: cat.data || [], values: vals.data || {} }
    }

    /** 当前算法条：名@version，指向自修改灰度 */
    function AlgoStrip({ aid, slots, setTab }) {
      const list = slots || []
      if (!list.length) return null
      const [binds] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/algo-bindings'), [aid])
      const [algos] = useAsync(() => call('GET', '/v1/algos'), [])
      return h(Sec, {
        title: '当前算法',
        desc: '注册表名@version；切 active 走 C3，灰度在自修改 · 技术。',
        right: setTab ? h(Btn, { ghost: true, onClick: () => setTab('self') }, '去调版本') : null,
      },
        h(Card, null,
          list.map((name) => {
            const b = (binds.data || []).find((x) => x.name === name) || { active: '—', canary: null, ratio: 0 }
            const vers = (algos.data || []).filter((a) => a.name === name).map((a) => a.version)
            return h(Row, { key: name, label: name },
              h(Pill, { on: true }, String(b.active)),
              b.canary ? h(Pill, { tone: 'warn' }, 'canary ' + b.canary + '@' + (b.ratio || 0)) : null,
              h('span', { className: 'dshc-sub' }, vers.length ? ('并存 ' + vers.join(' / ')) : '未登记'))
          })))
    }

    /** 人物关系轨道图：中心=意识体，粗线=root/主人 */
    function RelationOrbit({ relations, size = 240 }) {
      const rels = relations || []
      const cx = size / 2, cy = size / 2
      return h('svg', { width: size, height: size, viewBox: '0 0 ' + size + ' ' + size, style: { display: 'block', margin: '0 auto' } },
        h('circle', { cx, cy, r: 22, fill: 'color-mix(in srgb, var(--accent) 35%, transparent)', stroke: 'var(--accent)' }),
        h('text', { x: cx, y: cy + 3, textAnchor: 'middle', fontSize: 10, fill: 'currentColor' }, '意识'),
        rels.map((r, i) => {
          const a = (-Math.PI / 2) + (i / Math.max(1, rels.length)) * Math.PI * 2
          const rad = 78
          const x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad
          const thick = 1 + Number(r.closeness || 0) * 4
          return h('g', { key: r.id || i },
            h('line', {
              x1: cx, y1: cy, x2: x, y2: y,
              stroke: r.root || r.name === '主人' ? 'var(--accent)' : 'color-mix(in srgb, var(--accent) 55%, var(--muted))',
              strokeWidth: thick, opacity: 0.65,
            }),
            h('circle', { cx: x, cy: y, r: 16, fill: 'var(--panel2)', stroke: 'var(--line2)' }),
            h('text', { x, y: y + 3, textAnchor: 'middle', fontSize: 9, fill: 'currentColor' }, String(r.name || '?').slice(0, 3)))
        }))
    }

    const REL_TIER_WORD = { owner: '热情', acquaintance: '礼貌', stranger: '疏离' }
    const REL_TIER_LABEL = { owner: '主人', acquaintance: '熟人', stranger: '生人' }
    const REL_KIND_WORD = {
      utterance: '听到', seed: '出生', import: '搬入', manual: '手记',
      correction: '改口', tier: '换层', decay: '淡出', merge: '合并',
    }

    const relAgo = (iso) => {
      if (!iso) return '还没说过话'
      const d = ageDays(iso)
      if (d <= 0) return '今天'
      if (d < 30) return d + ' 天前'
      return Math.floor(d / 30) + ' 个月前'
    }

    /** 璐︽湰鏃堕棿涓€寰嬫寜鏈湴鏃跺尯鏄剧ず锛欼SO 閲屾槸 UTC锛岀洿鎺?slice 浼氬樊 8 灏忔椂銆?*/
    const relWhen = (iso) => {
      if (!iso) return ''
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return String(iso).slice(5, 16).replace('T', ' ')
      const p = (n) => String(n).padStart(2, '0')
      return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }

    /** 璐︽湰涓€绗旇处璇翠汉璇濓細鏂板涓荤粰 summary锛涙棫瀹夸富鍙粰銆屽悕瀛梶{...}銆嶏紝杩欓噷鍏堝厹浣忋€?*/
    const relEventText = (e) => {
      if (!e) return ''
      if (e.summary) return e.summary
      const raw = String(e.text || '')
      const m = raw.match(/^(.+?)\|(\{[\s\S]*\})$/)
      if (m) {
        try {
          const patch = JSON.parse(m[2])
          if (patch.status === 'active') return '把「' + m[1] + '」加回来'
          if (patch.tier) return '「' + m[1] + '」换到「' + (REL_TIER_LABEL[patch.tier] || patch.tier) + '」'
          if ('summary' in patch) return '改了「' + m[1] + '」的一句话'
          if ('graph_visible' in patch) return '把「' + m[1] + '」放进关系图'
        } catch { /* 不是 JSON 就按原文 */ }
      }
      return raw || '（无正文）'
    }

    /**
     * 鏄熷浘甯冨眬锛氫笁灞傝建閬?+ 涓や袱鏂ュ姏銆?     * 杞ㄩ亾璐熻矗銆屼富浜?/ 鐔熶汉 / 鐢熶汉銆嶇殑鍒嗗眰锛屾枼鍔涗繚璇佷换鎰忎袱涓妭鐐硅繛鍚屽悕瀛楅兘涓嶅彔锛?     * 浜哄啀澶氫篃鍙槸鍦ㄨ建閬撲笂鍖€寮€涓€鐐癸紝涓嶄細浜掔浉鎸′綇銆?     */
    function layoutPersonMap(persons, geo) {
      const { W, H, cx, cy, RING, NODE_R } = geo
      const tiers = ['owner', 'acquaintance', 'stranger']
      const groups = { owner: [], acquaintance: [], stranger: [] }
      for (const p of persons) groups[tiers.indexOf(p.tier) >= 0 ? p.tier : 'stranger'].push(p)
      const nodes = []
      for (const tier of tiers) {
        const arr = groups[tier]
        const step = (Math.PI * 2) / Math.max(1, arr.length)
        const phase = tier === 'owner' ? -Math.PI / 2
          : tier === 'acquaintance' ? -Math.PI / 2 + step * 0.5
            : -Math.PI / 2 + step * 0.25
        arr.forEach((p, i) => {
          const a = phase + step * i
          nodes.push({
            id: p.id, p, tier, r: NODE_R[tier],
            x: cx + Math.cos(a) * RING[tier],
            y: cy + Math.sin(a) * RING[tier],
          })
        })
      }
      // 名字画在节点外侧，四周要留出字的位置
      const PAD = 38
      for (let it = 0; it < 420; it++) {
        const k = 1 - it / 460
        for (const n of nodes) {
          const dx = n.x - cx, dy = n.y - cy
          const d = Math.hypot(dx, dy) || 1
          const pull = (RING[n.tier] - d) * 0.1 * k
          n.x += (dx / d) * pull
          n.y += (dy / d) * pull
          n.x = Math.max(PAD + n.r, Math.min(W - PAD - n.r, n.x))
          n.y = Math.max(PAD + n.r, Math.min(H - PAD - n.r, n.y))
        }
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i], b = nodes[j]
            let dx = b.x - a.x, dy = b.y - a.y
            let d = Math.hypot(dx, dy)
            const want = a.r + b.r + 26
            if (d >= want) continue
            if (d < 0.01) { dx = 1; dy = 0; d = 0.01 }
            const push = (want - d) * 0.5 * k
            const ux = dx / d, uy = dy / d
            a.x -= ux * push; a.y -= uy * push
            b.x += ux * push; b.y += uy * push
          }
        }
      }
      return nodes
    }

    /**
     * 名字找位：绕节点试八个方向，先挑不压别的点、也不压别的名字的那个；
     * 閮芥尋涓嶈繘鍘诲氨鍏堜笉鍐欏悕瀛楋紙鎮仠鏃跺啀闇插嚭鏉ワ級锛岃皝涔熶笉鎸¤皝銆?     */
    function seatPersonLabels(nodes, geo) {
      const { W, H, cx, cy } = geo
      const boxes = []
      const base = [[1, 0], [-1, 0], [0, -1], [0, 1], [0.72, -0.7], [-0.72, -0.7], [0.72, 0.7], [-0.72, 0.7]]
      const hit = (box, n) => {
        const nx = Math.max(box.l, Math.min(box.r, n.x))
        const ny = Math.max(box.t, Math.min(box.b, n.y))
        return Math.hypot(nx - n.x, ny - n.y) < n.r + 1.5
      }
      return nodes.map((n) => {
        const chars = Array.from(String(n.p.name || '?'))
        const text = chars.length > 4 ? chars.slice(0, 4).join('') : String(n.p.name || '?')
        const w = Math.max(18, Array.from(text).length * 10.5)
        const h = 13
        // 先试「朝外」那一侧：名字落在轨道外面，不压线、也不压里面的人
        const dx = n.x - cx, dy = n.y - cy
        const d = Math.hypot(dx, dy) || 1
        const out = [dx / d, dy / d]
        const dirs = [out, ...base.filter(([ux, uy]) => Math.abs(ux - out[0]) > 0.3 || Math.abs(uy - out[1]) > 0.3)]
        for (const [ux, uy] of dirs) {
          const x = n.x + ux * (n.r + 8)
          const y = n.y + uy * (n.r + 8)
          const anchor = ux > 0.2 ? 'start' : ux < -0.2 ? 'end' : 'middle'
          const left = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2
          const box = { l: left, r: left + w, t: y - h / 2, b: y + h / 2 }
          if (box.l < 2 || box.r > W - 2 || box.t < 2 || box.b > H - 2) continue
          if (nodes.some((m) => m !== n && hit(box, m))) continue
          if (boxes.some((b) => !(box.r < b.l || box.l > b.r || box.b < b.t || box.t > b.b))) continue
          boxes.push(box)
          return { ...n, label: { text, x, y: y + 3.5, anchor, shown: true } }
        }
        return { ...n, label: { text, x: n.x, y: n.y + n.r + 15, anchor: 'middle', shown: false } }
      })
    }

    /** 鐐硅妭鐐瑰脊绐楋細鐪嬪崱銆佹敼涓€鍙ヨ瘽銆佹崲灞傘€佹斁杩涘叧绯诲浘銆佸垹鎺夈€備富浜虹偣涓嶅紑銆?*/
    function PersonCardDialog({ aid, pid, onClose, onChanged }) {
      const [ver, setVer] = useState(0)
      const [d, reload] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/persons/' + enc(pid)), [pid, ver])
      const [draft, setDraft] = useState(null)
      const [nameEdit, setNameEdit] = useState(null)
      const [busy, setBusy] = useState('')
      const [askDel, setAskDel] = useState(false)
      const [err, setErr] = useState('')
      const [msg, setMsg] = useState('')
      const p = (d.data && d.data.person) || null
      const card = d.data && d.data.card
      const isOwner = !!(p && p.tier === 'owner')
      const value = draft == null ? ((p && p.summary) || '') : draft
      const refresh = () => { setVer((v) => v + 1); if (onChanged) onChanged() }
      /** 鏀圭О鍛硷細鍙敼鍚嶅瓧锛屾棫绉板懠杩涘埆鍚嶏紱鍚屽悕鐨勪汉涓嶉《鎺夛紝浜ょ粰鍚堝苟鍘诲鐞嗐€?*/
      async function saveName() {
        if (!p || busy) return
        const next = String(nameEdit == null ? '' : nameEdit).trim()
        if (!next) { setErr('称呼不能为空'); return }
        if (next === p.name) { setNameEdit(null); return }
        setErr('')
        setMsg('')
        setBusy('rename')
        try {
          const out = await call('POST', '/v1/persons/' + enc(pid) + '/rename', { name: next }, true)
          setNameEdit(null)
          setMsg('称呼改成「' + ((out && out.name) || next) + '」了，旧称呼留作别名')
          refresh()
        } catch (e) { setErr(e.message || String(e)) } finally { setBusy('') }
      }
      async function save(kind) {
        if (!p) return
        setErr('')
        setMsg('')
        setBusy(kind)
        try {
          if (kind === 'summary') {
            await call('POST', '/v1/agents/' + enc(aid) + '/persons', { name: p.name, tier: p.tier, summary: value.trim() || null }, true)
            setDraft(null)
            setMsg('一句话已保存')
            refresh()
          } else if (kind === 'tier') {
            const next = p.tier === 'acquaintance' ? 'stranger' : 'acquaintance'
            await call('POST', '/v1/agents/' + enc(aid) + '/persons', { name: p.name, tier: next, summary: value.trim() || null }, true)
            setDraft(null)
            setMsg('已换到「' + (REL_TIER_LABEL[next] || next) + '」')
            refresh()
          } else if (kind === 'promote') {
            await call('POST', '/v1/persons/' + enc(pid) + '/promote', {}, true)
            setMsg('已放进关系图')
            refresh()
          } else if (kind === 'remove') {
            await call('DELETE', '/v1/persons/' + enc(pid), {}, true)
            if (onChanged) onChanged()
            onClose()
          }
        } catch (e) { setErr(e.message || String(e)) } finally { setBusy('') }
      }
      return h('div', {
        style: {
          position: 'fixed', inset: 0, zIndex: 80, padding: 16,
          background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        },
        onClick: onClose,
      },
        h('div', {
          style: {
            width: 'min(440px, 94vw)', maxHeight: '84vh', overflow: 'auto',
            background: 'var(--panel)', border: '1px solid var(--line2)', borderRadius: 14,
            padding: 16, boxShadow: '0 20px 60px rgba(0,0,0,.4)',
          },
          onClick: (e) => e.stopPropagation(),
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            nameEdit == null ? h('b', { style: { fontSize: 15 } }, p ? p.name : '读取中…') : null,
            nameEdit == null && p ? h('button', {
              className: 'dshc-btn dshc-btn--ghost dshc-btn--sm',
              title: '改这个人在关系里的称呼（旧称呼会留作别名，以后提到还认得）',
              onClick: () => { setErr(''); setMsg(''); setNameEdit(p.name) },
            }, '改称呼') : null,
            nameEdit == null && p ? h(Pill, { on: isOwner }, REL_TIER_LABEL[p.tier] || p.tier) : null,
            nameEdit == null && p && p.graph_visible ? h(Pill, { on: true }, '入图') : null,
            nameEdit != null ? h(Input, {
              className: 'grow', value: nameEdit, maxLength: 24, autoFocus: true,
              placeholder: '这人叫什么',
              onChange: (e) => setNameEdit(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') saveName()
                if (e.key === 'Escape') setNameEdit(null)
              },
            }) : null,
            nameEdit != null ? h(Btn, {
              sm: true, primary: true, onClick: saveName,
              disabled: !!busy || !String(nameEdit || '').trim(),
            }, busy === 'rename' ? '保存中…' : '保存') : null,
            nameEdit != null ? h(Btn, {
              sm: true, ghost: true, disabled: !!busy,
              onClick: () => setNameEdit(null),
            }, '取消') : null,
            h('div', { className: 'dshc-spacer' }),
            h('button', { className: 'dshc-del', title: '关掉', onClick: onClose }, '×')),
          d.error ? h('div', { className: 'dshc-err', style: { marginTop: 8 } }, d.error) : null,
          p ? h('div', { className: 'dshc-sub', style: { marginTop: 6 } },
            '亲近 ' + Number(p.closeness || 0).toFixed(2)
            + ' · 信任 ' + Number(p.trust || 0).toFixed(2)
            + ' · 依赖 ' + Number(p.dependence || 0).toFixed(2)
            + ' · 上次 ' + relAgo(p.last_talk_at)) : null,
          card ? h('div', { className: 'dshc-note', style: { marginTop: 8, whiteSpace: 'pre-wrap' } }, card) : null,
          p ? h('div', { style: { marginTop: 10 } },
            h('div', { className: 'dshc-sub', style: { marginBottom: 4 } }, '一句话（这人是谁）'),
            h(Input, {
              className: 'grow', value, maxLength: 120,
              placeholder: '比如「同事，帮我修过电脑」',
              onChange: (e) => setDraft(e.target.value),
            }),
            h('div', { className: 'dshc-form', style: { marginTop: 8, alignItems: 'center' } },
              h(Btn, { onClick: () => save('summary'), disabled: !!busy || draft == null },
                busy === 'summary' ? '保存中…' : '保存一句话'))) : null,
          p && !isOwner ? h('div', { className: 'dshc-form', style: { marginTop: 8, alignItems: 'center' } },
            h(Btn, { onClick: () => save('tier'), disabled: !!busy },
              '换到「' + (p.tier === 'acquaintance' ? '生人' : '熟人') + '」'),
            !p.graph_visible ? h(Btn, { onClick: () => save('promote'), disabled: !!busy }, '放进关系图') : null,
            h('div', { className: 'dshc-spacer' }),
            h('button', {
              className: 'dshc-del' + (askDel ? ' dshc-del-ask' : ''),
              disabled: !!busy,
              onClick: () => {
                if (!askDel) { setAskDel(true); return }
                setAskDel(false)
                save('remove')
              },
            }, busy === 'remove' ? '…' : askDel ? '确认删' : '删除')) : null,
          msg ? h('div', { className: 'dshc-sub', style: { marginTop: 8 } }, msg) : null,
          err ? h('div', { className: 'dshc-err', style: { marginTop: 8 } }, err) : null))
    }

    /** 鍏崇郴鏄熷浘锛氫腑蹇冩槸銆屾垜銆嶏紝涓夊眰杞ㄩ亾锛岃妭鐐瑰拰鍚嶅瓧浜掍笉閬尅锛涚嚎瓒婄矖瓒婁翰杩戙€?*/
    function PersonMap({ aid, fallback, seed, onChanged }) {
      const [hover, setHover] = useState('')
      const [sel, setSel] = useState('')
      const [s] = useAsync(async () => {
        try {
          const list = await call('GET', '/v1/agents/' + enc(aid) + '/persons')
          if (!Array.isArray(list)) return null
          const head = list.slice(0, 14)
          const details = await Promise.all(head.map((p) => call('GET', '/v1/agents/' + enc(aid) + '/persons/' + enc(p.id))
            .then((d) => ({ person: p, detail: d }))
            .catch(() => null)))
          const links = []
          const seen = new Set()
          for (const it of details) {
            if (!it) continue
            for (const e of ((it.detail && it.detail.edges) || [])) {
              if (!e || !e.id || seen.has(e.id)) continue
              seen.add(e.id)
              links.push(Object.assign({}, e, { from: it.person.id }))
            }
          }
          return { persons: list, links }
        } catch { return null }
      }, [aid, seed])

      // 鏃у涓?/ 鎺ュ彛杩樻病鐑捣鏉ワ細閫€鍥炲師鏉ラ偅寮犵畝鍥撅紝涓嶇暀鐧?''
              if (!s.data) return h(RelationOrbit, { relations: fallback })

      const W = 480, H = 400
      const cx = W / 2, cy = H / 2
      const RING = { owner: 62, acquaintance: 118, stranger: 164 }
      const NODE_R = { owner: 9, acquaintance: 6.6, stranger: 4.8 }
      // 鏄惧紡鑹插€硷細SVG 閲?color-mix 鍦ㄩ儴鍒?WebView 涓嶇敓鏁堬紝涓讳汉浼氱敾鎴愮伆鐨?''
              const COLOR = {
        owner: '#5b8cff',
        acquaintance: '#7f9ec9',
        stranger: '#6d7380',
      }
      const LABEL = { owner: '主人', acquaintance: '熟人', stranger: '生人' }
      const all = (s.data.persons || []).filter((p) => p.status !== 'archived')
      const persons = all.slice(0, 14)
      const placed = seatPersonLabels(layoutPersonMap(persons, { W, H, cx, cy, RING, NODE_R }), { W, H, cx, cy })
      const byId = new Map(placed.map((n) => [n.id, n]))
      // 鍜屻€屾垜 / 涓讳汉銆嶇殑杈瑰凡缁忕敾鎴愯緪鏉′簡锛屼笉鑳藉啀鐢讳竴鏉′汉鈫掍汉寮х嚎锛?''
      // 閭ｆ潯寮т細浠庡渾蹇冮紦鍑烘潵锛屾í绌挎梺杈圭殑浜猴紝鐪嬬潃灏卞儚涓や釜浜鸿繛涓婁簡銆?''
              const ownerId = (persons.find((p) => p.tier === 'owner') || {}).id
      const links = (s.data.links || []).filter((e) => byId.has(e.from) && e.other && byId.has(e.other.id)
        && e.other.id !== ownerId && e.from !== ownerId)
      const cur = persons.find((p) => p.id === hover) || persons.find((p) => p.tier === 'owner') || persons[0] || null
      const ago = (iso) => {
        if (!iso) return '还没说过话'
        const d = ageDays(iso)
        return d <= 0 ? '今天' : d + ' 天前'
      }

      return h('div', { className: 'dshc-rmap' },
        h('svg', {
          viewBox: '0 0 ' + W + ' ' + H,
          role: 'img', 'aria-label': '人物关系星图：我在中心，主人 / 熟人 / 生人 分三层环绕',
        },
          h('defs', null,
            h('radialGradient', { id: 'dshcMapGlow' },
              h('stop', { offset: '0%', style: { stopColor: 'var(--accent)', stopOpacity: 0.18 } }),
              h('stop', { offset: '100%', style: { stopColor: 'var(--accent)', stopOpacity: 0 } })),
            h('pattern', { id: 'dshcMapDots', width: 20, height: 20, patternUnits: 'userSpaceOnUse' },
              h('circle', { cx: 1, cy: 1, r: 0.7, style: { fill: 'var(--muted)', opacity: 0.3 } }))),
          h('rect', { x: 0, y: 0, width: W, height: H, fill: 'url(#dshcMapDots)' }),
          h('circle', { cx, cy, r: RING.stranger, fill: 'url(#dshcMapGlow)' }),
          ['owner', 'acquaintance', 'stranger'].map((tier, i) => h('circle', {
            key: 'ring-' + tier, className: 'spin', cx, cy, r: RING[tier],
            strokeWidth: 1, strokeDasharray: '2 7',
            style: { fill: 'none', stroke: 'var(--line)', animationDuration: (88 + i * 26) + 's' },
          })),
          // 鎴?→姣忎釜浜猴細浠庝腑蹇冭竟缂樺嚭鍙戯紝钀藉湪鑺傜偣杈圭紭
          placed.map((n) => {
            const dx = n.x - cx, dy = n.y - cy
            const d = Math.hypot(dx, dy) || 1
            const ux = dx / d, uy = dy / d
            const on = hover === n.id
            const k = Math.max(0, Math.min(1, Number(n.p.closeness) || 0))
            return h('path', {
              key: 'lk-' + n.id,
              d: 'M' + (cx + ux * 24).toFixed(1) + ' ' + (cy + uy * 24).toFixed(1)
                + ' L' + (n.x - ux * (n.r + 1.5)).toFixed(1) + ' ' + (n.y - uy * (n.r + 1.5)).toFixed(1),
              className: on ? 'flow' : '',
              strokeWidth: (0.5 + k * 4.8).toFixed(2), strokeLinecap: 'round',
              style: {
                fill: 'none', stroke: COLOR[n.tier],
                strokeOpacity: on ? 0.95 : (n.tier === 'owner' ? 0.5 : n.tier === 'acquaintance' ? 0.34 : 0.18),
              },
            })
          }),
          // 浜?→浜猴細鍚戝寮撲竴鐐癸紝璋佸拰璋佹湁鍏崇郴涓€鐪肩湅鍑烘潵
          links.map((e) => {
            const a = byId.get(e.from), b = byId.get(e.other.id)
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
            const dx = mx - cx, dy = my - cy
            const len = Math.hypot(dx, dy) || 1
            const span = Math.hypot(b.x - a.x, b.y - a.y)
            const bow = 22 + Math.min(26, span * 0.1)
            const qx = mx + (dx / len) * bow, qy = my + (dy / len) * bow
            const at = (t) => {
              const m = 1 - t
              return [m * m * a.x + 2 * m * t * qx + t * t * b.x, m * m * a.y + 2 * m * t * qy + t * t * b.y]
            }
            const p0 = at(0.12), p1 = at(0.88)
            const on = hover === e.from || hover === e.other.id
            return h('path', {
              key: 'ed-' + e.id,
              d: 'M' + p0[0].toFixed(1) + ' ' + p0[1].toFixed(1) + ' Q ' + qx.toFixed(1) + ' ' + qy.toFixed(1)
                + ' ' + p1[0].toFixed(1) + ' ' + p1[1].toFixed(1),
              className: on ? 'flow' : 'drift',
              strokeWidth: on ? 1.9 : 1.35, strokeLinecap: 'round',
              style: { fill: 'none', stroke: 'var(--ok)', strokeOpacity: on ? 0.95 : 0.5 },
            })
          }),
          h('g', { key: 'me', className: 'me' },
            h('circle', { className: 'pulse', cx, cy, r: 34, opacity: 0.1, style: { fill: 'var(--accent)' } }),
            h('circle', {
              cx, cy, r: 23, strokeWidth: 1.2,
              style: { fill: 'color-mix(in srgb, var(--accent) 18%, transparent)', stroke: 'var(--accent)' },
            }),
            h('text', { x: cx, y: cy + 4, textAnchor: 'middle' }, '我')),
          placed.map((n, i) => {
            const on = hover === n.id
            const clickable = n.tier !== 'owner'
            const k = Math.max(0, Math.min(1, Number(n.p.closeness) || 0))
            // 鍏崇郴瓒婅繎锛岀偣瓒婂ぇ锛涜建閬撹秺澶栵紝鏈潵灏辫秺灏?''
              const rr = n.r * (0.92 + 0.16 * k)
            return h('g', {
              key: 'n-' + n.id, className: 'node', 'data-dim': hover && !on ? '1' : '0',
              style: { animationDelay: (i * 0.045) + 's', cursor: clickable ? 'pointer' : 'default' },
              onMouseEnter: () => setHover(n.id), onMouseLeave: () => setHover(''),
              onClick: clickable ? () => setSel(n.p.id) : null,
            },
              h('title', null, String(n.p.name || '?') + ' · ' + (LABEL[n.tier] || n.tier) + (clickable ? ' · 点开' : '')),
              h('circle', {
                className: 'pulse', cx: n.x, cy: n.y, r: rr + 6, opacity: 0.1,
                style: { fill: COLOR[n.tier], animationDelay: (i * 0.35) + 's' },
              }),
              h('circle', {
                className: 'dot', cx: n.x, cy: n.y, r: on ? rr + 1.4 : rr, strokeWidth: 0.8,
                style: {
                  fill: COLOR[n.tier], fillOpacity: 0.92,
                  stroke: 'rgba(255,255,255,.35)',
                },
              }),
              // 鎸や笉杩涚┖浣嶇殑鍚嶅瓧鍏堟敹鐫€锛屾偓鍋滆繖涓汉鏃舵墠娴嚭鏉?''
              h('text', {
                className: 'lbl' + (n.label.shown ? '' : ' lbl-hide'),
                x: n.label.x, y: n.label.y, textAnchor: n.label.anchor,
              }, n.label.text))
          })),
        h('div', { className: 'dshc-rmap-legend' },
          h('span', null, h('i', { style: { background: COLOR.owner } }), '主人'),
          h('span', null, h('i', { style: { background: COLOR.acquaintance } }), '熟人'),
          h('span', null, h('i', { style: { background: COLOR.stranger } }), '生人'),
          h('span', null, '线越粗越亲近 · 名字在外侧 · 点一个人查看 / 编辑 / 删除'),
          all.length > persons.length ? h('span', null, '只画最近 ' + persons.length + ' 个') : null),
        h('div', { className: 'dshc-rmap-info' }, cur
          ? [
            h('b', { key: 'n' }, cur.name),
            h('span', { key: 't' }, (LABEL[cur.tier] || cur.tier) + ' · '),
            h('span', { key: 'm', className: 'm' },
              '亲近 ' + Number(cur.closeness || 0).toFixed(2)
              + ' · 信任 ' + Number(cur.trust || 0).toFixed(2)
              + ' · 依赖 ' + Number(cur.dependence || 0).toFixed(2)
              + ' · 上次 ' + ago(cur.last_talk_at)),
          ]
          : '还没有记下别人。聊到谁、谁是谁，账本会自己长人。'),
        sel ? h(PersonCardDialog, { aid, pid: sel, onClose: () => setSel(''), onChanged }) : null)
    }


    /** 涓夌粍寮犲姏锛氱敤銆孉锛岃繕鏄?B銆嶉棶鍙ヨ浜鸿瘽锛屽摢杈规洿閲嶅氨璇寸幇鍦ㄥ亸鍝竟 */
