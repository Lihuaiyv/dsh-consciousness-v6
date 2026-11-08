    const VALUE_TENSION = [
      ['benevolence', 'power', '对人好，还是说了算'],
      ['tradition', 'selfDirection', '守老规矩，还是自己决定'],
      ['security', 'stimulation', '求稳，还是求新'],
    ]
    function TensionBlock({ rows }) {
      const map = new Map((rows || []).map((r) => [r.key, r]))
      return h('div', { className: 'dshc-tens' },
        h('div', { className: 'dshc-sub', style: { marginBottom: 2 } }, '心里的三股劲'),
        VALUE_TENSION.map(([a, b, q]) => {
          const A = map.get(a), B = map.get(b)
          if (!A || !B) return null
          const aw = Number(A.weight) || 0, bw = Number(B.weight) || 0
          const gap = Math.abs(aw - bw)
          const lean = gap < 0.02 ? null : (aw > bw ? A : B)
          return h('div', { key: a, className: 'dshc-ten' },
            h('span', { className: 'q' }, q),
            h('span', { className: 'p dshc-mono' }, A.label + ' ' + aw.toFixed(2) + ' →' + B.label + ' ' + bw.toFixed(2)),
            h('span', { className: 'l', 'data-on': lean ? '1' : '0' },
              lean ? (gap < 0.05 ? '略偏「' : '偏「') + lean.label + '」' : '还没偏向'))
        }))
    }

    /** 价值观小雷达（键作轴） */
    function ValuesRadar({ rows, size = 160 }) {
      const list = (rows || []).slice(0, 10)
      if (!list.length) return h('div', { className: 'dshc-sub' }, '还没有价值观权重。')
      const cx = size / 2, cy = size / 2, r = size * 0.36
      const pt = (i, v) => {
        const a = (-Math.PI / 2) + (i / list.length) * Math.PI * 2
        return [cx + Math.cos(a) * r * v, cy + Math.sin(a) * r * v]
      }
      const maxW = Math.max(0.001, ...list.map((r) => Number(r.weight) || 0))
      const poly = list.map((row, i) => pt(i, Math.max(0, Math.min(1, (Number(row.weight) || 0) / maxW))).join(',')).join(' ')
      return h('svg', { width: size, height: size, viewBox: '0 0 ' + size + ' ' + size, style: { display: 'block', margin: '0 auto' } },
        h('polygon', {
          points: list.map((_, i) => pt(i, 1).join(',')).join(' '),
          fill: 'none', stroke: 'currentColor', opacity: 0.15,
        }),
        h('polygon', { points: poly, fill: 'color-mix(in srgb, var(--accent) 25%, transparent)', stroke: 'var(--accent)', strokeWidth: 1.4 }),
        list.map((row, i) => {
          const [x, y] = pt(i, 1.22)
          return h('text', { key: row.key, x, y, fontSize: 8, textAnchor: 'middle', fill: 'currentColor', opacity: 0.75 }, String(row.label || row.key).slice(0, 6))
        }))
    }

    const removePendingLabel = () => null

    /** 鏈€娓呮鐨勮蹇嗭細浜嬪疄灞傛寜銆屾鍒汇€峢eat 鍙栧墠 99锛涘崱鐗囨牸寮忎笌鏃堕棿绾垮榻愶紝鎸夋。浣嶆姌鍙犮€?*/
    const HEAT_BANDS = [
      { key: 'short', label: '短期', hint: '桌面 · 最清楚' },
      { key: 'mid', label: '中期', hint: '还热着' },
      { key: 'long', label: '长期', hint: '抽屉里' },
    ]
    /**
     * 时态（记忆时态 v5）：哪些旧说法被收起来了、哪些旧判断会带上日期。
     * 只读，数字来自 GET /v1/agents/:id/memory/health。
     */
    function TensePanel({ aid }) {
      const [s, reload] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/memory/health'), [aid])
      if (s.loading) return h('div', { className: 'dshc-sub' }, '读取时态…')
      if (s.error) return h('div', { className: 'dshc-err' }, s.error)
      const d = s.data || {}
      const st = d.stale || {}
      const k = d.keys || {}
      const by = k.by_type || {}
      const line = (txt, title) => h('div', { className: 'dshc-sub', title }, txt)
      return h('div', null,
        line('已作废 ' + (Number(st.superseded) || 0) + ' 条；其中 ' + (Number(st.ejected) || 0) + ' 条不再进正桌（召回不到，只能翻账本）。'),
        line('旧反思 / 情景 / 评价里，' + (Number(st.statement_eligible) || 0) + ' 条超过三天，注入时会带一句「这是哪天的判断」。'),
        line('真槽位 key（事实 / 评价）' + (Number(d.passport && d.passport.slot) || 0) + ' 条；带 key 的共 ' + (Number(k.with_key) || 0) + ' 条（其余是检索用，不参与判新旧）。'),
        Object.keys(by).length
          ? h('details', { className: 'dshc-fold' },
            h('summary', null, '按类型的 key 分布'),
            Object.entries(by).map(([t, v]) => h('div', { key: t, className: 'dshc-sub' },
              (TYPE_LABEL[t] || t) + '：' + (Number(v.total) || 0) + ' 条，带 key ' + (Number(v.key) || 0) + ' 条')))
          : null,
        h('div', { style: { marginTop: 6 } }, h(Btn, { onClick: () => reload() }, '刷新')))
    }

    function TopMemory({ aid, tick, row, act, onWrote }) {
      const [openN, setOpenN] = useState(0)
      const [msg, setMsg] = useState('')
      const [busy, setBusy] = useState(false)
      const [s, reload] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/memory/top?limit=99'), [aid, tick])
      // 有档展开才轮询；跟时间线一样走卡片折叠，不必关着也刷
      useLive(reload, openN > 0 ? 10000 : 0)
      const items = (s.data && s.data.items) || []
      const total = Number((s.data && s.data.total) || items.length) || 0
      const counts = (s.data && s.data.counts) || null
      const at = (s.data && s.data.at) || ''
      if (s.loading && !s.data) return h(Empty, null, '读取热度榜…')
      if (s.error && !s.data) return h(LoadErr, { error: s.error, retry: reload })

      const byBand = { short: [], mid: [], long: [] }
      for (const m of items) {
        const k = (m.band && byBand[m.band]) ? m.band : 'mid'
        byBand[k].push(m)
      }
      const filled = counts
        ? HEAT_BANDS.filter((b) => Number(counts[b.key] || 0) > 0).length
        : HEAT_BANDS.filter((b) => byBand[b.key].length > 0).length
      // 同一条感觉会被好几条记忆共享：列表里只展开一次，其余写「同上一条」
      const feelOnce = new Set()
      const rowOnce = (m) => {
        const key = m.feel && m.feel.text ? String(m.feel.text) : ''
        const dup = !!key && feelOnce.has(key)
        if (key && !dup) feelOnce.add(key)
        return row(m, dup)
      }
      // 鏈湴 mix锛岄伩鍏嶄緷璧栧悗闈㈡墠澹版槑鐨?tlMix锛堟湁鐨勫姞杞藉櫒涓嶆寜鍑芥暟鎻愬崌锛?''
              const mixOf = (arr) => {
        const m = new Map()
        for (const it of arr || []) m.set(it.type, (m.get(it.type) || 0) + 1)
        return [...m.entries()].sort((a, b) => b[1] - a[1])
      }

      // 鎶婃鍒荤畻鍑烘潵鐨勭儹搴﹀啓鍥炲簱锛氭瘡杞敞鍏ユ槸鎸夊簱閲岀殑 heat 鎺掑簭鍙栧墠 10 鏉＄殑锛?''
      // 鍙幇绠椾笉鍐欏簱锛屾敞鍏ラ偅澶寸敤鐨勮繕鏄笂涓€娆″贰妫€鐨勬暟銆?''
              async function writeHeats(e) {
        if (e && e.stopPropagation) e.stopPropagation()
        setBusy(true); setMsg('打包中…')
        try {
          const r = await act(() => call('POST', '/v1/agents/' + enc(aid) + '/tiers/refresh', {}, true))
          setMsg('已写回 · 短期 ' + Number((r && r.short) || 0) + ' / 中期 ' + Number((r && r.mid) || 0) + ' / 长期 ' + Number((r && r.long) || 0))
          await reload()
          if (onWrote) onWrote()
        } catch (err) { setMsg(err.message || String(err)) } finally { setBusy(false) }
      }

      const countLine = counts
        ? ('短 ' + Number(counts.short || 0) + ' · 中 ' + Number(counts.mid || 0) + ' · 长 ' + Number(counts.long || 0))
        : (items.length + ' 条' + (total > items.length ? ' / 共 ' + total : ''))

      return h(Card, null,
        h('div', { className: 'dshc-tl-meta' },
          h('span', { className: 'dshc-sub' }, '按热度'),
          h('span', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' } },
            h('span', { className: 'dshc-mono' },
              countLine +
              ' · ' + filled + '/3 档有记' +
              (at ? ' · 算于 ' + clockOf(at) : '')),
            h(Btn, { ghost: true, sm: true, disabled: busy, onClick: writeHeats, title: '把现在这套热度写进库，注入排序也跟着更新' },
              busy ? '写回中…' : '写回库'),
            msg ? h('span', { className: 'dshc-note' }, msg) : null)),
        items.length === 0
          ? h(Empty, null, '还没有能排上号的记忆。')
          : h('div', { className: 'dshc-tl' }, HEAT_BANDS.map((b) => {
            const list = byBand[b.key]
            const nAll = counts ? Number(counts[b.key] || 0) : list.length
            const mx = mixOf(list)
            return h('details', {
              key: b.key,
              className: 'dshc-tl-day',
              // 蹇呴』鍏堣 open锛歴etState 鍥炶皟閲屽啀纰?currentTarget 浼氭槸 null锛屾暣椤电洿鎺ョ櫧灞?''
              onToggle: (e) => {
                const open = !!(e && e.currentTarget && e.currentTarget.open)
                setOpenN((n) => Math.max(0, n + (open ? 1 : -1)))
              },
            },
              h('summary', null,
                h('span', { className: 'dshc-tl-date' },
                  b.label,
                  h('em', null, b.hint)),
                h('span', {
                  className: 'dshc-tl-mix',
                  title: mx.map(([k, n]) => (TYPE_LABEL[k] || k) + ' ' + n).join(' · ') || '空',
                }, mx.length
                  ? mx.slice(0, 3).map(([k, n]) => h('i', { key: k, 'data-t': k, style: { flex: String(n) } }))
                  : null),
                h('span', { className: 'dshc-tl-spacer' }),
                h('span', { className: 'dshc-tl-count' },
                  nAll + ' 条' + (list.length && list.length < nAll ? ' · 展 ' + list.length : '')),
                h('svg', { className: 'dshc-tl-chev', viewBox: '0 0 12 12', 'aria-hidden': 'true' },
                  h('path', {
                    d: 'M4 2.5 L8 6 L4 9.5', fill: 'none', stroke: 'currentColor',
                    strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
                  }))),
              list.length === 0
                ? h('div', { className: 'dshc-tl-body' }, h('div', { className: 'dshc-sub' },
                    nAll > 0 ? '这档有 ' + nAll + ' 条，当前榜没展到（配额给了更烫的档）。' : '这档还没有。'))
                : h('div', { className: 'dshc-tl-body' },
                    list.slice(0, 10).map((m) => rowOnce(m)),
                    list.length > 10
                      ? h('details', { className: 'dshc-fold dshc-tl-more' },
                          h('summary', null, '另外 ' + (list.length - 10) + ' 条 · 点开'),
                          list.slice(10).map((m) => rowOnce(m)))
                      : null))
          })))
    }

    /**
     * 瀹冩嬁涓嶅噯鐨勪簨锛氫袱鏉¤蹇嗙湅璧锋潵浜掔浉鐭涚浘銆?     * 鍙粰涓夌鍒ゅ喅鈥斺€旂暀杩欐潯锛堝彟涓€鏉′綔搴燂級/ 鐣欓偅鏉?/ 瀹冪悊瑙ｉ敊浜嗭紙涓ゆ潯閮界暀锛夈€?     * 鎸夐挳蹇呴』甯︽柟鍚戝姩璇嶏細銆屽氨鏄繖鏉°€嶈涓嶆竻鏄€岃繖鏉″銆嶈繕鏄€岃繖鏉￠敊銆嶃€?     * 涓嶅仛鎴愯〃鍗曪細杩欓噷瑕佺殑鏄€屽垽涓€鍙ャ€嶏紝涓嶆槸銆屽～涓€寮犺瘝鍗°€嶃€?     */
    function ConflictPanel({ list, loading, error, busyId, onResolve }) {
      const all = Array.isArray(list) ? list : []
      const open = all.filter((c) => c.state === 'open')
      const done = all.filter((c) => c.state !== 'open').slice(0, 3)
      const KEEP_WORD = { a: '留先记的', b: '留后记的', both: '两条都留' }
      if (loading && !all.length) return h('div', { className: 'dshc-sub' }, '读取冲突…')
      if (error && !all.length) return h('div', { className: 'dshc-err' }, error)
      if (!open.length) {
        return h('div', null,
          h('div', { className: 'dshc-sub' }, '没有拿不准的事。'),
          done.length
            ? h('div', { className: 'dshc-sub', style: { marginTop: 6 } },
              '最近处理过：' + done.map((d) => KEEP_WORD[d.resolution] || '已处理').join(' / '))
            : null)
      }
      return h('div', { className: 'dshc-list' },
        open.map((c) => {
          let ev = {}
          try { ev = JSON.parse(c.evidence || '{}') } catch { ev = {} }
          const sim = Number(ev.similarity)
          const meta = [
            ago(c.opened_at),
            Number.isFinite(sim) ? '字面相似 ' + (sim * 100).toFixed(0) + '%' : null,
            c.kind === 'polarity' ? '说法相反' : (c.kind || null),
            c.severity === 'high' ? '它自己有被卡住' : null,
          ].filter(Boolean).join(' · ')
          const side = (which, m, tip) => h('div', {
            key: which, className: 'dshc-item',
          },
            h(Pill, { tone: which === 'a' ? 'warn' : undefined, title: tip },
              which === 'a' ? '先记的' : '后记的'),
            h('div', { className: 't' }, (m && m.text) || '（这条记忆已经找不到了）'),
            m && m.invalid_at ? h('span', { className: 'dshc-sub' }, '已被判失效') : null,
            h(Btn, {
              sm: true, ghost: true, disabled: busyId === c.id,
              title: '这条说的对：点完这条留下，另一条会被标成失效',
              onClick: () => onResolve(c.id, which),
            }, '留这条，废掉另一条'))
          return h(Card, { key: c.id, style: { padding: 12, marginBottom: 10 } },
            h('div', { className: 'dshc-sub', style: { marginBottom: 8 } }, meta),
            side('a', c.a, '更早记下的那句'),
            side('b', c.b, '刚记下的那句'),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 } },
              h(Btn, {
                disabled: busyId === c.id,
                onClick: () => onResolve(c.id, 'both'),
                title: '判它理解错了：两句其实不矛盾，都留着，并在冲突里记一句原因',
              }, busyId === c.id ? '处理中…' : '它理解错了，两条都留'),
              h('span', { className: 'dshc-sub' }, '判完这里就不再是「需处理」了')))
        }))
    }

    function MemoryPage({ aid, view, act, setTab, focus, jump }) {
      const [tick, setTick] = useState(0)
      const [err, setErr] = useState('')
      const [jumpMsg, setJumpMsg] = useState('')
      const [jumpBusy, setJumpBusy] = useState(false)
      const [cf, reloadCf] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/conflicts'), [aid, tick])
      const [cfBusy, setCfBusy] = useState('')
      const [vault] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/vault'), [aid])
      // 鏃ц繘绋嬮噷鐨?vault 杩樹笉浼氳繑鍥?v锛屾鏃朵笉瑕佽Е鍙戝鍑猴紝鍏嶅緱鎶婃柊鏍煎紡瑕嗙洊鍥炲幓
      const vaultFresh = Number((vault.data || {}).v) >= 2
      const vaultRoot = ((vault.data || {}).docs || {}).root || ''
      const openConflicts = (cf.data || []).filter((x) => x.state === 'open')
      useEffect(() => {
        if (focus && focus.focus === 'conflicts') {
          // 鍐茬獊闈㈡澘瑕佺瓑 cf 鎷夊洖鏉ユ墠闀块珮锛氬嚭鐜板氨璺筹紝璺冲畬鍐嶆寜瀹炴祴浣嶇疆鏍′竴娆?''
              scrollToBlockWhenReady('dshc-conflicts')
        }
      }, [focus && focus.at])
      /** keep=a 鐣欏厛璁扮殑 / b 鐣欏悗璁扮殑 / both=銆屽畠鐞嗚В閿欎簡銆嶏紝涓ゆ潯閮界暀骞惰涓€鍙ュ師鍥?*/
      async function resolveConflict(cid, keep) {
        setCfBusy(cid); setErr('')
        try {
          const body = keep === 'both'
            ? { keep, reason: '手动判定：它理解错了（顶多只是说得像，不是同一个命题）' }
            : { keep }
          await act(() => call('POST', '/v1/agents/' + enc(aid) + '/conflicts/' + enc(cid), body, true))
          await reloadCf()
        } catch (e) { setErr(e.message || String(e)) } finally { setCfBusy('') }
      }
      const metricSlice = useMetricSlice(aid, 0, 9)

      // 涓庢椂闂寸嚎 TLRow 鍚岄鏋讹細鍦嗙偣 + 姝ｆ枃 + 鐑害锛涙爣璁拌窡鍙充晶锛屽師璇濆崟鐙竴琛?''
              const memRow = (m, dupFeel) => h('div', { key: m.id },
        h('div', { className: 'dshc-tl-row' },
          h('span', { className: 'dshc-tl-dot', 'data-t': m.type, title: TYPE_LABEL[m.type] || m.type }),
          h('div', { className: 't', title: m.text }, m.text),
          m.source_badge
            ? h('span', {
                className: 'dshc-sub',
                style: { flex: '0 0 auto', fontSize: 11, opacity: 0.75, alignSelf: 'center', marginRight: 4 },
                title: m.source || m.source_badge,
              }, m.source_badge)
            : null,
          m.heat != null ? h('span', { className: 'dshc-tl-strength' }, h(Strength, { m })) : null,
          h('select', {
            className: 'dshc-sel', style: { width: 84, flex: '0 0 auto', alignSelf: 'center' },
            value: m.mark || 'normal',
            title: '这条记忆怎么处理：普通 / 高权重 / 加速遗忘 / 锁定',
            onChange: (e) => mark(m, e.target.value),
          }, Object.entries(MARKS).map(([k, v]) => h('option', { key: k, value: k }, v)))),
        m.source_turn_id
          ? h('div', { style: { margin: '0 0 6px 14px' } }, h(SourceLine, { aid, turnId: m.source_turn_id }))
          : null,
        m.feel && m.feel.text
          ? h('div', {
            className: 'dshc-sub',
            style: { margin: '0 0 6px 14px', fontSize: 12.5, opacity: dupFeel ? 0.5 : 0.8 },
            title: '出生那一刻自己写下的感觉：' + (m.feel.at || ''),
          }, dupFeel ? '当时的感觉：同上一条' : '当时的感觉：' + m.feel.text)
          : null)

      async function mark(m, value) {
        await act(() => call('PATCH', '/v1/memory/' + enc(m.id), { mark: value }, true))
        setTick((t) => t + 1)
      }
      // 只留这一个键：跳到今天的日记文件（日记按月一个文件）
      async function jumpToday() {
        setJumpBusy(true); setJumpMsg('整理可读版…')
        try {
          const now = new Date()
          const p2 = (n) => String(n).padStart(2, '0')
          const y = now.getFullYear()
          const m = p2(now.getMonth() + 1)
          const info = await call('GET', '/v1/agents/' + enc(aid) + '/vault/root')
          // 鏃ц繘绋嬩細鎶?/vault/root 褰?/vault 澶勭悊锛岄偅灏变粠 docs.root 閲屾嬁
          let root = info.root || (info.docs && info.docs.root) || ''
          if (Number(info.v) >= 2) {
            try {
              const ex = await call('POST', '/v1/agents/' + enc(aid) + '/vault/export', {}, true)
              root = ex.root || root
          } catch (e) { /* 刷新失败也要能进文件夹 */ }
          }
          const rel = '日记/' + y + '/' + y + '-' + m + '.md'
          const r = await call('POST', '/v1/agents/' + enc(aid) + '/vault/open', { path: root + '/' + rel }, true)
          if (r.ok) { setJumpMsg('已打开 ' + rel); return }
          const r2 = await call('POST', '/v1/agents/' + enc(aid) + '/vault/open', { path: root + '/日记/' + y }, true)
          setJumpMsg(r2.ok ? '这个月还没写日记，已打开 ' + y + ' 年文件夹' : r.reason)
        } catch (e) { setJumpMsg(e.message || String(e)) } finally { setJumpBusy(false) }
      }

      return h('div', null,
        h(Sec, { title: '鱼格' },
          h(VaultCard, { aid, view, fresh: vaultFresh })),

        h(Sec, { title: '昨天的日记', desc: '每天 23:00 自动写；当时不在（关机 / 休眠）会在下次打开时补写，补的标「补写」。第一人称，只读。' },
          h(DiaryView, {
            aid,
            day: yesterdayStr(),
            extra: h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h(Btn, { disabled: jumpBusy, onClick: jumpToday }, jumpBusy ? '打开中…' : '打开今天的日记文件'),
              jumpMsg ? h('span', { className: 'dshc-note' }, jumpMsg) : null),
          })),

        h(Sec, { title: '时间线', desc: '最近 5 天它记住了什么，按天排；点开某天看细节。' },
          h(TimelineView, { aid })),

        h(Sec, { title: '时态', desc: '它怎么区分「那时候」和「现在」：哪些旧说法被收起来了，哪些旧判断会带上日期。只读。' },
          h(TensePanel, { aid })),

        h(Sec, { title: view === 'user' ? '它记得的事' : '记忆（FTS / decay / tiers）', desc: view === 'user' ? '最清楚的那些，按热度分档；点开某档看细节与原话。' : '列表 + 分层 + 索引；检索与衰减的细节在公式里。' },
          view === 'tech' ? h(Tech, null, 'recall = FTS5 trigram（≥3 字子串）；短问句（≤6 字）走 LIKE 兜底\nweight = w0·e^{-λ·days}（decay@v1，λ 默认 0.02）\n分层：T0 桌面 / T1 事实 / T2 纪要(L0规则·L1精修·L2簇修) / T3 日记 / T4 原文\n写入：extract · episode · consolidate · remember；改口默认 conflict（memory.write.flip_policy）\n习惯：habit.* 抬重要度 + S1 冷层窄穿透（memory.retrieve.habit_cold）\n观测：GET /memory-health · /retrieval-stats · /consolidation\n键：memory.inject.pool · memory.episode.distill* · memory.write.flip_policy · memory.retrieve.habit_cold · memory.diary.prefer_cluster') : null,
          h(TopMemory, { aid, tick, row: memRow, act, onWrote: () => setTick((t) => t + 1) }),
          err ? h('div', { className: 'dshc-err', style: { marginTop: 6 } }, err) : null),

        h('div', { id: 'dshc-conflicts' },
          h(Sec, {
            title: '它拿不准的事',
            desc: '两条记忆看起来互相矛盾。点某条下面的「留这条，废掉另一条」，就是认定这条对、另一条作废；两句其实不矛盾（只是说得像）就点「它理解错了」，两条都留。判完就不挂在「需处理」了。',
          },
            h(ConflictPanel, {
              list: cf.data, loading: cf.loading, error: cf.error,
              busyId: cfBusy, onResolve: resolveConflict,
            }))),

        h(Sec, { techOnly: true, title: '验收指标（9 条 · 地基附录 E）', desc: '有动作的给「去处理」；否则标仅观察。' },
          h(Card, null, h(MetricList, {
            from: 0, to: 9, view, setTab,
            catalog: metricSlice.catalog, values: metricSlice.values,
          }))),

        h(AlgoStrip, { aid, slots: ALGO_BY_TAB.memory, setTab }),

        h(Sec, { techOnly: true, title: '模块关系', desc: '记忆与其他模块的边（6 号）；技术视图可看增益。' },
          h(Card, null, h(EdgeGraphPanel, { aid }))))
    }

    /* ============================================================ persona */

    function useList(aid, endpoint, deps) {
      const [tick, setTick] = useState(0)
      const [s, reload] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + endpoint), [aid, tick, ...(deps || [])])
      return [s, reload, () => setTick((t) => t + 1)]
    }

    function PersonaPage({ aid, view, act, setTab }) {
      const [s, reload, bump] = useList(aid, '/persona')
      const [vals, , bumpVals] = useList(aid, '/values')
      const [world, , bumpWorld] = useList(aid, '/worldview')
      const [life, , bumpLife] = useList(aid, '/lifeview')
      const [prefs, , bumpPrefs] = useList(aid, '/preferences')
      const [rope] = useList(aid, '/persona/rope')
      const [judge, , bumpJudge] = useList(aid, '/persona/judge')
      const [taboos, , bumpTaboos] = useList(aid, '/taboos')
      const [drift] = useList(aid, '/persona/drift')
      const [sv, reloadSv] = useList(aid, '/persona/selfview')
      const [form, setForm] = useState({ tone: '', address: '', catch: '', banned: '', card: '' })
      const [err, setErr] = useState('')
      const [growing, setGrowing] = useState(false)
      const [growingW, setGrowingW] = useState(false)
      const [growingL, setGrowingL] = useState(false)
      const inited = useRef(false)
      const tries = useRef(0)
      const metricSlice = useMetricSlice(aid, 9, 17)

      const rows = s.data || []
      const get = (p) => { const r = rows.find((x) => x.path === p); return r ? r.value : '' }
      const svd = sv.data || {}
      // 鑰佸涓绘病鏈?/persona/selfview 鏃?GET 浼氬洖钀藉埌楸兼牸鏁扮粍锛氭槑纭彁绀鸿閲嶅惎锛岃€屼笉鏄浣滃潖浜?''
              const svReady = !!svd && !Array.isArray(svd) && svd.params !== undefined
      const params = svd.params || {}
      const limits = Object.assign({}, DEFAULT_LIMITS, params.limits || {})
      const styleLimits = Object.assign({}, DEFAULT_STYLE_LIMITS, (params.limits && params.limits.style) || {})
      const counts = (svd.now && svd.now.counts) || {}
      const lim = (p) => Number(styleLimits[p] || DEFAULT_STYLE_LIMITS[p] || 200)

      useEffect(() => {
        if (inited.current || !rows.length) return
        inited.current = true
        setForm({
          tone: String(get('style.tone') || ''), address: String(get('style.address') || ''),
          catch: String(get('style.catchphrase') || ''), banned: String(get('style.banned') || ''),
          card: String(get('style.card') || ''),
        })
      }, [rows.length])

      // 自述是异步生成的：正在想 / 过期时轮询几次，别让页面一直空着
      useEffect(() => {
        const st = svd.status
        if (st !== 'generating' && st !== 'stale') { tries.current = 0; return }
        if (tries.current >= 6) return
        tries.current++
        const t = setTimeout(() => reloadSv(), 2600)
        return () => clearTimeout(t)
      }, [svd.status, svd.updated_at, reloadSv])

      // 五条轴会随聊天一点点漂：页面开着就隔一会儿取一次，
      // 鍝潯杩囦簡 60/40锛屽瓧姣嶈嚜宸卞啋鍑烘潵锛堜笉鐢?F5锛夛紱鍒囧洖绐楀彛鏃朵篃绔嬪埢瀵逛竴娆°€?''
              useEffect(() => {
        const kick = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          reloadSv()
        }
        const iv = setInterval(kick, 12000)
        window.addEventListener('focus', kick)
        document.addEventListener('visibilitychange', kick)
        return () => {
          clearInterval(iv)
          window.removeEventListener('focus', kick)
          document.removeEventListener('visibilitychange', kick)
        }
      }, [reloadSv])

      async function save(path, value) {
        setErr('')
        try {
          await act(() => call('PUT', '/v1/agents/' + enc(aid) + '/persona/' + enc(path), { value }, true))
          bump()
        } catch (e) { setErr(e.message) }
      }

      async function grow() {
        if (growing) return
        setGrowing(true); setErr('')
        try {
          await act(() => call('POST', '/v1/agents/' + enc(aid) + '/values/grow', {}, true))
          bumpVals()
        } catch (e) { setErr(e.message) } finally { setGrowing(false) }
      }

      async function growWorld() {
        if (growingW) return
        setGrowingW(true); setErr('')
        try {
          await act(() => call('POST', '/v1/agents/' + enc(aid) + '/worldview/grow', {}, true))
          bumpWorld()
        } catch (e) { setErr(e.message) } finally { setGrowingW(false) }
      }

      async function growLife() {
        if (growingL) return
        setGrowingL(true); setErr('')
        try {
          await act(() => call('POST', '/v1/agents/' + enc(aid) + '/lifeview/grow', {}, true))
          bumpLife()
        } catch (e) { setErr(e.message) } finally { setGrowingL(false) }
      }

      function beliefNodes(rows) {
        return (rows || []).map((r) => {
          const ev = (r.evidence || []).length
            ? h('details', { style: { marginTop: 4 } },
              h('summary', { className: 'dshc-fold' }, '证据 ' + r.evidence.length + ' 条'),
              h('div', { className: 'dshc-list' }, r.evidence.map((e, i) => h('div', { key: i, className: 'dshc-item' },
                h(Pill, null, e.kind || '证据'),
                h('div', { className: 't' }, e.text || '')))))
            : null
          const lean = Number(r.weight) >= 0.5
          return h('div', { key: r.key, style: { padding: '6px 0', borderBottom: '1px dashed var(--line)' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('b', { style: { fontSize: 12.5 } }, r.label || r.key),
              r.habit ? h(Pill, { on: true }, '惯习') : null,
              h('div', { className: 'dshc-spacer' }),
              h(Bar, { value: Number(r.weight) }),
              h('span', { className: 'm dshc-mono' }, Number(r.weight).toFixed(2))),
            h('div', { className: 'dshc-sub' }, lean ? (r.hint || '') : (r.low || r.hint || '')),
            ev)
        })
      }

      /**
       * 銆屽枩娆?/ 璁ㄥ帉銆嶆槸瀹冭嚜宸遍暱鐨勶細鍚庡彴姣?10 鍒嗛挓鐪嬩竴娆¤涓嶈闀匡紙鏈夋柊鏉愭枡鎵嶉暱锛夛紝
       * 涓嶉渶瑕佷汉鐐广€傝繖閲屽彧璐熻矗鎶婄姸鎬佽娓呮鈥斺€旈暱浜嗗嚑鏉°€佸摢鍑犳潯銆佷笂涓€娆℃槸浠€涔堟椂鍊欍€?       */
      const prefRows = prefs.data || []
      const autoPrefs = prefRows.filter((r) => r.origin === 'auto')
      const manualPrefs = prefRows.filter((r) => r.origin !== 'auto')
      const lastAuto = autoPrefs.reduce((acc, r) => (!acc || String(r.created_at) > String(acc.created_at) ? r : acc), null)
      const grownAt = lastAuto ? ago(lastAuto.created_at) : null

      const valueNodes = (vals.data || []).map((r) => {
        const ev = (r.evidence || []).length
          ? h('details', { style: { marginTop: 4 } },
            h('summary', { className: 'dshc-fold' },
              '它是怎么长出来的（' + r.evidence.length + ' 条证据）'),
            h('div', { className: 'dshc-list' }, r.evidence.map((e, i) => h('div', { key: i, className: 'dshc-item' },
              h(Pill, null, VALUE_SRC[e.kind] || '证据'),
              h('div', { className: 't' }, e.text || '')))))
          : null
        return h('div', { key: r.key, style: { padding: '6px 0', borderBottom: '1px dashed var(--line)' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('b', { style: { fontSize: 12.5 } }, r.label || r.key),
            r.habit ? h(Pill, { on: true }, '惯习') : null,
            h('div', { className: 'dshc-spacer' }),
            h(Bar, { value: Number(r.weight) }),
            h('span', { className: 'm dshc-mono' }, Number(r.weight).toFixed(2))),
          r.hint ? h('div', { className: 'dshc-sub' }, r.hint) : null,
          ev)
      })
      const narrative = String(svd.text || '')
      const budget = (params.limits && params.limits.budget) || null
      const axesNow = (svd.now && svd.now.axes) || []
      const axesRows = axesNow.length ? axesNow : AXES.map(([k, label]) => {
        const row = rows.find((x) => x.path === 'axis.' + k)
        return { key: k, label, value: Number(row ? row.value : 0) || 0, origin: row ? row.origin : 'auto' }
      })

      const modeLabel = ({ off: '关（只按事件）', shadow: '只算不用（只更新数字）', on: '开（MBTI 生效）' })[params.axes_mode] || String(params.axes_mode || 'on')
      // 楸兼牸澶ф锛氬彧鍋氬洓瀛楁瘝鎶曞奖銆傚亸杩?60/40 鎵嶅啓瀛楁瘝锛屾病鍒板氨鐣欑┖浣嶏紙寰呰緭鍏ワ級
      // 闃堝€兼寜銆岄〉闈笂鏄剧ず鍑烘潵鐨勪袱浣嶅皬鏁般€嶅垽锛?.598 鍙宠竟鍐欑潃 0.60锛屽氨璇ユ湁 E锛岃€屼笉鏄棌鐫€銆?''
      // 涓嶄緷璧栧涓荤畻濂界殑 show锛堝涓绘病閲嶅惎鏃惰繕鏄€佽鍒欙級锛屽彧鍊熷畠鐨勫瓧姣嶆柟鍚戯紱鍏朵綑鏈湴绠椼€?''
              const POLES = { ei: ['I', 'E'], sn: ['S', 'N'], tf: ['F', 'T'], jp: ['P', 'J'] }
      const axVal = {}
      for (const t of axesRows) axVal[t.key] = Number(t.value) || 0
      const serverLetters = (svd.now && svd.now.type && Array.isArray(svd.now.type.letters)) ? svd.now.type.letters : []
      const letters = ['ei', 'sn', 'tf', 'jp'].map((k) => {
        const raw = axVal[k] != null && Number.isFinite(Number(axVal[k])) ? Number(axVal[k]) : 0.5
        const shown = Math.round(raw * 100) / 100
        const d = shown - 0.5
        const srv = serverLetters.find((l) => l.axis === k)
        return {
          k, show: Math.abs(d) >= 0.1 - 1e-9,
          letter: d > 0 ? POLES[k][1] : d < 0 ? POLES[k][0] : ((srv && srv.letter) || POLES[k][1]),
          pct: Math.round(shown * 100),
        }
      })
      return h('div', null,
        // 鈶?缃《锛氶奔鏍?= MBTI 鍥涜酱 + 鏁忔劅杞达紙鍏堢湅杩欎釜锛?''
        h(Sec, { title: '记忆仓库' },
          h(Card, null,
            h('div', { className: 'dshc-mbti' },
              h('div', { className: 'dshc-mbti-sheen' }),
              h('div', { className: 'dshc-mbti-tiles' }, letters.map((x, i) => h('span', {
                key: x.k, className: 'dshc-mbti-tile' + (x.show ? '' : ' dshc-mbti-gap'),
                'data-near': x.show ? undefined : (x.pct >= 58 ? '1' : undefined),
                title: x.show ? x.letter + ' · ' + x.pct + '%' : '还没偏过 60/40（' + x.pct + '%），先留空位',
                style: { '--k': (i * 0.45) + 's' },
              }, x.show ? x.letter : '')))),
            axesRows.map((t) => {
              const pair = AXES.find(([k]) => k === t.key) || []
              const hi = pair[2] || ''
              const lo = pair[3] || ''
              const ab = POLES[t.key]
              return h(Row, { key: t.key, label: ab ? ab[0] + '/' + ab[1] : (pair[1] || t.label) },
                h('span', { className: 'dshc-sub', style: { minWidth: 40, textAlign: 'right' } }, lo),
                h(Bar, { value: t.value }),
                h('span', { className: 'dshc-sub', style: { minWidth: 40 } }, hi),
                h('span', { className: 'm dshc-mono' }, Number(t.value).toFixed(2)))
            }),
            // 涓ゆ睜鎷夊姏锛氬乏鍙冲悇涓€鏍癸紝璋侀暱璋佸湪璧紱鍑€鍔涘埌 0.30 鎵嶅彲鑳芥尓涓€姝?''
              (rope && rope.axes && rope.axes.length)
              ? h('div', { style: { marginTop: 12, borderTop: '1px dashed var(--line)', paddingTop: 10 } },
                h('div', { className: 'dshc-note', style: { marginBottom: 6 } },
                  '两池拉力（7 天半衰期）· 净力 ≥0.30、且赢的一边 ≥3 条，才挪一步（≤0.05）'),
                rope.axes.filter((x) => ['ei', 'sn', 'tf', 'jp'].includes(x.axis)).map((x) => {
                  const pos = Math.max(0, Number(x.pos) || 0)
                  const neg = Math.max(0, Number(x.neg) || 0)
                  const total = Math.max(0.001, pos + neg)
                  const POL = { ei: ['I', 'E'], sn: ['S', 'N'], tf: ['F', 'T'], jp: ['P', 'J'] }[x.axis] || ['-', '+']
                  const f = Number(x.force) || 0
                  const col = f > 0 ? 'var(--ok)' : f < 0 ? 'var(--warn)' : 'var(--muted)'
                  return h('div', { key: x.axis, style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 } },
                    h('span', { className: 'dshc-sub', style: { width: 12, textAlign: 'right' } }, POL[0]),
                    h('div', { style: { flex: 1, height: 6, borderRadius: 3, background: 'var(--line)', display: 'flex', overflow: 'hidden' } },
                      h('div', { style: { width: (neg / total * 100) + '%', background: 'color-mix(in srgb, var(--warn) 65%, transparent)' } }),
                      h('div', { style: { width: (pos / total * 100) + '%', background: 'color-mix(in srgb, var(--ok) 65%, transparent)' } })),
                    h('span', { className: 'dshc-sub', style: { width: 12 } }, POL[1]),
                    h('span', { className: 'm dshc-mono', style: { width: 52, textAlign: 'right', color: col } },
                      (f > 0 ? '+' : '') + f.toFixed(2)),
                    h('span', { className: 'dshc-sub dshc-mono', style: { width: 60, textAlign: 'right' } },
                      String(x.pos_n || 0) + '/' + String(x.neg_n || 0)))
                }),
                rope.scan_at ? h('div', { className: 'dshc-note dshc-mono', style: { marginTop: 6 } },
                  '上次扫：' + String(rope.scan_at).slice(0, 16).replace('T', ' ')) : null,
                h('div', { className: 'dshc-note', style: { marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                  h('span', null,
                    '第二判（模型判 + 原文核对）：待判 ' + (judge && judge.pending != null ? judge.pending : '—')
                    + ' · 今日 ' + (judge && judge.today != null ? judge.today : '—') + '/' + (judge && judge.cap ? judge.cap : '—')),
                  h(Btn, {
                    sm: true, ghost: true,
                    onClick: async () => {
                      try {
                        await call('POST', '/v1/agents/' + enc(aid) + '/persona/judge', { limit: 12 }, true)
                        bumpJudge()
                      } catch (e) { setErr(String((e && e.message) || e)) }
                    },
                  }, '跑一批')),
                h('div', { className: 'dshc-note dshc-mono', style: { marginTop: 4 } },
                  (sv && sv.now && sv.now.anchor) ? sv.now.anchor : ''))
              : null,
            view === 'tech' ? h('div', { className: 'dshc-note' }, '当前挡位 ' + modeLabel) : null)),

        // 鈶?瀹冪殑鑷堪锛氱涓€浜虹О锛屾斁鍦ㄩ奔鏍兼涓嬮潰
        h(Sec, { title: '它的自述' },
          h(Card, null,
            narrative
              ? h('div', { className: 'dshc-answer' }, h(Typer, { text: narrative }))
              : h('div', { className: 'dshc-sub' },
                !svReady ? '入口还没热：宿主还没加载新接口，重启 DSH 后这里会出现它自己的第一人称自述。'
                  : svd.status === 'generating' ? '它正在把这些材料理一遍，几秒后回来…'
                    : (sv.error ? '读取失败：' + sv.error : '它还没理出头绪，过一阵会自己长出来。')),
            svd.updated_at
              ? h('div', { className: 'dshc-note dshc-mono' },
                '写于 ' + String(svd.updated_at).slice(0, 16).replace('T', ' ')
                + ' · 来源 ' + (svd.source === 'model' ? '模型' : '规则')
                + (view === 'tech'
                  ? ' · 每 ' + (svd.interval_days || 7) + ' 天 · 输入 ' + (params.prompt_chars || 0) + ' 字（约 '
                    + (params.prompt_tokens || 0) + ' token）· 输出 ' + Array.from(narrative).length + ' 字'
                  : ''))
              : null,
            err ? h('div', { className: 'dshc-err' }, err) : null)),

        // 鈶?鎶€鏈〉锛氳繖娈佃嚜杩版槸鎬庝箞鏉ョ殑
        h(Sec, {
          techOnly: true,
          title: '这段自述是怎么来的',
          desc: '来源、条数、权重与挑选规则。权重只影响叙述侧重，不改数值。',
        },
          h(Card, null,
            h('div', { className: 'dshc-list' }, (svd.sources || []).map((x) => h('div', { key: x.key, className: 'dshc-item' },
              h(Pill, { on: Number(x.weight) >= 0.5 }, x.weight == null ? '背景' : 'w ' + Number(x.weight).toFixed(2)),
              h('div', { className: 't' },
                h('div', null, x.label + ' · ' + x.count + ' 条'),
                h('div', { className: 'dshc-sub' }, x.rule || ''))))),
            svd.facts
              ? h('details', { style: { marginTop: 8 } },
                h('summary', { className: 'dshc-fold' },
                  '它拿到的原始素材（' + Array.from(svd.facts).length + ' 字）'),
                h(Tech, null, svd.facts))
              : null)),

        // 鈶?鎶€鏈〉锛氶奔鏍煎弬鏁颁笌棰勭畻
        h(Sec, { techOnly: true, title: '鱼格参数与预算', desc: '手写字段字数、关系模式、语气档、注入预算；MBTI 投影在上面那栏。' },
          h(Card, null,
            (params.style || []).map((x) => h(Row, {
              key: x.path, label: x.path.replace('style.', ''), value: x.chars + ' / ' + x.limit + ' 字',
            })),
            h(Row, {
              label: '关系模式',
              value: params.relation
                ? (params.relation.mode === 'I-Thou' ? '我-你' : '我-它') + ' · 分寸 ' + Math.round((params.relation.disclosure || 0) * 100) + '%'
                  + (params.relation.owner ? ' · 对「' + params.relation.owner.name + '」' : '')
                : '—',
            }),
            h(Row, { label: '语气档', value: params.tone ? params.tone.label + ' · ' + params.tone.desc : '—' }),
            h(Row, {
              label: '价值张力',
              value: (params.tension && params.tension.length) ? params.tension.map((x) => x.pair).join('；') : '无',
            }),
            h(Row, {
              label: '上次说话',
              value: params.relation && params.relation.last_seen_days != null ? params.relation.last_seen_days + ' 天前' : '—',
            }),
            h(Row, { label: '注入最坏情况', value: budget ? budget.chars + ' 字 ≈ ' + budget.tokens + ' token' : '—' }),            h(Row, { label: '自述缓存', value: (params.ttl_days || 7) + ' 天' }),
            h(Row, { label: '模型', value: params.model ? params.model.primary + ' / ' + params.model.adapter : '—' }),
            h(Row, {
              label: '素材条数',
              value: '记忆 ' + (counts.memory || 0) + ' · 价值观 ' + (counts.values || 0) + ' · 关系 ' + (counts.relations || 0)
                + ' · 禁忌 ' + (counts.taboos || 0),
            }))),

        // 鈶?浣犳兂璁╁畠锛氭墜鍐欏尯锛堟瘡杞敞鍏ユ彁绀鸿瘝锛屽洜姝ゆ湁瀛楁暟涓婇檺锛?''
              h(Sec, {
          title: view === 'user' ? '你想让它' : '手写区（每轮注入提示词）',
          desc: view === 'tech' ? '说话方式归你管；这些字每轮都进提示词，所以每个字段都有上限。' : undefined,
        },
          h(Card, null,
            h(Row, { label: '语气' },
              h(Input, {
                style: { maxWidth: 220 }, value: form.tone, maxLength: lim('style.tone'),
                placeholder: '比如：话少、直接、不哄人',
                onChange: (e) => setForm({ ...form, tone: e.target.value }),
                onBlur: () => save('style.tone', form.tone),
              }),
              h(CharCount, { value: form.tone, limit: lim('style.tone') })),
            h(Row, { label: '称呼' },
              h(Input, {
                style: { maxWidth: 180 }, value: form.address, maxLength: lim('style.address'),
                placeholder: '它怎么叫你',
                onChange: (e) => setForm({ ...form, address: e.target.value }),
                onBlur: () => save('style.address', form.address),
              }),
              h(CharCount, { value: form.address, limit: lim('style.address') })),
            h(Row, { label: '口头禅' },
              h(Input, {
                style: { maxWidth: 220 }, value: form.catch, maxLength: lim('style.catchphrase'),
                placeholder: '比如「我记着呢」',
                onChange: (e) => setForm({ ...form, catch: e.target.value }),
                onBlur: () => save('style.catchphrase', form.catch),
              }),
              h(CharCount, { value: form.catch, limit: lim('style.catchphrase') })),
            h(Row, { label: '禁用词' },
              h(Input, {
                style: { maxWidth: 280 }, value: form.banned, maxLength: lim('style.banned'),
                placeholder: '逗号分隔，比如：随便、无所谓',
                onChange: (e) => setForm({ ...form, banned: e.target.value }),
                onBlur: () => save('style.banned', form.banned),
              }),
              h(CharCount, { value: form.banned, limit: lim('style.banned') })),
            h('div', { style: { marginTop: 12 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
                h('span', { className: 'dshc-q' }, '鱼格卡 · 自由发挥'),
                h('div', { className: 'dshc-spacer' }),
                h(CharCount, { value: form.card, limit: lim('style.card') })),
              h(TextArea, {
                rows: 4, value: form.card, maxLength: lim('style.card'),
                placeholder: '随便写：你对什么没耐心、你怕什么、你怎么看关系、哪句话像你。',
                onChange: (e) => setForm({ ...form, card: e.target.value }),
                onBlur: () => save('style.card', form.card),
              }),
              view === 'tech' ? h('div', { className: 'dshc-note' },
                '权重 ' + ((params.weights && params.weights.card != null) ? params.weights.card : 0.25)
                + '：影响它怎么理解自己，但压不过五条性格。'
                + (budget ? ' · 五个字段合计上限 ' + budget.chars + ' 字（≈' + budget.tokens + ' token / 轮）。' : '')) : null),
            err ? h('div', { className: 'dshc-err' }, err) : null)),

        // 鈶?浠峰€艰锛氱敱涓夎璐︽湰鐨勫懡棰樻姌绠楀嚭鏉ワ紙涓嶆槸浜哄～鐨勶紝涔熶笉鏄瘝琛ㄦ壂鍑烘潵鐨勶級
        h(Sec, {
          title: view === 'user' ? '它的价值观' : '价值观（命题折算）',
          desc: view === 'user'
            ? '不是填进去的；它自己认下的事、和你的关系、一次次的经历，折算成这十个维。'
            : '十维由三观命题折算（foldDims）：没有命题时各 0.10；三组张力互相压上限；手写只进命题，不直接改权重。',
        },
          h(Card, null,
            !(vals.data || []).length
              ? h('div', { className: 'dshc-sub' }, '还没有价值观命题；聊几句、记几条，它会自己认下一些事。')
              : h('div', null,
                h(ValuesRadar, { rows: vals.data || [] }),
                h(TensionBlock, { rows: vals.data || [] }),
                h('details', { className: 'dshc-fold', style: { marginTop: 12 } },
                  h('summary', null, '全部十维（' + (vals.data || []).length + ' 项 · 点开看来源）'),
                  h('div', { className: 'dshc-list' }, valueNodes))),
            h('div', { className: 'dshc-note' }, '改它只能靠新的经历或直接说出「我更看重…」；手写区只影响说话方式。'))),

        // 鈶 涓栫晫瑙傦紙Primals / WAS / Social Axioms锛?''
              h(Sec, {
          title: view === 'user' ? '它眼中的世界' : '世界观（自己长出来的）',
          desc: view === 'user'
            ? '世界安不安全、公不公正、人可不可信——从经历里慢慢偏出来，不是填的。'
            : '八维初值 0.50；Primals(Safe/Enticing/Alive) + WAS + Social Axioms + 知可修订；不要求 Σ=1。',
        },
          h(Card, null,
            !(world.data || []).length
              ? h('div', { className: 'dshc-sub' }, '还没有世界观偏向；多经历、多冲突与关系，它会慢慢立住。')
              : h('div', null,
                h(ValuesRadar, { rows: world.data || [], size: 150 }),
                h('details', { className: 'dshc-fold', style: { marginTop: 12 } },
                  h('summary', null, '全部八维（' + (world.data || []).length + ' 项）'),
                  h('div', { className: 'dshc-list' }, beliefNodes(world.data || [])))),
            h('div', { className: 'dshc-note' }, '世界观比价值观更稳：惯习门槛更高，大冲击才大幅偏离中线。'))),

        // ⑤c 人生观（MEMS / MLQ / 角色目的论）
        (() => {
          const lifePayload = life.data || {}
          const lifeRows = Array.isArray(lifePayload) ? lifePayload : (lifePayload.items || [])
          const stance = (!Array.isArray(lifePayload) && lifePayload.derived && lifePayload.derived.stance) || null
          return h(Sec, {
            title: view === 'user' ? '它觉得自己为何在' : '人生观（自己长出来的）',
            desc: view === 'user'
              ? '连贯、朝向、重要、求索、生长、与人成全、时间视野——再凝成一句目的。'
              : 'MEMS 三元 + MLQ 求索 + Ryff 成长 + 交融 + 远景；派生 presence 与 telos。',
          },
            h(Card, null,
              stance ? h('div', { style: { marginBottom: 10 } },
                h('div', { style: { fontSize: 13, fontWeight: 600, lineHeight: 1.5 } }, stance.telos || ''),
                stance.attitude ? h('div', { className: 'dshc-sub', style: { marginTop: 4 } }, stance.attitude) : null,
                lifePayload.derived && lifePayload.derived.presence != null
                  ? h('div', { className: 'dshc-note' }, '意义在场 presence=' + Number(lifePayload.derived.presence).toFixed(2))
                  : null)
                : null,
              !lifeRows.length
                ? h('div', { className: 'dshc-sub' }, '还没有人生观命题；日记、志向与关系会把它慢慢写清楚。')
                : h('div', null,
                  h(ValuesRadar, { rows: lifeRows, size: 150 }),
                  h('details', { className: 'dshc-fold', style: { marginTop: 12 } },
                    h('summary', null, '全部七维（' + lifeRows.length + ' 项）'),
                    h('div', { className: 'dshc-list' }, beliefNodes(lifeRows)))),
              h('div', { className: 'dshc-note' }, '默认角色目的：扩展所陪伴之人的能动——不是假装独立灵魂目的。')))
        })(),

        // 鈶?鍥哄畾鍋忓ソ锛堣嚜宸遍暱鐨?+ 鎵嬪啓鐨勶紝鍚屼竴绉嶈锛涜嚜宸遍暱鐨勫垹涓嶆帀锛?''
              h(Sec, {
          title: view === 'user' ? '它记住的喜欢和讨厌' : '固定偏好',
          desc: '标签 + 厌恶度 0–1。自己长出来的删不掉；手写的那条可以收回。',
        },
          h(Card, null,
            (prefs.data || []).length === 0
              ? h('div', { className: 'dshc-sub' }, '还没有固定偏好。它会在后台慢慢长出喜欢 / 讨厌，也可以现在写一条。')
              : prefRows.map((r) => h(PrefRow, { key: r.id, aid, act, r, onDone: bumpPrefs })),
            autoPrefs.length
              ? h('div', { className: 'dshc-note' },
                '它自己长出来的 ' + autoPrefs.length + ' 条'
                + (grownAt ? ' · 上次 ' + grownAt : '')
                + ' · 有新材料时后台自动补，最长 30 分钟一次')
              : h('div', { className: 'dshc-note' }, '还没自己长过：等它记住几件新事，后台会自己补一批（不用点）。'),
            h(PreferenceForm, { aid, act, onDone: bumpPrefs, limit: limits.preferenceTag || DEFAULT_LIMITS.preferenceTag }))),

        // 鈶?绂佸繉
        h(Sec, { title: view === 'user' ? '绝对不能碰的线' : '禁忌', desc: 'root 一票否决；soft 仍会被 G1 记下来。禁忌违反率目标 = 0。' },
          h(Card, null,
            (taboos.data || []).length === 0 ? h('div', { className: 'dshc-sub' }, '还没有禁忌条目。')
              : (taboos.data || []).map((r) => h(Row, { key: r.id, label: r.text },
                h(Pill, { tone: r.level === 'root' ? 'bad' : undefined }, r.level),
                h(Pill, null, r.origin))),
            h(TabooForm, { aid, act, onDone: bumpTaboos, limit: limits.tabooText || DEFAULT_LIMITS.tabooText }))),

        view === 'tech' ? h(Tech, null, 'MBTI 四轴 ∈ [0,1]（ei / sn / tf / jp）+ sensitivity；手写 origin=manual 优先于 auto\ndrift = Σ w_i·|auto_i - manual_i|（鱼格 §自动区）\n价值观 Σweight = 1；关系 closeness/trust/dependence ∈ [0,1]') : null,

        // 鈶?婕傜Щ
        h(Sec, { title: view === 'user' ? '它最近有没有变' : '漂移', desc: '一致性、手写与自动的比例、禁忌违反次数。' },
          h(Card, null, (() => {
            const d = drift.data || {}
            return h('div', null,
              h(Row, { label: '一致性', value: d.consistency != null ? Number(d.consistency).toFixed(3) : '—' }),
              h(Row, { label: '手写 / 自动', value: (d.manual || 0) + ' / ' + (d.auto || 0) }),
              h(Row, { label: '禁忌违反', value: String(d.taboo_violation ?? 0) }))
          })())),

        // 鈶?楠屾敹鎸囨爣
        h(Sec, { techOnly: true, title: '验收指标（8 条 · 地基附录 E）', desc: '同一性盲测可在验收页一键跑。' },
          h(Card, null, h(MetricList, {
            from: 9, to: 17, view, setTab,
            catalog: metricSlice.catalog, values: metricSlice.values,
          }))),

        // 鈶?鍏崇郴杈?''
        h(Sec, { title: view === 'user' ? '性格都跟什么有关' : '模块关系边', desc: '鱼格 ↔ 记忆 / 情绪 / 关系（6 号 12 边）。' },
          h(Card, null, h(EdgeGraphPanel, { aid }))))
    }

