    /* 三维球（2026-11-18）：把 v4 的 S / N / D 投到球里一个点。
       这不是装饰：三条轴各是一个 0~1，点在球里的位置就是「这一下推到了哪儿」。
       x = 现状 S，y = 奔头 D（往上），z = 被惊到 N（朝观察者）。固定视角 + 透视，不转，免得看晕。 */
    function AffectBall({ v4 }) {
      const W = 380, H = 260, cx = 190, cy = 120, R = 96
      const rotY = 0.62, tiltX = 0.34
      const pt = (x, y, z) => {
        const x1 = x * Math.cos(rotY) + z * Math.sin(rotY)
        const z1 = -x * Math.sin(rotY) + z * Math.cos(rotY)
        const y1 = y * Math.cos(tiltX) - z1 * Math.sin(tiltX)
        const z2 = y * Math.sin(tiltX) + z1 * Math.cos(tiltX)
        const k = 1 / (1 - z2 * 0.32)
        return [cx + x1 * R * k, cy - y1 * R * k, z2]
      }
      const ring = (fn, n = 72) => {
        let d = ''
        for (let i = 0; i <= n; i++) {
          const t = i / n * Math.PI * 2
          const p = fn(t)
          d += (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)
        }
        return d + 'Z'
      }
      const m1 = ring((t) => pt(Math.cos(t), Math.sin(t), 0))
      const m2 = ring((t) => pt(0, Math.cos(t), Math.sin(t)))
      const m3 = ring((t) => pt(Math.cos(t), 0, Math.sin(t)))
      const ok = v4 && ['s', 'n', 'd'].every((k) => Number.isFinite(Number(v4[k])))
      const s = ok ? Number(v4.s) : 0.5
      const n = ok ? Number(v4.n) : 0.15
      const d = ok ? Number(v4.d) : 0.5
      const p = pt((s - 0.5) * 1.7, (d - 0.5) * 1.7, (n - 0.5) * 1.7)
      const CORNERS = [
        ['安', 1, 0, 0], ['怡', 1, 0, 1], ['惊', 1, 1, 0], ['乐', 1, 1, 1],
        ['悲', 0, 0, 0], ['怯', 0, 0, 1], ['惧', 0, 1, 0], ['怒/慌', 0, 1, 1],
      ]
      let best = null
      for (const c of CORNERS) {
        const dd = Math.hypot((c[1] - s), (c[2] - n), (c[3] - d))
        if (!best || dd < best.dd) best = { zh: c[0], dd }
      }
      const near = best ? Math.max(0, Math.round((1 - best.dd / Math.sqrt(3)) * 100)) : 0
      const axisLabel = (x, y, z, text, color) => {
        const q = pt(x, y, z)
        return h('text', {
          x: q[0], y: q[1], fill: color, fontSize: 11, textAnchor: 'middle',
          style: { paintOrder: 'stroke', stroke: '#0b1018', strokeWidth: 3 },
        }, text)
      }
      return h('div', null,
        h('svg', { viewBox: `0 0 ${W} ${H}`, style: { width: '100%', maxWidth: 430, display: 'block', margin: '0 auto' } },
          h('defs', null,
            h('radialGradient', { id: 'affball-fill', cx: '34%', cy: '28%', r: '75%' },
              h('stop', { offset: '0%', stopColor: '#8fd6ff', stopOpacity: 0.30 }),
              h('stop', { offset: '58%', stopColor: '#1b3a55', stopOpacity: 0.55 }),
              h('stop', { offset: '100%', stopColor: '#0a1420', stopOpacity: 0.92 }))),
          h('ellipse', { cx, cy, rx: R * 1.02, ry: R * 1.02, fill: 'url(#affball-fill)', stroke: 'rgba(140,200,255,.28)' }),
          [m1, m2, m3].map((dd, i) => h('path', {
            key: 'ring' + i, d: dd, fill: 'none',
            stroke: 'rgba(150,210,255,.20)', strokeWidth: 1, strokeDasharray: i === 0 ? null : '3 4',
          })),
          CORNERS.map((c) => {
            const q = pt((c[1] - 0.5) * 1.55, (c[3] - 0.5) * 1.55, (c[2] - 0.5) * 1.55)
            return h('circle', { key: 'c' + c[0], cx: q[0], cy: q[1], r: 2.6, fill: 'rgba(190,235,255,.40)' })
          }),
          h('circle', { cx, cy, r: 2.2, fill: 'rgba(200,240,255,.45)' }),
          h('line', { x1: cx, y1: cy, x2: p[0], y2: p[1], stroke: '#5ec8ff', strokeWidth: 1, strokeDasharray: '3 4', opacity: 0.7 }),
          h('circle', { cx: p[0], cy: p[1], r: 18, fill: '#5ec8ff', opacity: 0.14 }),
          h('circle', { cx: p[0], cy: p[1], r: 5.6, fill: '#d9f3ff', stroke: '#5ec8ff', strokeWidth: 1.6,
            style: { filter: 'drop-shadow(0 0 6px #5ec8ff)' } }),
          axisLabel(1.22, 0, 0, '现状 S', '#9fe0ff'),
          axisLabel(0, 1.22, 0, '奔头 D', '#ffd79a'),
          axisLabel(0, 0, 1.22, '惊 N', '#ff9b9b')),
        h('div', { style: { display: 'flex', justifyContent: 'center', gap: 18, marginTop: 2, fontSize: 12, opacity: 0.75 } },
          h('span', null, '现状 ' + s.toFixed(2)),
          h('span', null, '惊 ' + n.toFixed(2)),
          h('span', null, '奔头 ' + d.toFixed(2)),
          ok ? h('span', { style: { color: '#9fe0ff' } }, '最像「' + best.zh + '」 ' + near + '%') : h('span', { style: { opacity: 0.6 } }, '这一轮还没算当场')),
        !ok && h('div', { className: 'dshc-sub', style: { textAlign: 'center', marginTop: 4 } },
          '它还没算出来——等它回过一句，这里就是一个点。'))
    }

    function AffectPage({ aid, view, act, setTab }) {
      const [tick, setTick] = useState(0)
      const [trange, setTrange] = useState(7)
      const [a, reloadA] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/affect'), [aid, tick])
      const [eps] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/affect/episodes'), [aid, tick])
      /* 璧板娍鍙搴撻噷鐨勭湡鏍锋湰锛氫笉閾哄亣鎯虫洸绾?*/
      const [trend, reloadT] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/affect/trend?days=' + trange), [aid, tick, trange])
      const [radar] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/affect/radar'), [aid, tick])
      const [cond, reloadC] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/condition'), [aid, tick])
      const [poison] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/affect/poisons'), [aid, tick])
      const [guess] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/affect/guess'), [aid, tick])
      const [gates] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/affect/events?days=3&limit=30'), [aid, tick])
      const [text, setText] = useState('')
      const [res, setRes] = useState(null)
      const [err, setErr] = useState('')
      const [epLimit, setEpLimit] = useState(1)
      const metricSlice = useMetricSlice(aid, 17, 25)
      /* 快情绪按分钟回落、慢情绪按小时走：页面开着就隔一会儿重取一次，
         涓嶇劧鍋滃湪寮€椤甸偅涓€鍒荤殑蹇収涓婏紝鐪嬬潃灏卞儚銆岀畻娉曟病鏇存柊銆嶃€?*/
      useLive(() => { reloadA(); reloadT() }, 10000)
      const cur = a.data || {}
      // v4 有就用它的词和「离中立多远」当强度；没有才回旧 PAD 的标签/强度。
      const v4 = (cur && cur.v4) || null
      const label = v4 && v4.label ? v4.label : (AFFECT_KEY[cur.primary_label] || cur.primary_label || '—')
      const intensity = v4 && Number.isFinite(Number(v4.v)) ? Math.abs(Number(v4.v)) : Number(cur.intensity || 0)
      /* 鏈€鏂伴偅鏉℃秷鎭鍒ゆ柇鎴愪粈涔堬紙杩樻病琚儻鎬у帇杩囩殑鍘熷鍒ゆ柇锛?*/
      const latestRaw = (() => {
        const e = (eps.data && eps.data[0]) || null
        if (!e) return ''
        try { return JSON.parse(e.appraisal || '{}').raw_label || '' } catch { return '' }
      })()
      const c = cond.data || { attention: 0.7, load: 0.2, state: 'focus' }

      async function appraise() {
        if (!text.trim()) return
        setErr('')
        try {
          const r = await act(() => call('POST', '/v1/agents/' + enc(aid) + '/affect/appraise', { text: text.trim() }, true))
          setRes(r); setText(''); setTick((t) => t + 1)
        } catch (x) { setErr(x.message) }
      }
      async function act0(path, body) {
        await act(() => call('POST', '/v1/agents/' + enc(aid) + path, body || {}, true))
        setTick((t) => t + 1)
      }
      async function setCond(field, value) {
        await act(() => call('PUT', '/v1/agents/' + enc(aid) + '/condition',
          { attention: c.attention, load: c.load, [field]: value }, true))
        setTick((t) => t + 1)
      }

      /* 此刻的总情绪：走势里最后一个真有读数的点；没有就拿心情折一下（0.5 是不好不坏） */
      const tNow = (() => {
        const pts = (trend.data && trend.data.points) || []
        for (let i = pts.length - 1; i >= 0; i--) {
          const p = pts[i]
          if (!Number.isFinite(Number(p.f))) continue
          if (Number.isFinite(Number(p.t))) return Number(p.t)
          const s = Number(p.s) || 0
          const f = Number(p.f) || 0
          return Math.max(-1, Math.min(1, s + 0.35 * f))
        }
        const mood = Number(cur.mood)
        return Number.isFinite(mood) ? (mood - 0.5) * 2 : 0
      })()
      /* 瓒婄Н鏋佽秺娲绘臣锛堜寒銆佸揩銆佸線涓婇锛夛紱瓒婃秷鏋佽秺娑堟矇锛堟殫銆佹參銆佸線涓嬫矇锛?*/
      const look = emoLook(tNow, intensity)

      return h('div', null,
        h(LoadErr, { error: a.error || eps.error, retry: () => { reloadA(); setTick((t) => t + 1) } }),
        /* 姝ゅ埢 + 璧板娍鍚堟垚涓€寮犲崱锛氫笂闈㈡槸銆岀幇鍦ㄤ粈涔堢姸鎬併€嶏紝涓嬮潰鏄€屽畠鎬庝箞璧板埌杩欎竴姝ャ€?*/
        h(Sec, {
        title: view === 'user' ? '它的变化' : '自动变更（C4 · 只读）',
          desc: h('span', { style: { display: 'inline-flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '0 12px' } },
            h(TrendNow, { data: trend.data || null, raw: latestRaw, cur }),
            h('span', { style: { opacity: 0.5 } },
              view === 'user'
                ? '· 上半是此刻，下半是它这一程怎么走过来的；虚线是它的水位。'
                : '· 大字=label；虚线=水位（底色+日节律+激素纹+负荷），白线=慢情绪，蓝尾=这一下。')),
        },
          h(Card, {
            className: 'dshc-emo',
            style: {
              '--emo-glow': look.glow,
              '--emo-glow2': look.glow2,
              '--emo-dot': look.dot,
              '--emo-spark': look.spark,
              '--emo-drift': look.drift,
            },
          },
            h(AffectAura, { look }),
            h('div', { className: 'dshc-emo-body', style: { filter: look.bodyFilter } },
            h('div', { style: { display: 'flex', gap: 16, alignItems: 'center' } },
              h(AffectOrb, { size: 44, look }),
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', {
                  className: 'dshc-emo-word',
                  style: {
                    fontSize: 22, fontWeight: 600, letterSpacing: 1,
                    '--emo-beat': look.beat.toFixed(2) + 's',
                    textShadow: '0 0 ' + (10 + 22 * look.e).toFixed(0) + 'px ' + look.textGlow,
                    transition: 'text-shadow .9s ease',
                  },
                }, label),
                h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 6 } },
                  h('span', { className: 'dshc-sub', style: { minWidth: 30 }, title: '这股情绪有多强，0 到 1' }, '强度'),
                  h(Bar, { value: intensity, tone: Number(intensity) > 0.75 ? 'warn' : undefined }),
                  h('span', { className: 'dshc-mono' }, Number(intensity).toFixed(2)),
                  h('span', { className: 'dshc-sub', style: { opacity: 0.38 } }, '0 到 1')),
                h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 4 } },
                  h('span', { className: 'dshc-sub', style: { minWidth: 30 }, title: '整体舒服不舒服，0 到 1；0.5 是不好不坏。和「此刻」是同一个数，只是换了刻度' }, '心情'),
                  h(Bar, { value: cur.mood, color: look.bar }),
                  h('span', { className: 'dshc-mono' }, Number(cur.mood || 0).toFixed(2)),
                  h('span', { className: 'dshc-sub', style: { opacity: 0.38 } }, '0.5 是不好不坏')),
                (function () {
                  const v3 = (cur && cur.v3) || null
                  if (!v3) return null
                  const v4 = (cur && cur.v4) || null
                  const sg = (x) => (Number(x) >= 0 ? '+' : '') + Number(x).toFixed(2)
                  const items = [
                    ['水位', v3.baseline, '底色 + 日节律 + 激素纹 + 累积负荷：慢情绪要去的地方'],
                    ['负荷', v3.base_off, '累积负荷：被持续情绪拖走的那部分，几天代谢回来'],
                    ['慢情绪', v3.slow, '慢情绪（v3.slow）：跨会话的底色，最近几小时到几天'],
                    ['当场', v4 ? v4.v : v3.fast, v4 ? '当场（v4）：这一句把三条轴推到哪儿，再投影到正负轴；各会话独立' : '快情绪（旧 v3.fast）：这一下的反应 + 共情，按分钟回落'],
                    ['此刻', v3.total, v4 ? '总情绪：慢情绪 + 0.35×当场（v4 投影）' : '总情绪：慢情绪 + 0.35×快情绪'],
                  ]
                  const shown = items.filter((it) => it[1] !== null && it[1] !== undefined && Number.isFinite(Number(it[1])))
                  if (!shown.length) return null
                  return h('div', { style: { display: 'flex', gap: 13, flexWrap: 'wrap', alignItems: 'baseline', marginTop: 6, fontSize: 11.5, opacity: 0.7 } },
                    shown.map((it) => h('span', { key: it[0], title: it[2] },
                      it[0] + ' ' + sg(Number(it[1])))))
                })())),
            /* PAD 鏄棫妯″瀷鐨勮娉曪紝鐣岄潰涓婁笉鍐嶆憜锛氭剦鎮﹁繕鍠傜潃蹇儏缁紝娲诲姏鍙奖鍝嶈蹇嗘潈閲嶏紝鎺屾帶娌′汉璇?*/
            h('div', { style: { height: 1, background: 'var(--line)', opacity: 0.6, margin: '14px 0 10px' } }),
            h('div', { className: 'dshc-form', style: { marginBottom: 8 } },
              [[1, '一天'], [7, '一周'], [30, '一月'], [365, '一年']].map(([d, t]) =>
                h(Btn, { key: d, primary: trange === d, onClick: () => setTrange(d) }, t))),
            trend.error
              ? h('div', { className: 'dshc-note', style: { padding: '12px 0' } },
                /接口不存在|NOT_FOUND/.test(trend.error) ? '宿主重启一次就能画' : trend.error)
              : h(TrendChart, { data: trend.data || null, look })))),
        view === 'tech' ? h(Tech, null, 'intensity_t = clamp(0.3·intensity_{t-1} + 0.7·Δ, 0, 1)\nΔ = 0.3 + 0.3·|goal_congruence| + 0.1·novelty\nPAD_t = 0.45·PAD_{t-1} + 0.55·prior(label)\n\n底色不是一条线，是四层叠出来的（affect.baseline.*）：\nb = 段式慢波（几天一个来回，±0.2~0.3）\n  + 日节律 circ(t)（24h 一个来回，相位随个体，幅度 0.06）\n  + 激素纹（≈90min 脉冲 + 几小时到一天的 1/f 漂移 + 18~34 天长周期）：\n    脉冲上升 12min、回落 35min，每格约一半有，尖有大小；纹理刻意不平滑。\n    幅度 = baseline.rough（漂移，默认 0.08）+ baseline.cycle（长周期，默认 0.07）；给 0 = 退回旧样子\n  + 累积负荷 L（allostatic load：一直偏着就把水位拖走，几天代谢回来，±0.35 封顶）\n\n慢情绪（真 EMA，2026-11-01 起）：\nds/dt = α·(fast − s) + β·(b − s) + ω·(prior − s)\ns* = (α·fast + β·b + ω·prior) / (α+β+ω)，λ = α+β+ω\ns_{t+Δt} = s* + (s_{t−1} − s*)·exp(−λ·Δt)\nα=0.09/h · β=0.07/h · ω=0.005/h → λ=0.165（τ≈6h，一夜退到三成）\n稳态：快情绪五成半 / 底色四成\n参数：affect.slow.alpha / affect.slow.beta / baseline.circadian / baseline.rough / baseline.cycle / baseline.load.*\n慢情绪按余温积分 ∫fast dt，不再拿一个常数值糊过去；差 50 分钟也走一步，9.9 小时不截断\n\n快情绪：fast_t = level + (fast_{t-1} − level)·exp(−(Δt/τ)^shape)，τ=20min、shape=1.5\n惯性：label 连续 2 轮一致才切换\n闸门：只有事件才换主情绪；两次事件之间强度自己回落，标签留着\n用户情绪：user_label 单独进 episode，不写 primary_label') : null,
        /* 「它现在觉得你」：它读你这句话得出的情绪（user_scores），不是它自己的情绪 */
        (function () {
          const g = (guess.data && guess.data.latest) || null
          const st = (guess.data && guess.data.stats) || { n: 0, hits: 0, accuracy: null, confusions: [] }
          if (guess.error) {
            return h(Sec, { title: '它现在觉得你：', desc: '读你的接口还没加载（宿主重启一次就会出现）。' },
              h(Card, null, h('div', { className: 'dshc-sub' }, guess.error)))
          }
          if (!g) {
            return h(Sec, { title: '它现在觉得你：', desc: '它还没听到一句能判断的话。' },
              h(Card, null, h('div', { className: 'dshc-sub' }, '还没有可以从你这句话里读出来的情绪。')))
          }
          if (!g.dist) {
            return h(Sec, { title: '它现在觉得你：', desc: '这条旧记录里没留下它读你的分数；下一次对话就有了。' },
              h(Card, null, h('div', { className: 'dshc-sub' },
                '它当时自己的情绪是「' + (AFFECT_KEY[g.self.label] || g.self.label) + '」，但没有记下对你的判断。')))
          }
          const dist = g.dist
          const rows = AFFECT_ORDER.filter((k) => Number(dist[k]) > 0.004)
            .sort((x, y) => Number(dist[y]) - Number(dist[x]))
          return h(Sec, {
          title: '最近的情绪事件',
            desc: view === 'user'
          ? '它想改自己的提案先放这里。'
          : 'C1–C3 必过影子（C1 40 轮 / C2·C3 20 轮）；批准才扣令牌并生效。',
          },
            h(Card, null,
              h('div', { className: 'dshc-readhead' },
                h('div', null,
                  h('div', { className: 'dshc-readnow' }, AFFECT_KEY[g.top] || g.top),
                  h('div', { className: 'dshc-sub' },
                    '次选 ' + (AFFECT_KEY[g.second] || g.second) +
                    ' · 占它这次读你的 ' + Math.round(Number(g.topP || 0) * 100) + '%')),
                h('div', { className: 'dshc-readself' },
                  h('div', { className: 'dshc-sub' }, '它当时自己'),
                  h('div', { style: { marginTop: 2 } },
                    h(Pill, null, AFFECT_KEY[g.self.label] || g.self.label),
                    h('span', { className: 'dshc-mono', style: { marginLeft: 6, opacity: 0.7 } },
                      Number(g.self.intensity || 0).toFixed(2))))),
              h('div', { className: 'dshc-readbars' },
                rows.map((k) => h('div', { key: k, className: 'dshc-readbar' },
                  h('span', { className: 'k' }, AFFECT_KEY[k] || k),
                  h(Bar, { value: Number(dist[k]) }),
                  h('span', { className: 'v dshc-mono' }, Math.round(Number(dist[k]) * 100) + '%')))),
              h('div', { className: 'dshc-note' },
                '来自「' + String(g.cause || '（那句话没留原文）').slice(0, 34) + '」' +
                (g.corrected ? ' · 这条你已经纠正过' : '')),
              h(ReadFeedback, { aid, item: g, act, onChange: () => setTick((t) => t + 1) }),
              h('div', { className: 'dshc-note' },
                st.n
                  ? '你纠正过 ' + st.n + ' 次，它读你准 ' + st.hits + '/' + st.n +
                    (st.accuracy != null ? '（' + st.accuracy + '%）' : '') + '。'
                  : '还没纠正过它。第一次点「不对」，它就会按你说的读你。')),
            view === 'tech' ? h(Tech, null,
              '读你 = 模型给的 user_scores（不是它自己的 scores）\n' +
              '学到的读法：P(你实际 a | 它读成 g) = (次数·30 天半衰 + 3·δ) / (总数 + 3)\n' +
              '不加「你的情绪底色」先验：反馈只在读错时产生，那个分布是被选的，不是你的底色\n' +
              '这条你纠正过就按你说的显示；最近一次纠正只在读数不确定时给一点 2h 偏置\n' +
              '学到的分布拿去算共情 e_user，也写进下一轮提示词\n' +
              (st.confusions && st.confusions.length
                ? '它学到的偏差：' + st.confusions.map((c) =>
                  (AFFECT_KEY[c.guess] || c.guess) + '→' + (AFFECT_KEY[c.actual] || c.actual) + '×' + c.count).join(' / ')
                : '它学到的偏差：还没有')) : null)
        })(),

        h(Sec, { title: '它现在的三维位置', desc: '现状 S（现在好不好）/ 惊 N（被惊到多少）/ 奔头 D（还有没有奔头）。球心是平静，点离球心越远，这一下越重。' },
          h(Card, null,
            h(AffectBall, { v4: cur.v4 || null }))),

        h(Sec, { techOnly: true, title: '旧口径：最近 24 小时的情绪成分', desc: '按旧情绪账的 8 个词，越近的越重（半衰 4 小时）；只留技术页对照。' },
          h(Card, null,
            h(RadarChart, { labels: (radar.data && radar.data.labels) || {} }),
            h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, justifyContent: 'center' } },
              Object.keys(AFFECT_KEY).map((t) => h(Pill, { key: t, on: t === cur.primary_label }, AFFECT_KEY[t]))))),

        h(Sec, { techOnly: true, title: '评价', desc: '一句话进来，五变量出去：目标相关性、一致性、归因、确定性、新颖性。' },
          h(Card, null,
            h('div', { className: 'dshc-form' },
              h(Input, {
                className: 'grow', placeholder: '比如「谢谢你，我很喜欢」', value: text,
                onChange: (e) => setText(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') appraise() },
              }),
              h(Btn, { primary: true, onClick: appraise }, '评价'),
              h(Btn, { onClick: () => act0('/affect/decay', { hours: 24 }) }, '衰减 24h'),
              h(Btn, { onClick: () => act0('/affect/reestimate') }, '重估')),
            err ? h('div', { className: 'dshc-err' }, err) : null,
            res ? h('div', { style: { marginTop: 8 } },
              h(Row, { label: '标签', value: AFFECT_KEY[res.label] || res.label }),
              h(Row, { label: '强度', value: Number(res.intensity).toFixed(3) }),
              res.algo ? h(Row, { label: '算法', value: 'appraise@' + (res.algo.appraise && res.algo.appraise.version) + ' · dyn@' + (res.algo.dyn && res.algo.dyn.version) }) : null,
              res.edges && res.edges.fired && res.edges.fired.length
                ? h(Row, { label: '关系边', value: res.edges.fired.join(', ') }) : null) : null)),

        /* 浜嬩欢闂搁棬锛歰n = 鍙湁杩囬椄鐨勬秷鎭墠鎴愪负涓€娆℃儏缁簨浠?*/
        h(Sec, {
          techOnly: true,
          title: (gates.data && gates.data.mode === 'on') ? '事件闸门' : '事件闸门（影子）',
          desc: (gates.data && gates.data.mode === 'on')
            ? '已生效：每条消息算一个显著性（关切 × 一致性 × 新异 × 变化 × 习惯化）。不过闸的消息不写 episode、不改主情绪，只让强度自己回落。'
            : '只记录、不生效（回滚挡位）：每条消息算一个显著性，看它会不会成为一次情绪事件。现在的标签与强度不受影响。',
        },
          h(Card, null, (function () {
            const g = gates.data || null
            if (gates.error) return h('div', { className: 'dshc-sub' }, '接口还没加载：' + gates.error)
            const rp = (g && g.replay) || null
            const replayLine = rp && rp.total
              ? h('div', { className: 'dshc-note', style: { marginTop: 8 } },
                '回放最近 ' + rp.total + ' 条真实情绪：按新规则会成事件 ' + rp.passed + ' 条（' + Math.round(Number(rp.rate) * 100) + '%）。')
              : null
            if (!g || !g.total) {
              return h('div', null,
                h('div', { className: 'dshc-sub' }, '还没有影子记录；聊几句就会开始记。'),
                replayLine,
                rp && (rp.items || []).length
                  ? h('div', { className: 'dshc-list', style: { marginTop: 8 } }, rp.items.map((it) =>
                    h('div', { key: String(it.at) + String(it.cause || ''), className: 'dshc-item' },
                      h(Pill, { tone: 'warn' }, '会成事件'),
                      h('div', { className: 't' }, String(it.cause || '（无原文）').slice(0, 42)),
                      h('div', { className: 'm dshc-mono' },
                        'sig ' + Number(it.sig).toFixed(2) + ' · ' + (AFFECT_KEY[it.label] || it.label) +
                        ' · ' + String(it.at || '').slice(5, 16)))))
                  : null)
            }
            const stat = (k, v) => h('div', { style: { minWidth: 64 } },
              h('div', { className: 'dshc-sub' }, k),
              h('div', { className: 'dshc-mono', style: { fontSize: 16 } }, v))
            return h('div', null,
              h('div', { style: { display: 'flex', gap: 20, flexWrap: 'wrap' } },
                stat('消息', g.total), stat(g.mode === 'on' ? '已成事件' : '会成事件', g.passed),
                stat('过闸率', Math.round(Number(g.rate) * 100) + '%'),
                stat('每天', g.perDay), stat('平均 sig', Number(g.avgSig).toFixed(2))),
              h('div', { className: 'dshc-sub', style: { marginTop: 8 } },
                'θ = ' + g.theta + ' · sig 分布 ' + (g.hist || []).join(' / ') + '（0–0.1 … 0.5+）'),
              g.humanness
                ? h('div', { className: 'dshc-sub', style: { marginTop: 4 } },
                  '像不像人：事件 ' + g.humanness.eventsPerDay + ' / 天 · 换脸 ' + g.humanness.labelFlipsPerDay + ' / 天 · 情绪惯性 ' +
                  (g.humanness.inertia == null ? '样本不够' : Number(g.humanness.inertia).toFixed(2)) +
                  '（惯性越高越不秒变；太低就是一惊一乍）')
                : null,
              replayLine,
              h('div', { className: 'dshc-list', style: { marginTop: 10 } }, (g.items || []).map((it) =>
                h('div', { key: String(it.at) + String(it.cause || ''), className: 'dshc-item' },
                  h(Pill, { tone: it.gate ? 'warn' : undefined }, it.gate ? (g.mode === 'on' ? '成事件' : '会成事件') : '不成事件'),
                  h('div', { className: 't' }, String(it.cause || '（无原文）').slice(0, 42)),
                  h('div', { className: 'm dshc-mono' },
                    'sig ' + Number(it.sig).toFixed(2) + ' · ' + (AFFECT_KEY[it.label] || it.label) +
                    ' · ' + String(it.at || '').slice(5, 16)))))
            )
          })())),

        /* 鎯呯华鍘嗗彶锛堟棩鍘嗙儹鍔?+ 鍙屾姌绾匡級宸插垹锛氳蛋鍔垮浘宸茬粡鎶娿€岃繖娈垫椂闂存€庝箞璧扮殑銆嶈娓呮浜?*/
        h(Sec, {
          title: '同一性盲测',
          desc: '5 句探针，检查称呼 / 禁用词 / 口头禅一致性；目标 ≥ 0.80。',
          right: h('select', {
            className: 'dshc-sel', style: { width: 92 },
            value: String(epLimit),
            onChange: (e) => setEpLimit(Number(e.target.value) || 1),
            title: '显示几条',
          },
            h('option', { value: '1' }, '最近 1 条'),
            h('option', { value: '10' }, '最近 10 条')),
        },
          h(Card, null, (function () {
            const items = (guess.data && guess.data.items) || []
            const st = (guess.data && guess.data.stats) || { n: 0, hits: 0 }
            if (!items.length) return h('div', { className: 'dshc-sub' }, '还没有情绪 episode。')
            const shown = items.slice(0, epLimit)
            const hidden = Math.max(0, items.length - shown.length)
            return h('div', null,
              h('div', { className: 'dshc-list' }, shown.map((it) =>
                h('div', { key: it.episode_id, className: 'dshc-readitem' },
                  h('div', { className: 'dshc-readitem-top' },
                    h(Pill, { title: it.dist ? '它读到的你' : '这条没留下对你的判断' },
                      it.top ? ('你·' + (AFFECT_KEY[it.top] || it.top)) : '没读你'),
                    h('div', { className: 't' }, it.cause || '（无诱因记录）'),
                    h('div', { className: 'm dshc-mono' },
                      '它自己 ' + (AFFECT_KEY[it.self.label] || it.self.label) + ' ' +
                      Number(it.self.intensity || 0).toFixed(2) +
                      (it.self.phase === 'rise' ? ' ↑上升中' : '') +
                      (Number(it.self.renewals) > 0 ? ' · 续' + Number(it.self.renewals) : '') +
                      ' · ' + String(it.at || '').slice(5, 16))),
                  it.dist
                    ? h(ReadFeedback, { aid, item: it, act, compact: true, onChange: () => setTick((t) => t + 1) })
                    : h('div', { className: 'dshc-note' }, '这条老记录没留下它读你的分数。')))),
              hidden > 0 && epLimit < 10
                ? h('div', { className: 'dshc-note', style: { marginTop: 8 } },
                  '还有 ' + hidden + ' 条收着；右上角改成「最近 10 条」就能看。')
                : null,
              h('div', { className: 'dshc-note', style: { marginTop: 8 } },
                st.n
                  ? '你一共纠正过 ' + st.n + ' 条 · 它读你准 ' + st.hits + '/' + st.n + '。'
                  : '还没纠正过它；点「不对」写下你实际的情绪，它就会学。'))
          })())),

        h(Sec, { techOnly: true, title: '工况', desc: '注意力、算力负载、专注 / 分心 / 过载。' },
          h(Card, null,
            h(Row, { label: '状态' }, h(Pill, { tone: c.state === 'overload' ? 'bad' : c.state === 'distracted' ? 'warn' : undefined },
              c.state === 'overload' ? '过载' : c.state === 'distracted' ? '分心' : '专注')),
            h(Row, { label: '注意力' }, h(Bar, { value: c.attention, tone: c.attention < 0.4 ? 'warn' : undefined }),
              h('span', { className: 'm dshc-mono' }, Number(c.attention).toFixed(2))),
            h(Row, { label: '算力负载' }, h(Bar, { value: c.load, tone: c.load > 0.8 ? 'bad' : undefined }),
              h('span', { className: 'm dshc-mono' }, Number(c.load).toFixed(2))),
            h('div', { className: 'dshc-form', style: { marginTop: 8 } },
              h(Btn, { onClick: () => setCond('attention', Math.max(0, Number(c.attention) - 0.1)) }, '注意力 −'),
              h(Btn, { onClick: () => setCond('attention', Math.min(1, Number(c.attention) + 0.1)) }, '注意力 +'),
              h(Btn, { onClick: () => setCond('load', Math.max(0, Number(c.load) - 0.1)) }, '负载 −'),
              h(Btn, { onClick: () => setCond('load', Math.min(1, Number(c.load) + 0.1)) }, '负载 +')),
            h('div', { className: 'dshc-note' }, '负载 > 0.8 判过载，注意力 < 0.4 判分心。工况归情绪，不放进驱力。'))),

        h(Sec, { techOnly: true, title: '三毒（贪 / 嗔 / 痴）', desc: '只进状态与门控，不进对话（§8 禁止清单）。' },
          h(Card, null, (() => {
            const pz = poison.data || {}
            const rows = [['贪', pz.greed, '依恋/探索缺口高于均值才涨'], ['嗔', pz.anger, '基线 + 刺激 + 过载'], ['痴', pz.delusion, '1 − 确定性']]
            return h('div', null,
              rows.map(([k, v, why]) => h(Row, { key: k, label: k + ' · ' + why },
                h(Bar, { value: Number(v) || 0, tone: Number(v) > 0.6 ? 'warn' : undefined }),
                h('span', { className: 'm dshc-mono' }, Number(v || 0).toFixed(2)))),
              h('div', { className: 'dshc-note' }, '初值 0.30 / 0.10 / 0.30（§5.2）　' + (pz.formula || '')))
          })())),
        h(Sec, { techOnly: true, title: '验收指标（8 条 · 地基附录 E）' },
          h(Card, null, h(MetricList, {
            from: 17, to: 25, view, setTab,
            catalog: metricSlice.catalog, values: metricSlice.values,
          }))),

        h(AlgoStrip, { aid, slots: ALGO_BY_TAB.affect, setTab }),

        h(Sec, { title: '模块关系', desc: '情绪 ↔ 记忆 / 鱼格 / 工况 / 表达。' },
          h(Card, null, h(EdgeGraphPanel, { aid }))))
    }

    /* ============================================================ actions */

    const PORT_META = [
      {
        name: 'send_message', title: '自动发消息', icon: '信', sub: '微信 · QQ · 每天 3 条打扰预算',
        desc: '打开后我能真的把话发出去：个人微信走本机窗口、企业微信走群机器人、QQ 走本机 OneBot 网关。发之前我会先确认收件人和内容。',
      },
      {
        name: 'browse', title: '浏览 / 检索', icon: '览', sub: '网页正文 · B 站搜索 / 热门 / 评论',
        desc: '只读。打开后我能打开一个网址读正文，也能搜 B 站、看首页推荐、看视频详情和高赞评论。不会改任何东西。',
      },
      {
        name: 'research', title: '研究搜集', icon: '研', sub: '多轮检索 · 去重 · 交叉印证',
        desc: '给一个题目和目的，我自己拆检索式、多轮搜、跳过读过的 URL、抓正文、把不同来源的说法对上，最后写一份带 [S#] 引用、可信度和可行性的报告。比较费 token。',
      },
      {
        name: 'remind', title: '提醒', icon: '醒', sub: '进收件箱 · 不弹系统通知',
        desc: '让我能把一件事放进你的收件箱，可带到期时间。它不会发微信 / QQ，也不会弹系统通知。',
      },
    ]
    const PORT_MAP = Object.fromEntries(PORT_META.map((m) => [m.name, m]))

    function ActionPanel({ aid, act, po, apply, agent, reloadAgents }) {
      const [cf, reload] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/action-config'), [aid])
      const [d, setD] = useState({})
      const [open, setOpen] = useState('')
      const [msg, setMsg] = useState('')
      const [st, setSt] = useState(null)
      const [busy, setBusy] = useState('')
      const [cmt, setCmt] = useState({ bvid: '', text: '' })
      useEffect(() => { if (cf.data) setD({ ...cf.data }) }, [cf.data])
      const set = (k, v) => setD((x) => ({ ...x, [k]: v }))
      const ports = (po && po.data) || []
      const enabledOf = (name) => !!(ports.find((p) => p.name === name) || {}).enabled
      const onCount = ports.filter((p) => p.enabled).length

      const toggle = async (name) => {
        setBusy('port:' + name); setMsg('')
        try {
          const next = !enabledOf(name)
          await apply(() => act(() => call('PUT', '/v1/agents/' + enc(aid) + '/action-ports/' + enc(name), { enabled: next }, true)))
          setOpen(next ? name : open === name ? '' : open)
        } catch (e) { setMsg('开关失败：' + e.message) } finally { setBusy('') }
      }
      const allOff = async () => {
        setBusy('all'); setMsg('')
        try {
          for (const p of ports) {
            if (p.enabled) {
              await act(() => call('PUT', '/v1/agents/' + enc(aid) + '/action-ports/' + enc(p.name), { enabled: false }, true))
            }
          }
          await apply(() => Promise.resolve())
          setMsg('所有接口都已关闭')
        } catch (e) { setMsg('关闭失败：' + e.message) } finally { setBusy('') }
      }
      const save = async () => {
        setMsg('')
        try {
          await act(() => call('PUT', '/v1/agents/' + enc(aid) + '/action-config', d, true))
          setMsg('通道配置已保存')
          reload()
        } catch (e) { setMsg('保存失败：' + e.message) }
      }
      const probe = async () => {
        setBusy('probe'); setMsg('')
        try { setSt(await call('GET', '/v1/agents/' + enc(aid) + '/action-status?fresh=1')) }
        catch (e) { setMsg('体检失败：' + e.message) } finally { setBusy('') }
      }
      const test = async (channel) => {
        setBusy(channel); setMsg('')
        try {
          const target = channel === 'qq' ? d['qq.default_target'] : d['wechat.default_target']
          const r = await act(() => call('POST', '/v1/agents/' + enc(aid) + '/actions/test', {
            channel, target: target || '', text: '这是一条通道测试（来自行动接口设置页）',
          }, true))
          setMsg((r.ok ? '测试成功：' : '测试失败：') + (r.detail || r.status || ''))
        } catch (e) { setMsg('测试失败：' + e.message) } finally { setBusy('') }
      }

      const sendComment = async () => {
        const bvid = String(cmt.bvid || '').trim()
        const text = String(cmt.text || '').trim()
        if (!bvid) { setMsg('先填 BV 号'); return }
        if (!text) { setMsg('评论内容是空的'); return }
        setBusy('comment'); setMsg('')
        try {
          const r = await act(() => call('POST', '/v1/agents/' + enc(aid) + '/comments', { platform: 'bilibili', target: bvid, text }, true))
          setMsg('评论已发出：' + (r.url || bvid) + (r.rpid ? '（id ' + r.rpid + '）' : ''))
          setCmt({ bvid, text: '' })
        } catch (e) { setMsg('发评论失败：' + e.message) } finally { setBusy('') }
      }

      const Field = ({ label, children, hint, wide }) => h('div', { className: 'dshc-pf' + (wide ? ' dshc-pf-w' : '') },
        h('label', null, label), children,
        hint ? h('div', { className: 'dshc-sub' }, hint) : null)

      const statPill = (ok, label, detail) => h(Pill, { on: !!ok, tone: ok ? 'ok' : 'warn', title: detail || '' }, label)

      const bodies = {
        send_message: () => h('div', { className: 'dshc-pgrid' },
          h(Field, { label: '微信通道' }, h(Seg, {
            items: [['uia', '个人微信'], ['wecom', '企业微信'], ['auto', '自动']],
            value: d['wechat.mode'] || 'uia', onChange: (v) => set('wechat.mode', v),
          }), h('div', { className: 'dshc-sub' }, d['wechat.mode'] === 'wecom' ? '只发群机器人，最稳。' : '个人微信：本机窗口，需已登录。')),
          h(Field, { label: '个人微信后端' }, h(Seg, {
            items: [['auto', '自动'], ['wechatauto', 'Python'], ['uia', 'UIA']],
            value: d['wechat.backend'] || 'auto', onChange: (v) => set('wechat.backend', v),
          }), h('div', { className: 'dshc-sub' }, '微信 4.1 聊天界面是自绘的，原生 UIA 读不到；装 wechatauto-replica 后走 Python 后端更可靠，没装就自动退回 UIA。')),
          h(Field, { label: '默认收件人' }, h(Input, {
            value: d['wechat.default_target'] || '', placeholder: '文件传输助手 / 联系人名',
            onChange: (e) => set('wechat.default_target', e.target.value),
          }), h('div', { className: 'dshc-sub' }, '只对个人微信生效；要求搜索结果里出现完全同名的联系人才发。')),
          h(Field, { label: '企业微信 webhook', wide: true }, h(Input, {
            type: 'password', value: d['wechat.wecom_webhook'] || '',
            placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…',
            onChange: (e) => set('wechat.wecom_webhook', e.target.value),
          }), h('div', { className: 'dshc-sub' }, '群机器人地址，只能发群；只存在本地。')),
          h(Field, { label: 'QQ OneBot 地址' }, h(Input, {
            value: d['qq.base_url'] || '', placeholder: 'http://127.0.0.1:3000',
            onChange: (e) => set('qq.base_url', e.target.value),
          })),
          h(Field, { label: 'QQ token' }, h(Input, {
            type: 'password', value: d['qq.token'] || '', placeholder: '可留空',
            onChange: (e) => set('qq.token', e.target.value),
          })),
          h(Field, { label: 'QQ 默认对象' }, h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            h(Seg, {
              items: [['private', '私聊'], ['group', '群']],
              value: d['qq.default_target_type'] || 'private', onChange: (v) => set('qq.default_target_type', v),
            }),
            h(Input, {
              style: { flex: 1, minWidth: 100 }, value: d['qq.default_target'] || '', placeholder: 'QQ 号 / 群号',
              onChange: (e) => set('qq.default_target', e.target.value),
            }))),
          h(Field, { label: '安全开关' }, h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            h(Btn, { sm: true, primary: !!d['wechat.allow_keys_fallback'], onClick: () => set('wechat.allow_keys_fallback', !d['wechat.allow_keys_fallback']) },
              d['wechat.allow_keys_fallback'] ? '键盘兜底：开' : '键盘兜底：关'),
            h(Btn, { sm: true, primary: !!d['wechat.dry_run'], onClick: () => set('wechat.dry_run', !d['wechat.dry_run']) },
              d['wechat.dry_run'] ? '演练模式：开' : '演练模式：关'))),
          h('div', { className: 'dshc-form' },
            h(Btn, { sm: true, onClick: () => test('wechat'), disabled: !!busy }, '测个人微信'),
            h(Btn, { sm: true, onClick: () => test('wecom'), disabled: !!busy }, '测企业微信'),
            h(Btn, { sm: true, onClick: () => test('qq'), disabled: !!busy }, '测 QQ')),
          st ? h('div', { className: 'dshc-pstat' },
            statPill(st.wechat && st.wechat.logged_in, '微信', st.wechat && (st.wechat.error || st.wechat.hint)),
            h('span', { className: 'dshc-sub' }, st.wechat ? (st.wechat.logged_in ? '窗口可操作' : (st.wechat.error || '不可用')) : ''),
            statPill(st.qq && st.qq.ok, 'QQ', st.qq && st.qq.error),
            h('span', { className: 'dshc-sub' }, st.qq ? (st.qq.ok ? ('已连接' + (st.qq.user ? '：' + st.qq.user : '')) : (st.qq.error || '连不上')) : ''))
            : null),

        browse: () => h('div', { className: 'dshc-pgrid' },
          h(Field, { label: 'B 站 Cookie', wide: true }, h(Input, {
            type: 'password', value: d['bili.cookie'] || '', placeholder: '可留空：游客也能搜索 / 热门',
            onChange: (e) => set('bili.cookie', e.target.value),
          }), h('div', { className: 'dshc-sub' }, '填 SESSDATA 后能看关注流、少撞风控；不填也能用公开接口。')),
          h(Field, { label: '默认条数' }, h(Input, {
            type: 'number', min: 1, max: 30, value: d['bili.limit'] || 10,
            onChange: (e) => set('bili.limit', Number(e.target.value) || 10),
          })),
          h(Field, { label: '网页抓取' }, h('div', { className: 'dshc-sub' }, '走宿主的 web 服务，和 web_fetch 同一套出口；不限于 B 站。')),
          h(Field, { label: 'B 站评论', wide: true },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h(Input, {
                value: cmt.bvid, placeholder: 'BV 号，例如 BV1xx411c7mD',
                onChange: (e) => setCmt((x) => ({ ...x, bvid: e.target.value })),
              }),
              h('textarea', {
                className: 'dshc-ta', rows: 2, value: cmt.text, placeholder: '评论正文（≤800 字）',
                onChange: (e) => setCmt((x) => ({ ...x, text: e.target.value })),
              }),
              h('div', { className: 'dshc-form' },
                h(Btn, { sm: true, primary: true, onClick: sendComment, disabled: busy === 'comment' },
                  busy === 'comment' ? '发送中…' : '发这条评论'))),
            '公开可见、不可撤回；需要 Cookie 里同时有 SESSDATA 和 bili_jct。发之前确认内容和视频都对。'),
          st ? h('div', { className: 'dshc-pstat', style: { gridColumn: '1/-1' } },
            statPill(st.bili && st.bili.ok, 'B 站', st.bili && st.bili.error),
            h('span', { className: 'dshc-sub' }, st.bili ? (st.bili.ok ? (st.bili.note || '可用') : (st.bili.error || '不可用')) : ''))
            : null),

        research: () => h('div', { className: 'dshc-pgrid' },
          h(Field, { label: '默认深度' }, h(Seg, {
            items: [['quick', '快速'], ['standard', '标准'], ['deep', '深挖']],
            value: d['research.depth'] || 'standard', onChange: (v) => set('research.depth', v),
          }), h('div', { className: 'dshc-sub' }, '快速≈5 个来源 / 标准≈9 / 深挖≈14。')),
          h(Field, { label: '最多来源' }, h(Input, {
            type: 'number', min: 3, max: 24, value: d['research.max_sources'] || 12,
            onChange: (e) => set('research.max_sources', Number(e.target.value) || 12),
          })),
          h(Field, { label: '去重窗口（天）' }, h(Input, {
            type: 'number', min: 1, max: 365, value: d['research.seen_days'] || 60,
            onChange: (e) => set('research.seen_days', Number(e.target.value) || 60),
          }), h('div', { className: 'dshc-sub' }, '读过的同一 URL 在窗口内跳过，避免把旧料当新发现。')),
          h('div', { className: 'dshc-sub', style: { gridColumn: '1/-1' } },
            '每个来源会标域名分档、可信度、日期；每条说法会标独立来源数和置信度，单来源的会写明「单一来源」。')),

        remind: () => h('div', { className: 'dshc-sub' },
          '打开后我只往收件箱放条目；到点是否提醒由收件箱自己处理，不会绕过你发消息。'),
      }

      const voicePanel = () => h('div', { className: 'dshc-pgrid', style: { marginTop: 12 } },
        h(Field, { label: '怎么说话', wide: true }, h(Seg, {
          items: [['ptt', '按住空格'], ['open', '一直开麦']],
          value: d['voice.mic.mode'] || 'ptt', onChange: (v) => set('voice.mic.mode', v),
        }), h('div', { className: 'dshc-sub' },
          (d['voice.mic.mode'] || 'ptt') === 'open'
            ? '对话框旁点「开麦」：一直听，你说完停一下就自动送进对话。费电，也容易把旁边的声音听进去。'
            : '在对话页按住空格说话，松开就送。输入框里已经在打字时，空格还是打空格。')),
        h(Field, { label: '回完自动念', wide: true }, h(Seg, {
          items: [['auto', '开'], ['off', '关']],
          value: (d['voice.reply.mode'] === 'off' || d['voice.reply.mode'] === 'click') ? 'off' : 'auto',
          onChange: (v) => set('voice.reply.mode', v),
        }), h('div', { className: 'dshc-sub' },
          (d['voice.reply.mode'] === 'off' || d['voice.reply.mode'] === 'click')
            ? '回完只出文字，不念。'
            : '你用麦克风说完、她回完之后，本机自动念出来。打字聊天不会念。')),
        h(Field, { label: '嗓子' }, h(Seg, {
          items: [['azure', '微软'], ['compat', '兼容接口'], ['local', '本机'], ['breeze', 'BreezeBlue']],
          value: d['voice.provider'] || 'azure', onChange: (v) => set('voice.provider', v),
        })),
        h(Field, { label: '嗓子密钥' }, h(Input, {
          type: 'password', value: d['voice.api_key'] || '', placeholder: '本机嗓子可留空',
          onChange: (e) => set('voice.api_key', e.target.value),
        })),
        (d['voice.provider'] || '') === 'local' ? h(Field, { label: '本机地址 / 参考音频', wide: true },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h(Input, {
              value: d['voice.local_url'] || '', placeholder: 'http://127.0.0.1:9880',
              onChange: (e) => set('voice.local_url', e.target.value),
            }),
            h(Input, {
              value: d['voice.local_ref'] || '', placeholder: '参考音频路径（克隆嗓子用）',
              onChange: (e) => set('voice.local_ref', e.target.value),
            }))) : null,
        (d['voice.provider'] || '') === 'breeze' ? h(Field, { label: 'BreezeBlue 音色 / 模型', wide: true },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h(Input, {
              value: d['voice.breeze_voice'] || '', placeholder: '音色 ID，例如 voc_u3nxkd5578wc',
              onChange: (e) => set('voice.breeze_voice', e.target.value),
            }),
            h(Input, {
              value: d['voice.breeze_model'] || '', placeholder: 'breeze-tts-2',
              onChange: (e) => set('voice.breeze_model', e.target.value),
            }),
            h(Input, {
              value: d['voice.breeze_instructions'] || '', placeholder: '语气说明（可留空），例如：轻软一点，别念得太板',
              onChange: (e) => set('voice.breeze_instructions', e.target.value),
            }),
            h('div', { className: 'dshc-sub' },
              '密钥填上面那个「嗓子密钥」（brz_ 开头）。大肥鱼两款：机灵版 voc_u3nxkd5578wc / 迷糊版 voc_8yud7hz7c9q2。')))
          : null,
        h(Field, { label: '念完播放' }, h(Btn, {
          sm: true, primary: d['voice.play'] !== false,
          onClick: () => set('voice.play', !(d['voice.play'] !== false)),
        }, d['voice.play'] !== false ? '开' : '关')))

      const card = (meta) => {
        const on = enabledOf(meta.name)
        const isOpen = open === meta.name
        return h('div', {
          key: meta.name, className: 'dshc-port', 'data-on': on ? '1' : '0', 'data-open': isOpen ? '1' : '0',
        },
        h('div', {
          className: 'dshc-ph', role: 'button', tabIndex: 0,
          'aria-expanded': isOpen ? 'true' : 'false',
          onClick: () => setOpen(isOpen ? '' : meta.name),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(isOpen ? '' : meta.name) } },
        },
        h('span', { className: 'dshc-pi' }, meta.icon),
        h('div', { className: 'dshc-pt' }, h('b', null, meta.title), h('span', null, meta.sub)),
        h('button', {
          type: 'button', className: 'dshc-sw', 'data-on': on ? '1' : '0',
          role: 'switch', 'aria-checked': on ? 'true' : 'false',
          title: on ? '关闭' : '打开', disabled: busy === 'port:' + meta.name,
          onClick: (e) => { e.stopPropagation(); toggle(meta.name) },
        }, h('i')),
        h('span', { className: 'dshc-ch', 'aria-hidden': true }, '›')),
        isOpen ? h('div', { className: 'dshc-pb' },
          h('div', { className: 'dshc-sub' }, meta.desc),
          bodies[meta.name] ? bodies[meta.name]() : null,
          h('div', { className: 'dshc-sub' },
            '打开后模型会多出对应工具；关着时工具在，但一调用就被拒。')) : null)
      }

      return h(Card, null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' } },
          h(Pill, { on: onCount > 0, tone: onCount > 0 ? 'ok' : 'warn' }, onCount + ' / 4 已开'),
          h('span', { className: 'dshc-sub' }, onCount ? '点开关直接生效；点行体看它能做什么、怎么接。' : '全关：我只能看，不能动。'),
          h('div', { className: 'dshc-spacer' }),
          onCount ? h(Btn, { sm: true, danger: true, onClick: allOff, disabled: busy === 'all' }, '全部关闭') : null),
        cf.error ? h('div', { className: 'dshc-err' }, cf.error) : null,
        h('div', { className: 'dshc-ports' }, PORT_META.map(card)),
        h('div', { style: { marginTop: 14 } },
          h('b', { style: { fontSize: 13 } }, '本机对着麦说话'),
          h('div', { className: 'dshc-sub', style: { marginTop: 4 } },
            '对话页按住空格说话（或开「一直开麦」）。要先在宿主里启用「语音输入」实验包，嗓子配好才会出声。'),
          voicePanel()),
        h('div', { className: 'dshc-form', style: { marginTop: 10 } },
          h(Btn, { primary: true, onClick: save }, '保存配置'),
          h(Btn, { onClick: probe, disabled: busy === 'probe' }, busy === 'probe' ? '体检中…' : '体检通道'),
          h('span', { className: 'dshc-sub' }, '配置只存在本地 app.db；webhook / token 不会外发。')),
        msg ? h('div', { className: 'dshc-note', style: { marginTop: 8 } }, msg) : null)
    }

    /* ============================================================== drive */

    function DrivePage({ aid, view, act, setTab, agent, reloadAgents }) {
      const [tick, setTick] = useState(0)
      const [err, setErr] = useState('')
      const [drv] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/drive'), [aid, tick])
      const [po] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/action-ports'), [aid, tick])
      const [leg] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/legitimacy'), [aid, tick])
      const [tg] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/targets'), [aid, tick])
      const [dv] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/drivers'), [aid, tick])
      const metricSlice = useMetricSlice(aid, 25, 33)
      const d = drv.data || {}
      const tokens = d.tokens || {}
      const CAP = { c1: 1, c2: 1, c3: 2, c4: 4 }
      const L = leg.data || {}
      const driveState = drv.error ? '断流' : d.dormant ? '休眠' : (d.band ? '正常' : '无数据')
      const apply = async (fn) => {
        setErr('')
        try { await fn(); setTick((t) => t + 1) } catch (e) { setErr(e.message) }
      }

      return h('div', null,
        h(LoadErr, { error: drv.error || leg.error, retry: () => setTick((t) => t + 1) }),
        h(Sec, { title: view === 'user' ? '它现在最想要什么' : '缺口与预算（deficit / tokens）', desc: view === 'user' ? '五个需求各有各的饿，最饿的那个决定它现在有多想动。' : 'n_i=(s_i-x_i)/s_i；最饿的一维决定 band；令牌决定能改多少。' },
          h(Card, null,
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
              view === 'tech' ? h('span', { style: { fontSize: 24, fontWeight: 600, letterSpacing: 1 } }, d.band || '—') : null,
              view === 'tech' ? h(Pill, { tone: driveState === '休眠' ? 'warn' : driveState === '断流' ? 'bad' : undefined }, driveState) : null,
              view === 'user' ? (() => {
                const r = needRank(d)
                const top = r[0] || { l: '—', n: 0 }
                const next = r[1] || { l: '', n: 0 }
                const calm = !(top.n >= 0.03)
                const tied = !calm && (top.n - next.n) < 0.015
                return h('div', null,
                  h('div', { style: { fontSize: 16, fontWeight: 600 } },
                    calm ? '现在哪条都不太饿' : '现在最饿的是：' + top.l),
                  h('div', { className: 'dshc-sub' },
                    calm ? '五条都差不多吃饱了，先待着也行。'
                      : '缺口 ' + top.n.toFixed(2)
                        + (tied ? '，和' + next.l + '（' + next.n.toFixed(2) + '）几乎一样' : '')
                        + (top.n >= 0.10
                          ? '，已经过了有点想动的线（0.10）。'
                          : '，离有点想动（0.10）还有点距离。')))
              })() : null,
              view === 'tech' ? h('span', { className: 'dshc-sub' }, 'D = ' + Number(d.D || 0).toFixed(3)) : null,
              view === 'tech' ? h('span', { className: 'dshc-sub' }, '连续同档 ' + (d.streak || 0) + ' 次') : null,
              view === 'tech' && d.algo ? h('span', { className: 'dshc-sub dshc-mono' }, 'deficit@' + (d.algo.version || '?')) : null,
              h('div', { className: 'dshc-spacer' }),
              h(Btn, { onClick: () => apply(() => act(() => call('POST', '/v1/agents/' + enc(aid) + '/drive/evaluate', {}, true))) }, '评估一次')),
            h('div', { style: { marginTop: 12 } },
              h(NeedCups, { d, tech: view === 'tech' })),
            h('div', { className: 'dshc-legend' },
              h('span', null, h('u', { className: 'w' }), '已经满足'),
              h('span', null, h('u', { className: 'g' }), '缺口 ＝ 它现在想要的'),
              h('span', null, h('u', { className: 'r' }), '杯口 ＝ 胃口')),
            h('div', { style: { marginTop: 8, fontSize: 12.5, lineHeight: 1.7, opacity: 0.86 } },
              '缺口就是欲望：杯口是它的胃口，水是已经满足的，空着的那截就是它现在想要的程度——越长越饿，越红越急。'),
            h('div', { className: 'dshc-sub' },
              '胃口：' + DIMS.map(([k, l]) => l + ' ' + (Number(d.setpoint && d.setpoint[k]) || 0).toFixed(2)).join(' · ')
              + '。这五条是它自己被对待出来的，不用你调，被冷落久了会往下挪。'),
            view === 'tech' ? h('div', { style: { display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' } },
              ['c1', 'c2', 'c3', 'c4'].map((k) => h(Pill, { key: k, on: Number(tokens[k]) >= 1 },
                k.toUpperCase() + ' ' + Math.floor(Number(tokens[k] || 0)) + '/' + CAP[k]))) : null,
            view === 'tech' ? h('div', { className: 'dshc-form', style: { marginTop: 10 } },
              h(Btn, { onClick: () => apply(() => act(() => call('POST', '/v1/agents/' + enc(aid) + '/tokens/refill', {}, true))) }, '补充令牌'),
              h(Btn, { onClick: () => apply(() => act(() => call('POST', '/v1/agents/' + enc(aid) + '/tokens/consume', { class: 'c4' }, true))) }, '消耗一枚 C4')) : null,
            view === 'tech' ? h('div', { className: 'dshc-note' }, '令牌不足 409 BUDGET；全局每天最多一次真实变更（COOLDOWN）。休眠 14 天不攒令牌。') : null,
            err ? h('div', { className: 'dshc-err' }, err) : null)),

        view === 'tech' ? h(Tech, null, 'n_i = max(0, s_i - x_i) / s_i       s=自己长出来的胃口（0.35–0.98），x=当前满足度\n上面画的是平滑后的 ñ（α=0.35），所以和 (胃口−现在)/胃口 的瞬时值会差一点\n加权：D = max(w_i · ñ_i)，Σw = 5（权重 = 1 + 0.35·性格 + 0.25·价值观，再归一）\n耦合：5×5 符号边（R↔A 是负边，强度固定 0.05）\n胃口：s = habit + 0.08·k·(1−h/2) + 0.10·T + 0.05·V + 外部(关系/底色/工况/浏览/长期情绪)，外部封顶 ±0.08；k 是 drive.setpoint.appetite\n长期情绪：用「此刻情绪」的标签和力度改胃口——被挡住的需求→胃口撑大，刚喂饱的→收一点，最多 ±0.06\n一次性情绪事件另有一条 ±0.02 的小通路，但每次评估代理都会把满足度往回拉（PULL 0.3），所以它只做瞬时抖动，留不住\n基线学习：habit(t+dt)=habit+(x−habit)(1−e^(−dt/21))；首次评估直接对齐，之后每天最多挪 0.02\n满足度回落：每天 0.12（八天掉光）\nband = hysteresis(D, prev, enter{0.10,0.18,0.35}, exit{0.07,0.155,0.30})，一次评估最多升一档\n主动开口的门槛跟着档位走：D1 0.22 / D2 0.15 / D3 0.10，D0 不开口；另外还要手上有真事、沉默够久\n令牌：C1 1/180d · C2 1/90d · C3 2/30d · C4 4/7d\nG3：每实例每天最多 1 次变更（全局日限）') : null,
        h(Sec, { techOnly: true, title: '合法性约束', desc: 'BLOCK 时一律拒绝变更；不参与「谁最饿」排序。' },
          h(Card, null,
            h(Row, { label: '判定' },
              h(Pill, { tone: L.pass === false ? 'bad' : undefined, on: L.pass !== false },
                L.pass === false ? 'BLOCK' : 'PASS')),
            (L.reasons || []).length
              ? h('div', { className: 'dshc-list', style: { marginTop: 6 } },
                L.reasons.map((r, i) => h('div', { key: i, className: 'dshc-item' },
                  h(Pill, { tone: 'bad' }, r.code || '—'),
                  h('div', { className: 't' }, r.text || ''))))
              : h('div', { className: 'dshc-sub' }, '安全维与 root 禁忌均未触发。'),
            h(Row, { label: 'S（安全）', value: L.S != null ? Number(L.S).toFixed(3) : '—' }))),



        h('details', { style: { marginTop: 10 } },
          h('summary', { className: 'dshc-fold' }, '提案目标（它在攒什么证据）'),
          (dv.data || []).length ? h('div', { className: 'dshc-list', style: { marginTop: 6 } }, dv.data.map((x, i) => h('div', { key: i, className: 'dshc-item' },
            h(Pill, { tone: x.severity === 'high' ? 'bad' : 'warn' }, '异常'),
            h('div', { className: 't' }, x.text || x.driver)))) : null,
          h('div', { className: 'dshc-list', style: { marginTop: 6 } }, (tg.data || []).map((x) => h('div', { key: x.id, className: 'dshc-item' },
            h(Pill, { on: Number(x.progress) >= Number(x.threshold) }, x.class),
            h('div', { className: 't' }, x.label + ' · ' + Math.min(Number(x.progress), Number(x.threshold)) + '/' + x.threshold),
            h('div', { className: 'm dshc-mono' }, '近 ' + x.windowDays + ' 天' + (x.lastDraftAt ? ' · 上次起草 ' + String(x.lastDraftAt).slice(5, 10) : ''))))) ),

        h(Sec, { title: '行动接口', desc: '四个开关；打开后我才可能真的动手。' },
          h(ActionPanel, { aid, act, po, apply, agent, reloadAgents })),

        h(Sec, { techOnly: true, title: '验收指标（8 条 · 地基附录 E）' },
          h(Card, null, h(MetricList, {
            from: 25, to: 33, view, setTab,
            catalog: metricSlice.catalog, values: metricSlice.values,
          }))),

        h(AlgoStrip, { aid, slots: ALGO_BY_TAB.drive, setTab }),

        h(Sec, { title: '模块关系', desc: '驱力 → 主动开口；情绪 → 驱力（E4）。' },
          h(Card, null, h(EdgeGraphPanel, { aid }))))
    }

    /* =============================================================== self */

    function DraftRow({ d, aid, act, onDone }) {
      const ev = (() => { try { return JSON.parse(d.gate_trace || '[]')[0] || {} } catch { return {} } })()
      const [key, setKey] = useState((ev.suggest && ev.suggest.key) || '')
      const [name, setName] = useState((ev.suggest && ev.suggest.name) || '')
      const [busy, setBusy] = useState(false)
      const [growing, setGrowing] = useState(false)
      const [msg, setMsg] = useState('')
      async function submit() {
        setBusy(true); setMsg('')
        try {
          const r = await act(() => call('POST', '/v1/proposals/' + enc(d.id) + '/promote', { key, name }, true))
          setMsg('已提交，进影子：' + (r.shadow_total || 0) + ' 轮')
          onDone()
        } catch (e) { setMsg('提交失败：' + e.message) } finally { setBusy(false) }
      }
      return h('div', { className: 'dshc-item', style: { flexDirection: 'column', alignItems: 'stretch', gap: 6 } },
        h('div', null, '认不出 ' + Number(ev.samples || 0) + ' 条'),
        h('div', null, '它起的名字：' + (((ev.suggest && ev.suggest.name) || '') || '（没想好）') + (((ev.suggest && ev.suggest.key) ? ' · ' + ev.suggest.key : ''))),
        (ev.suggest && ev.suggest.definition) ? h('div', { className: 'dshc-sub' }, ev.suggest.definition) : null,
        (ev.suggest && ev.suggest.overlap && ev.suggest.overlap !== 'none' && ev.suggest.overlap !== 'unknown')
          ? h('div', { className: 'dshc-err' }, '这 ' + Number(ev.samples || 0) + ' 条更像「' + ev.suggest.overlap + '」——可能不该加新词，先看看是不是判定规则该改。')
          : null,
        h('details', null,
          h('summary', { style: { cursor: 'pointer' } }, '看证据（' + ((ev.texts || []).length) + ' 条）'),
          h('div', { className: 'dshc-list', style: { marginTop: 6 } },
            (ev.texts || []).map((t, i) => h('div', { key: i, className: 'dshc-item' }, t)))),
        h('div', { className: 'dshc-form' },
          h(Input, { className: 'grow', placeholder: 'key（它给的建议，可改）', value: key, onChange: (e) => setKey(e.target.value) }),
          h(Input, { className: 'grow', placeholder: '中文名（它给的建议，可改）', value: name, onChange: (e) => setName(e.target.value) }),
          h(Btn, { primary: true, disabled: busy, onClick: submit }, '批准')),
        msg ? h('div', { className: 'dshc-note' }, msg) : null)
    }

    /* ---------------- 自修改页：把「改自己」讲清楚 ---------------- */

    const SELF_CLASS = {
      C1: ['结构', '改模块之间的边和权重，影响面最大，影子 40 轮'],
      C2: ['分类', '改情绪分类表，影响它认得出什么，影子 20 轮'],
      C3: ['规则', '换一套算法版本，行为会跟着变，影子 20 轮'],
      C4: ['数值', '调一个参数，它自己就能做，不用你点头'],
    }
    const SELF_FIELD = {
      'memory.recall.floor': '召回最低分',
      'memory.decay.lambda': '遗忘速度',
      'memory.inject.budget': '每轮注入预算',
      'memory.auto': '自动整理记忆',
      'memory.cleanup.runtime_noise': '运行时噪声清理',
      'memory.inject.pool': '记忆注入池',
      'memory.recall.formula': '召回算法版本',
      'taxonomy.labels': '情绪分类表',
      'structure.edges': '结构边权重',
      'affect.mapping': '情绪评价算法',
      'persona.axis.ei': '外向度',
      'persona.axis.sn': '实感 / 直觉',
      'persona.axis.tf': '思考 / 情感',
      'persona.axis.jp': '判断 / 知觉',
      'persona.axis.sensitivity': '敏感度',
      'persona.big5.agreeableness': '宜人性',
      'mind.meter.enable': '水位提醒',
      'mind.meter.ratio': '提醒水位',
      'mind.meter.window': '上下文窗口',
      'mind.review.enable': '欠债提醒',
      'mind.review.hours': '多久算欠债',
      'mind.review.min_turns': '欠多少条',
      'mind.review.cooldown_hours': '提醒冷却',
      'gate.guest.enable': '认人硬闸',
    }
