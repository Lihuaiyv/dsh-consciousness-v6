    /* =========================================================== relation */

    function RelationPage({ aid, view, act }) {
      const [tick, setTick] = useState(0)
      const [relView, setRelView] = useState('graph')
      const [justAdded, setJustAdded] = useState(null)
      const bump = () => setTick((t) => t + 1)
      const [ps] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/persons'), [aid, tick])
      const [ev] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/relations/events?limit=12'), [aid, tick])
      const [mt] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/mentions?state=unresolved'), [aid, tick])
      const persons = Array.isArray(ps.data) ? ps.data : []
      const events = (ev.data && ev.data.items) || []
      const mentions = ((mt.data && mt.data.items) || [])
        // 鏃╂湡銆屽紩鍙烽噷鍍忎汉鍚嶅氨褰撴彁鍙娿€嶇殑璇娊宸蹭笅绾匡紱鏃у簱閲岄偅鎵规槸 confidence 0.5 鐨?name 绫?        .filter((m) => !(m.how === 'name' && Number(m.confidence || 0) <= 0.5))
        .slice(0, 20)
      const groups = ['owner', 'acquaintance', 'stranger']
        .map((tier) => [tier, persons.filter((p) => p.tier === tier)])
        .filter(([, arr]) => arr.length)
      return h('div', null,
        h(Sec, {
          title: '关系图',
          desc: '主人 / 熟人 / 生人 分层；线越粗越亲近；具体的人看「列表」。',
          right: h('div', { className: 'dshc-form' },
            h(Btn, { primary: relView === 'graph', onClick: () => setRelView('graph') }, '关系图'),
            h(Btn, { primary: relView === 'list', onClick: () => setRelView('list') }, '列表')),
        },
          h(Card, null,
            ps.error ? h(LoadErr, { error: ps.error, retry: bump }) : null,
            persons.length === 0 && ps.loading ? h(Empty, null, '读取人物账本…') : null,
            relView === 'graph'
              ? h('div', null, h(PersonMap, { aid, fallback: [], seed: tick, onChanged: bump }))
              : h('div', null,
                groups.length === 0
                  ? h('div', { className: 'dshc-sub' }, '还没有记下别人；在下面加一个，或者聊到谁让账本自己长。')
                  : groups.map(([tier, arr]) => h(RelGroup, {
                    key: tier, tier, items: arr, aid, act, onChanged: bump, flash: justAdded,
                  })),
                h(PersonEditor, {
                  key: 'editor', aid, act, persons,
                  onAdded: (info) => {
                    setJustAdded({ ...info, at: Date.now() })
                    bump()
                    // 楂樹寒鍑犵灏遍€€锛屽埆璁╀汉浠ヤ负鏄父椹荤姸鎬?''
              setTimeout(() => setJustAdded(null), 6000)
                  },
                })))),

        mentions.length ? h(Sec, {
          title: '还没认出来的人',
          desc: '聊天里提到、但还没对上是谁的名字；选一个人挂上去，或者忽略。',
        },
          h(Card, null, mentions.map((m) => h(MentionRow, { key: m.id, aid, m, persons, onChanged: bump })))) : null,

        h(Sec, {
          title: '最近入账',
          desc: '账本追加的最近 12 笔；人物卡、边、提示词都是它的投影。',
        },
          h(Card, null, events.length === 0
            ? h('div', { className: 'dshc-sub' }, '账本还是空的。')
            : events.map((e) => h('div', {
              key: e.id, style: { padding: '6px 0', borderBottom: '1px dashed var(--line)' },
            },
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                h(Pill, null, REL_KIND_WORD[e.kind] || e.kind),
                h('div', {
                  className: 'dshc-sub',
                  style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                }, relEventText(e)),
                h('span', { className: 'm dshc-mono' }, relWhen(e.at))),
              e.feel && e.feel.text
                ? h('div', {
                  className: 'dshc-sub',
                  title: '这笔账发生那一刻的感觉：' + (e.feel.at || ''),
                  style: { marginTop: 2, marginLeft: 2, fontSize: 11.5, opacity: 0.62 },
                }, '当时的感觉：' + String(e.feel.text).slice(0, 60))
                : null)))))
    }

    function EdgeGraphPanel({ aid }) {
      const [g] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/edges'), [aid])
      if (g.loading) return h(Empty, null, '读取关系边…')
      if (g.error) return h('div', { className: 'dshc-err' }, g.error)
      return h(EdgeGraphView, { graph: g.data })
    }

    /* ============================================== 记忆仓库 / 日记 */

    function yesterdayStr() {
      const d = new Date(Date.now() - 86400000)
      const p = (n) => String(n).padStart(2, '0')
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    }

    /** 瀛楄妭閲忕骇锛欱 →KB →MB →GB →TB锛岃窡鎬婚噺娑ㄣ€?*/
    function fmtBytes(bytes) {
      const b = Number(bytes) || 0
      if (!(b > 0)) return '<0.1 KB'
      if (b < 1024) return (Math.round(b * 10) / 10) + ' B'
      const u = ['KB', 'MB', 'GB', 'TB']
      let v = b / 1024
      let i = 0
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
      const n = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10
      return n + ' ' + u[i]
    }

    /**
     * 璁板繂閲忔洸绾匡細鍙湁涓€鏉＄嚎锛屼粠搴曡竟宸﹁璧风瑪寰€鍙充笂璧般€?     * 鍥哄畾銆屼粠鍑虹敓鍒扮幇鍦ㄣ€嶏紱璺ㄥ害澶ф椂妯酱鏀规垚 YYYY-MM锛屽厤寰楄法骞寸湅涓嶆竻銆?     * 鏁版嵁璧?/vault/history锛堟柊鎺ュ彛锛涘涓绘病閲嶅惎鏃跺彧鐣欎竴鍙ユ彁绀猴級銆?     */
    function VaultDelta({ aid }) {
      const [s] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/vault/history?days=0'), [aid])

      if (s.error) {
        const stale = /接口不存在|NOT_FOUND/.test(s.error)
        return h('div', { className: 'dshc-c' }, h('div', { className: 'dshc-k-err' }, stale ? '宿主重启一次就能画' : s.error))
      }
      if (!s.data) return h('div', { className: 'dshc-c' }, h('div', { className: 'dshc-c-skel' }))

      const all = s.data.series || []
      const first = all.findIndex((x) => x.close > 0 || x.add_b > 0)
      const src = first < 0 ? [] : all.slice(first)
      // 鍓嶉潰鍨竴涓?0 鐐癸紝绾垮氨浠庡簳杈瑰乏瑙掕捣绗?''
              const prevDay = src.length ? new Date(Date.parse(src[0].day + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10) : ''
      const rows = src.length
        ? [{ day: prevDay, close: 0 }].concat(src)
        : (all.length >= 2 ? all.slice(-2) : [{ day: '', close: 0 }, { day: '', close: 0 }])

      const n = rows.length
      const W = 560
      const H = 86
      const TOP = 6
      const max = Math.max(1, ...rows.map((x) => x.close))
      const px = (i) => (n <= 1 ? 0 : (i / (n - 1)) * W)
      const py = (v) => H - 2 - (v / max) * (H - TOP - 2)

      let d = ''
      for (let i = 0; i < n; i++) {
        d += (i ? 'L' : 'M') + px(i).toFixed(1) + ' ' + py(rows[i].close).toFixed(1) + ' '
      }
      const area = d + 'L' + W + ' ' + H + ' L0 ' + H + ' Z'

      // 璺ㄥ害 ≥0 澶╂垨璺ㄥ勾 →YYYY-MM锛涘惁鍒?MM-DD
      const spanDays = Math.max(0, n - 1)
      const y0 = String(rows[0].day || '').slice(0, 4)
      const y1 = String(rows[n - 1].day || '').slice(0, 4)
      const useYm = spanDays >= 90 || (y0 && y1 && y0 !== y1)
      const tickLab = (x) => {
        const s = String(x || '')
        return useYm ? s.slice(0, 7) : s.slice(5)
      }
      // 绾佃酱锛氫笁鏍煎叡鐢ㄩ《鍒诲害閭ｄ竴妗ｏ紙KB/MB/鈥︼級锛屽崐妗ｄ笉浼氬啓鎴愬埆鐨勫崟浣?''
              const yUnit = (() => {
        const t = fmtBytes(max)
        const sp = t.lastIndexOf(' ')
        return sp > 0 ? t.slice(sp + 1) : 'KB'
      })()
      const yDiv = ({ B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 })[yUnit] || 1024
      const yNum = (v) => {
        if (!(v > 0)) return '0'
        const n = v / yDiv
        return n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10)
      }
      const yTicks = [yNum(max) + ' ' + yUnit, yNum(max / 2), '0']
      const xTicks = [0, 1 / 3, 2 / 3, 1].map((k) => tickLab(rows[Math.round(k * (n - 1))].day))

      return h('div', { className: 'dshc-c' },
        h('div', { className: 'dshc-c-grid' },
          h('div', { className: 'dshc-c-y' }, yTicks.map((t, i) => h('span', { key: i }, t))),
          h('div', { className: 'dshc-c-plot' },
            h('svg', {
              className: 'dshc-k', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', 'aria-hidden': true,
            },
              h('defs', null,
                h('linearGradient', { id: 'dshcKVault', x1: '0', y1: '0', x2: '0', y2: '1' },
                  h('stop', { offset: '0%', stopColor: 'var(--accent)', stopOpacity: '0.32' }),
                  h('stop', { offset: '100%', stopColor: 'var(--accent)', stopOpacity: '0' }))),
              h('path', { className: 'dshc-k-area', d: area }),
              n > 1 ? h('path', { className: 'dshc-k-line', d: d.trim() }) : null,
              h('circle', { className: 'dshc-k-dot', cx: px(n - 1), cy: py(rows[n - 1].close), r: 2.4 }))),
          h('div', { className: 'dshc-c-x' }, xTicks.map((t, i) => h('span', { key: i }, t)))))
    }

    function VaultCard({ aid, view, fresh }) {
      const [s, reload] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/vault'), [aid])
      // 注入用量走已有的历史接口，这样不依赖后端重启也能显示
      const [hist] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/metrics/history?days=365&keys=sys.inject_tokens'), [aid])
      const [msg, setMsg] = useState('')
      const [editing, setEditing] = useState(false)
      const [dir, setDir] = useState('')
      const [dlg, setDlg] = useState('')
      const [reveal, setReveal] = useState(false)
      const [busy, setBusy] = useState(false)
      // 鍏夊甫鑱斿姩锛氶紶鏍囧仠鍦ㄥ摢涓€琛岋紝涓婇潰閭ｆ潯鍗犳瘮褰╁甫灏辩偣浜摢涓€娈?''
              const [hi, setHi] = useState('')
      // 娉ㄦ按锛氬厛鐢?0 瀹斤紝涓嬩竴甯у啀鏀惧埌鐩爣瀹藉害
      const [grow, setGrow] = useState(false)
      // 澧為噺鍥鹃粯璁ゆ敹璧凤紱灞曞紑鏃舵墠鍘绘媺鏃堕棿绾?''
              const [delta, setDelta] = useState(true)

      const d = s.data || {}
      const parts = d.parts || []
      const root = (d.docs && d.docs.root) || ''
      // 鍗犳瘮 = 鐜板湪鏉℃暟 / 杩欎釜妯″潡銆岄璁¤兘瀛樺灏戙€嶏紝涓嶆槸鍗犳€诲瓧鑺傦紱婊′簡鎵嶈鏄庤娓呯悊鎴栨墿瀹?''
              const bar = (x) => Math.max(1, Math.min(100, Math.round(Number(x.pct) || 0)))
      const full = (x) => Number(x.pct) >= 100
      const color = (x) => (full(x) ? '#e5534b' : Number(x.pct) >= 80 ? '#d29922' : 'var(--dsw-alias-brand-primary, #6cf)')
      const tech = view === 'tech'
      const tokensOf = (x) => Math.ceil((Number(x.bytes) || 0) / 2)
      // 鍙湁涓ょ鐪熸暟鎹細瀛橀噺锛堟潯鏁?/ 瀛楄妭锛夊拰姣忚疆娉ㄥ叆鐢ㄩ噺锛坱oken锛?''
      const unitOf = (x) => ({ T3: '篇', T4: '轮' })[x.key] || '条'
      const sizeText = (x) => fmtBytes(x.bytes)
      const LABEL = { T2: '书签', T4: '对话档案', FA: '事实档案' }
      const labelOf = (x) => LABEL[x.key] || x.label
      // 鍚庣杩樻病閲嶈浇鏃?inject 涓虹┖锛屽氨鐢?history 鎺ュ彛鐨勬棩鍧囧€煎厹搴?''
              const history = (hist.data && hist.data.series && hist.data.series['sys.inject_tokens']) || []
      const histAvg = history.length ? Math.round(history.reduce((n, p) => n + Number(p.value || 0), 0) / history.length) : 0
      const inj = d.inject || (history.length ? { avg: histAvg, budget: 800, max: null, days: history.length } : null)
      const injPct = inj && inj.budget ? Math.max(1, Math.min(100, Math.round(Number(inj.avg) / Number(inj.budget) * 100))) : 0
      const injTone = injPct >= 95 ? 'bad' : injPct >= 80 ? 'warn' : 'ok'
      // 彩带 = 六个分区在总字节里的比例，和下面的行一一对应
      const byteSum = parts.reduce((n, x) => n + (Number(x.bytes) || 0), 0)
      const ribbonPct = (x) => Math.max(2, Math.round(((Number(x.bytes) || 0) / (byteSum || 1)) * 1000) / 10)
      const totalBytesTarget = Number(d.total_bytes) || byteSum || 0

      // 数字滚动 + 注水：钩子必须无条件调用，所以放在两个早退之前
      const totalShown = useCountUp(totalBytesTarget, 900)
      const injShown = useCountUp(inj ? (Number(inj.avg) || 0) : 0, 900)
      useEffect(() => {
        const t = setTimeout(() => setGrow(true), 80)
        return () => clearTimeout(t)
      }, [])

      if (s.loading) return h(Empty, null, '读取仓库…')
      if (s.error) return h(LoadErr, { error: s.error, retry: reload })

      const rowHover = (key) => ({
        'data-hi': hi === key ? '1' : '0',
        onMouseEnter: () => setHi(key),
        onMouseLeave: () => setHi((k) => (k === key ? '' : k)),
      })

      const saveDir = async () => {
        if (!dir.trim()) { setMsg('路径不能为空'); return }
        setBusy(true)
        try {
          const r = await call('POST', '/v1/agents/' + enc(aid) + '/vault/root', { path: dir.trim() }, true)
          setMsg('保存位置改成 ' + r.root)
          setEditing(false)
          reload()
        } catch (e) { setMsg(e.message) } finally { setBusy(false) }
      }
      // 瀵煎嚭璁板繂 = 鍙惈璁板繂鍏釜鍒嗗尯鐨?zip锛涘鍏ュ悆瀹冿紙鏁翠唤澶囦唤鍖呬篃鑳藉悆锛屼絾鍙彇璁板繂琛級
      const exportAll = async () => {
          setBusy(true); setMsg('整理可读版…')
        try {
          const z = await call('GET', '/v1/agents/' + enc(aid) + '/export/memory')
          if (!z || !z.zip_base64) { setMsg('导出接口没接上（后端还没重载）'); return }
          const name = 'memory-' + aid + '-' + new Date().toISOString().slice(0, 10) + '.zip'
          const a = document.createElement('a')
          a.href = 'data:application/zip;base64,' + z.zip_base64
          a.download = name
          a.click()
          setMsg('已下载 ' + name)
        } catch (e) { setMsg(e.message) } finally { setBusy(false) }
      }
      const openDir = async (p) => {
        try {
          const r = await call('POST', '/v1/agents/' + enc(aid) + '/vault/open', { path: p }, true)
          setMsg(r.ok ? '已打开：' + r.dir : r.reason)
        } catch (e) { setMsg(e.message) }
      }
      // 打开文件夹：先把可读版刷新到最新，再打开
      const openFolder = async () => {
        setReveal(true)
        if (fresh) {
          setBusy(true); setMsg('整理可读版…')
          try {
            await call('POST', '/v1/agents/' + enc(aid) + '/vault/export', {}, true)
          } catch (e) { /* 刷新失败也要能进文件夹 */ }
          setBusy(false)
        }
        let dir = root
        if (!dir) {
          try { dir = (await call('GET', '/v1/agents/' + enc(aid) + '/vault/root')).root || '' } catch (e) { dir = '' }
        }
        await openDir(dir)
      }
      const pathRow = () => h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
        h('span', { className: 'dshc-sub' }, '保存位置'),
        editing
          ? h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flex: 1, minWidth: 240 } },
            h(Input, { className: 'grow', placeholder: '例如 D:\\记忆\\意识体', value: dir, onChange: (e) => setDir(e.target.value) }),
            h(Btn, { primary: true, disabled: busy, onClick: saveDir }, '保存'),
            h(Btn, { onClick: () => { setEditing(false); setMsg('') } }, '取消'))
          : h('span', { className: 'dshc-mono', style: { flex: 1, wordBreak: 'break-all' } }, root || '—'),
        editing ? null : h(Btn, { ghost: true, onClick: () => { setDir(root); setEditing(true) } }, '改位置'))

      return h(Card, { className: 'dshc-vault' },
        h('span', { className: 'dshc-vault-glow', 'aria-hidden': true }),
        h('span', { className: 'dshc-vault-aura', 'aria-hidden': true }),
        h('span', { className: 'dshc-grid', 'aria-hidden': true }),
        h('span', { className: 'dshc-vault-scanband', 'aria-hidden': true }),
        h('span', { className: 'dshc-vault-node', 'aria-hidden': true }),
        h(Motes, { n: 5 }),
        h('div', { className: 'dshc-vault-in' },
          // 门牌：总量数一遍，右上是分区数
          h('div', { className: 'dshc-vault-head' },
            h(VaultMark, { size: 32 }),
            h('div', { className: 'dshc-vault-stat' },
              h('b', { className: 'dshc-vault-total' }, fmtBytes(totalShown)),
              h('span', { className: 'dshc-vault-cap' }, '总记忆 · ' + parts.length + ' 个分区'))),

          // 鍏褰╁甫锛氭瘡娈靛搴?= 杩欎釜鍒嗗尯鍗犲叏閮ㄨ蹇嗙殑姣斾緥
          parts.length ? h('div', { className: 'dshc-vault-ribbon', 'aria-hidden': true },
            parts.map((x, i) => h('i', {
              key: x.key,
              title: labelOf(x) + ' · ' + sizeText(x),
              'data-hi': hi === x.key ? '1' : '0',
              onMouseEnter: () => setHi(x.key),
              onMouseLeave: () => setHi((k) => (k === x.key ? '' : k)),
              style: { width: ribbonPct(x) + '%', background: vaultTone(i), animationDelay: (i * 60) + 'ms' },
            }))) : null,

          inj ? h('div', {
            className: 'dshc-vault-inj',
            title: inj.max != null
              ? '最近 ' + inj.n + ' 轮的实际注入量（sys.inject_tokens）'
              : '近 ' + (inj.days || 1) + ' 天的 sys.inject_tokens 日均',
          },
            h('span', { className: 'dshc-sub dshc-vault-injlab' }, '每轮注入'),
            h('div', { className: 'dshc-vault-track', 'data-tone': injTone },
              h('i', { className: 'dshc-vault-fill', style: { width: (grow ? injPct : 0) + '%' } }),
              h('span', { className: 'dshc-vault-tick', style: { left: '80%' }, title: '80% 警戒线' })),
            h('span', { className: 'dshc-mono dshc-vault-injnum' },
              Math.round(injShown) + '/' + inj.budget + ' token',
              h('em', null, '（' + injPct + '%）'
                + (inj.max != null ? ' · 最高 ' + inj.max : ' · 近 ' + (inj.days || 1) + ' 天日均')))) : null,

          h('div', { className: 'dshc-vault-rows' },
            parts.map((x, i) => tech
              ? h('div', { key: x.key, className: 'dshc-vault-row dshc-vault-row--tech', ...rowHover(x.key), style: { '--i': i } },
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                  h('span', { className: 'dshc-sub', style: { width: 96, flex: 'none' } }, labelOf(x)),
                  h('div', { style: { flex: 1, height: 8, borderRadius: 4, background: 'var(--dsw-alias-border-secondary, #333)' } },
                    h('div', { style: { width: bar(x) + '%', height: 8, borderRadius: 4, background: color(x) } })),
                  h('span', { className: 'dshc-mono', style: { width: 200, flex: 'none', textAlign: 'right', whiteSpace: 'nowrap' } },
                    x.pct + '% · ' + sizeText(x))),
                h('div', { className: 'dshc-sub', style: { marginLeft: 104 } },
                  x.rows + ' / ' + (x.cap || '—') + ' 条' + (full(x) ? '（已满）' : '') + ' · ' + x.hint + ' · ≈' + tokensOf(x).toLocaleString('en-US') + ' token'))
              : h('div', { key: x.key, className: 'dshc-vault-row', ...rowHover(x.key), style: { '--i': i } },
                h('span', { className: 'dshc-vault-key', style: { background: vaultTone(i) } }),
                h('span', { className: 'dshc-vault-lab' }, labelOf(x)),
                h('span', { className: 'dshc-vault-num dshc-mono' }, x.rows + ' ' + unitOf(x)),
                h('span', { className: 'dshc-vault-sep' }, '·'),
                h('span', { className: 'dshc-vault-kb dshc-mono' }, sizeText(x))))),

          tech ? h('div', { className: 'dshc-note', style: { marginTop: 10 } },
            '整库 ' + (d.db_bytes ? fmtBytes(d.db_bytes) : '—') + ' · 文本合计 ' + fmtBytes(d.total_bytes || totalBytesTarget)) : null,

          // 增量图：默认展开
          h('details', {
            className: 'dshc-vault-delta',
            open: delta,
            onToggle: (e) => setDelta(e.currentTarget.open),
          },
            h('summary', null, '记忆增量'),
            delta ? h(VaultDelta, { aid }) : null),

          // 涓変釜閿細瀵煎嚭璁板繂 / 瀵煎叆璁板繂 / 鎵撳紑鏂囦欢澶?''
              h('div', { className: 'dshc-vault-acts' },
            h(Btn, { primary: true, disabled: busy, onClick: exportAll }, busy ? '导出中…' : '导出记忆'),
            h(Btn, { disabled: busy, onClick: () => { setMsg(''); setDlg('import') } }, '导入记忆'),
            h(Btn, { disabled: busy, onClick: openFolder }, '打开文件夹')),

          reveal ? h('div', { className: 'dshc-note', style: { marginTop: 10 } },
            pathRow(),
            h('div', { className: 'dshc-sub', style: { marginTop: 4 } }, '可读版（Markdown）每次打开时刷新；换机 / 重装用「导出记忆」下的 zip 导入。')) : null,

          !dlg && msg ? h('div', { className: 'dshc-note', style: { marginTop: 8 } }, msg) : null,

          dlg === 'import' ? h(MemoryImportDialog, { aid, onClose: () => setDlg(''), onImported: reload }) : null))
    }

    /**
     * 瀵煎叆璁板繂锛氳窡銆屽鍏ユ剰璇嗐€嶅悓涓€濂楅潰鏉?鈥斺€?宸﹁竟瑙勮寖锛坺ip 鏁村簱鎭㈠锛夛紝鍙宠竟闅忔剰锛堜换鎰忔枃鏈氦缁欐ā鍨嬫暣鐞嗭級銆?     * 鍙槸钀界殑鏄蹇嗭細楸兼牸 / 鎯呯华 / 椹卞姏 / 鎻愭閮戒笉鍔ㄣ€?     */
    function MemoryImportDialog({ aid, onClose, onImported }) {
      const [zipBusy, setZipBusy] = useState(false)
      const [zipMsg, setZipMsg] = useState('')
      const [dragOver, setDragOver] = useState(false)
      const [text, setText] = useState('')
      const [freeName, setFreeName] = useState('')
      const [txtOver, setTxtOver] = useState(false)
      const [freeBusy, setFreeBusy] = useState(false)
      const [freeErr, setFreeErr] = useState('')
      const [freeRes, setFreeRes] = useState(null)

      const importZip = async (f) => {
        if (!f) return
        setZipBusy(true); setZipMsg('正在导入…')
        try {
          const bytes = new Uint8Array(await f.arrayBuffer())
          let bin = ''
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
          const r = await call('POST', '/v1/agents/' + enc(aid) + '/import/memory', { zip_base64: btoa(bin) }, true)
          const got = []
          if (r.memory) got.push('记忆 ' + r.memory)
          if (r.episodes) got.push('书签 ' + r.episodes)
          if (r.diaries) got.push('日记 ' + r.diaries)
          if (r.raw) got.push('对话 ' + r.raw)
          if (r.facts) got.push('事实 ' + r.facts)
          setZipMsg('导入 ' + ((r && r.imported) || 0) + ' 行' + (got.length ? ' · ' + got.join(' · ') : ''))
          if (onImported) onImported()
        } catch (e) { setZipMsg(e.message || String(e)) } finally { setZipBusy(false) }
      }

      // 鎷?/ 閫変竴涓枃鏈枃浠惰繘銆岄殢鎰忓鍏ャ€嶏細鍏堣鎴愭枃鏈紝鍐嶄氦缁欐ā鍨嬫暣鐞?''
              const readTextFile = async (f) => {
        if (!f) return
        setFreeName(f.name); setFreeErr(''); setFreeRes(null)
        try { setText(String(await f.text()).slice(0, 20000)) } catch (e) { setFreeErr('读不出文本内容') }
      }

      const looseImport = async () => {
        if (freeBusy) return
        const t = text.trim()
        if (t.length < 10) { setFreeErr('内容太少，至少 10 个字'); return }
        setFreeBusy(true); setFreeErr(''); setFreeRes(null)
        try {
          const r = await call('POST', '/v1/agents/' + enc(aid) + '/import/loose', { text: t.slice(0, 20000), filename: freeName }, true)
          setFreeRes(r)
          setText('')
          if (onImported) onImported()
        } catch (e) { setFreeErr(e.message || String(e)) } finally { setFreeBusy(false) }
      }

      const paneStyle = { border: '1px solid var(--line)', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 240, background: 'color-mix(in srgb, var(--panel) 70%, transparent)' }
      const paneTitle = (label) => h('div', { style: { fontSize: 13.5, fontWeight: 650, letterSpacing: .3 } }, label)
      const zipPane = h('div', { style: paneStyle },
        paneTitle('规范导入'),
        h('div', { className: 'dshc-sub' }, '导出记忆的 zip，六个分区整份恢复'),
        h('div', {
          onDragOver: (e) => { e.preventDefault(); setDragOver(true) },
          onDragLeave: () => setDragOver(false),
          onDrop: (e) => {
            e.preventDefault(); setDragOver(false)
            importZip(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0])
          },
          style: {
            padding: '18px 14px', textAlign: 'center', borderRadius: 12, flex: 1,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
            border: '1px dashed ' + (dragOver ? 'var(--accent)' : 'var(--line2)'),
            background: dragOver ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'transparent',
            transition: 'border-color .15s, background .15s',
          },
        },
          h('div', { style: { fontSize: 13, opacity: .85 } }, zipBusy ? '正在导入…' : '把 zip 拖到这里'),
          h('div', { className: 'dshc-sub' }, '或'),
          h('label', { className: 'dshc-btn dshc-btn--ghost', style: { display: 'inline-block', cursor: 'pointer' } },
            '选择文件',
            h('input', {
              type: 'file', accept: '.zip,application/zip', disabled: zipBusy, style: { display: 'none' },
              onChange: (e) => {
                const f = e.target.files && e.target.files[0]
                if (f) importZip(f)
                try { e.target.value = '' } catch { /* ignore */ }
              },
            }))),
        h('div', { className: 'dshc-sub' }, '只覆盖记忆，鱼格 / 情绪 / 驱力 / 提案都不动；导入前建议先导出一份。'),
        zipMsg ? h('div', { className: 'dshc-note' }, zipMsg) : null)

      const resultLine = freeRes ? h('div', { className: 'dshc-note', style: { marginTop: 2 } },
        '采用 ' + freeRes.adoption.adopted + '/' + freeRes.adoption.total + ' 项 · '
          + Math.round(freeRes.adoption.rate * 100) + '% · 继承约 ' + freeRes.adoption.chars + ' 字',
        h('div', { className: 'dshc-sub' },
          '写入记忆 ' + freeRes.imported.memory + ' 条'
            + (freeRes.imported.duplicate ? ' · 已有 ' + freeRes.imported.duplicate + ' 条（跳过）' : '')
            + (freeRes.imported.skipped ? ' · 空条目 ' + freeRes.imported.skipped + ' 条' : '')
            + (freeRes.summary ? ' · ' + freeRes.summary : ''))) : null

      const freePane = h('div', { style: paneStyle },
        paneTitle('随意导入'),
        h('div', { className: 'dshc-sub' }, '任意文本，交给大模型整理成记忆'),
        h('textarea', {
          value: text, rows: 5, disabled: freeBusy,
          placeholder: '把文件拖到这里，或直接粘贴内容…',
          onChange: (e) => setText(e.target.value),
          onDragOver: (e) => { e.preventDefault(); setTxtOver(true) },
          onDragLeave: () => setTxtOver(false),
          onDrop: async (e) => {
            e.preventDefault(); setTxtOver(false)
            await readTextFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0])
          },
          style: {
            width: '100%', resize: 'vertical', minHeight: 96, background: 'transparent', color: 'var(--ink)',
            border: '1px solid ' + (txtOver ? 'var(--accent)' : 'var(--line2)'), borderRadius: 10, padding: 10, font: 'inherit',
          },
        }),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('label', { className: 'dshc-btn dshc-btn--ghost', style: { display: 'inline-block', cursor: 'pointer' } },
            '选择文件',
            h('input', {
              type: 'file', disabled: freeBusy, style: { display: 'none' },
              onChange: async (e) => {
                await readTextFile(e.target.files && e.target.files[0])
                try { e.target.value = '' } catch { /* ignore */ }
              },
            })),
          h('div', { style: { flex: 1 } }),
          h(Btn, { primary: true, disabled: freeBusy || text.trim().length < 10, onClick: looseImport },
            freeBusy ? '整理中…' : '整理并导入')),
        freeErr ? h('div', { className: 'dshc-err' }, freeErr) : null,
        resultLine)

      return h('div', {
        style: { position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(3,6,12,.62)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 },
      }, h('div', {
        style: { width: '100%', maxWidth: 780, maxHeight: '86vh', overflow: 'auto', background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 16, padding: 18, boxShadow: '0 30px 80px -40px rgba(0,0,0,.8)' },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 } },
          h('b', { style: { fontSize: 15, letterSpacing: .3 } }, '导入记忆'),
          h('div', { style: { flex: 1 } }),
          h(Btn, { ghost: true, onClick: onClose }, '关闭')),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 } }, zipPane, freePane)))
    }

    function DiaryView({ aid, day, extra }) {
      const [s, reload] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/diaries/' + enc(day)), [aid, day])
      const [rewriting, setRewriting] = useState(false)
      const [rewriteMsg, setRewriteMsg] = useState('')
      if (s.loading) return h(Empty, null, '读取 ' + day + ' 的日记…')
      if (s.error) return h(LoadErr, { error: s.error, retry: reload })
      const d = s.data || {}
      const ctx = d.context || {}
      const write = (ctx && ctx.write) || {}
      const pack = write.pack || {}
      const scenes = Array.isArray(write.scenes) ? write.scenes : []
      const ax = ctx.axes || {}
      const short = { ei: '外', sn: '实', tf: '思', jp: '判', sensitivity: '敏' }
      const pending = !!d.pending || d.source === 'none'
      const sourceLabel = d.source === 'model' ? '模型写的'
        : d.source === 'stub' ? '素材卡'
          : d.source === 'rules' ? '模板拼的'
            : (pending ? '还空着' : '')
      const reasonZh = (why) => {
        const w = String(why || '')
        if (w === 'no_model') return '当时没有可用的写日记模型'
        if (w === 'empty') return '模型回了空内容'
        if (w.startsWith('gate:too_short')) return '写得太短'
        if (w.startsWith('gate:too_long')) return '写得太长'
        if (w.startsWith('gate:paragraphs')) return '段落数不对'
        if (w.startsWith('gate:report')) return '写成了工作汇报'
        if (w.startsWith('gate:enumerate')) return '写成了按话题列举'
        if (w.startsWith('gate:cover_all')) return '把一天的事都过了一遍'
        if (w.startsWith('gate:echo')) return '像在复读提示词'
        if (w.startsWith('gate:')) return '没过质检'
        if (w.startsWith('thrown:')) return '模型调用出错'
        return '这次没写成'
      }
      const packBits = []
      if (Number(pack.n_cluster) > 0) packBits.push('簇修 ' + pack.n_cluster)
      if (Number(pack.n_model) > 0) packBits.push('精修 ' + pack.n_model)
      if (Number(pack.n_rules) > 0) packBits.push('规则 ' + pack.n_rules)
      if (pack.prefer_cluster) packBits.push('忙天优先簇')
      if (pack.retry_of) packBits.push('缩包重试')
      if (Number(pack.skipped_low) > 0) packBits.push('跳过低分 ' + pack.skipped_low)
      if (write.select) packBits.push(write.select === 'model' ? '模型选场' : '规则选场')
      if (scenes.length) packBits.push('用了 ' + scenes.length + ' 段')
      if (Number(pending ? d.attempts : 0) > 0) packBits.push('试过 ' + d.attempts + ' 次')
      const chips = [
        d.mood ? '心情 ' + d.mood : '',
        ctx.affect ? '情绪 ' + ctx.affect.label + ' ' + Number(ctx.affect.intensity).toFixed(2) : '',
        (write.mood_source === 'day' || ctx.mood_source === 'day') ? '心情按当日' : ((write.mood_source === 'live' || ctx.mood_source === 'live') ? '心情按此刻' : ''),
        ctx.drive ? '驱力 ' + ctx.drive.band : '',
        Object.keys(ax).length ? '性格 ' + Object.entries(ax).map(([k, v]) => (short[k] || k) + Number(v).toFixed(2)).join(' ') : '',
        (ctx.values || []).length ? '看重 ' + ctx.values.map((v) => v.key).join('/') : '',
        sourceLabel,
        Number(d.late) ? '补写' : '',
        ...packBits,
      ].filter(Boolean)
      const doRewrite = async () => {
        if (rewriting) return
        const ask = pending
          ? '现在就补写 ' + day + ' 的日记？'
          : '按今天的素材重写 ' + day + ' 的日记？会覆盖这篇（版本号 +1）。'
        if (!window.confirm(ask)) return
        setRewriting(true)
        setRewriteMsg('')
        try {
          const out = await call('POST', '/v1/agents/' + enc(aid) + '/diaries/rewrite', { day }, true)
          if (out && out.pending) {
            setRewriteMsg('还是没写成（' + reasonZh(out.fail_reason) + '），已留在待补队列，模型回来会再试。')
          } else if (out && out.source === 'model') {
            setRewriteMsg('已用模型重写（v' + out.version + '）')
          } else {
            setRewriteMsg('已重写（v' + (out && out.version) + '，' + (out && out.source === 'stub' ? '素材卡' : '模板') + '）')
          }
          reload()
        } catch (e) {
          setRewriteMsg(e.message || String(e))
        } finally { setRewriting(false) }
      }
      return h(Card, null,
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 } },
          h(Pill, null, day),
          chips.map((c, i) => h(Pill, { key: i }, c))),
        d.feels && d.feels.length
          ? h('div', { className: 'dshc-sub', style: { marginBottom: 8, lineHeight: 1.7 } },
            '这一天的感觉（' + d.feels.length + ' 条）',
            d.feels.slice(0, 3).map((f) => h('div', { key: f.id, style: { marginTop: 2 } },
              '· ' + String(f.text || '') + (f.at ? '（' + String(f.at).slice(11, 16) + '）' : ''))),
            d.feels.length > 3
              ? h('div', { style: { marginTop: 2, opacity: 0.7 } },
                '还有 ' + (d.feels.length - 3) + ' 条，去「我最近怎么感觉」看全部')
              : null)
          : null,
        h('textarea', {
          className: 'dshc-ta', readOnly: true, value: pending ? '' : String(d.text || ''),
          style: { width: '100%', minHeight: 260, lineHeight: 1.9, resize: 'vertical', background: 'transparent', fontSize: 13.5 },
        }),
        pending
          ? h('div', { className: 'dshc-note', style: { marginTop: 6 } },
            '这天还没写成。' + (Number(d.attempts) > 0 ? '已经试过 ' + d.attempts + ' 次，' : '')
              + (d.fail_reason ? '最近一次卡在：' + reasonZh(d.fail_reason) + '。' : '')
              + '模型回来之后 30 分钟内会自动补，也可以现在手动试一次。')
          : null,
        d.source === 'stub'
          ? h('div', { className: 'dshc-note', style: { marginTop: 6 } },
            '这是素材卡，不是日记：只把那天的事列出来，没有假装写成第一人称。等模型回来会自动重写成日记。')
          : null,
        d.source === 'rules'
          ? h('div', { className: 'dshc-note', style: { marginTop: 6 } },
            '这是旧的模板篇（v1）：按纪要标题和事实拼出来的，不是模型写的。可以点下面「按今天的素材重写」换成 v2。')
          : null,
        d.source === 'model'
          ? h('div', { className: 'dshc-note', style: { marginTop: 6 } },
            '模型写成：先挑 1–2 个场景，再拿当时原话写；不是把一天 20 条纪要整包喂进去。'
              + (scenes.length ? '这篇用了：' + scenes.map((x) => x.title).join('；') : ''))
          : null,
        scenes.length
          ? h('div', { className: 'dshc-sub', style: { marginTop: 6, lineHeight: 1.8 } },
            scenes.map((x, i) => h('div', { key: i },
              '· ' + String(x.title || '')
                + '（分 ' + Number(x.poignancy || 0).toFixed(1)
                + (x.grounding === 'episode' ? '，没原话，用纪要' : x.grounding === 'fact' ? '，来自事实' : '，用原话') + '）')))
          : null,
        h('div', { style: { marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h(Btn, { disabled: rewriting, onClick: doRewrite }, rewriting ? '重写中…' : (pending ? '现在就补写' : '按今天的素材重写')),
          rewriteMsg ? h('span', { className: 'dshc-note' }, rewriteMsg) : null),
        extra
          ? h('div', { style: { marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-secondary, #333)' } }, extra)
          : null)
    }

/* ================================== 鏃堕棿绾?/ 鍘熻瘽 / 瀵煎叆 */

    const TEMP_COLOR = { hot: '#ff8a5c', warm: '#6cf', cold: '#8899aa', archived: '#555f6b' }
    // 档位一律用中文写：面板是给人看的，不让人读 hot / warm / cold
    const TEMP_LABEL = { hot: '热', warm: '温', cold: '冷', archived: '归档' }
    const HEAT_TIP = '热度 = 0.40×重要度 + 0.22×新鲜度（按半衰期衰减） + 0.18×被想起次数 + 0.10×钉住 + 0.10×情绪强度，按此刻现算'

    function Strength({ m }) {
      const heat = Math.max(0, Math.min(1, Number(m.heat) || 0))
      // temp_now 是「按现在的状态算的温度」，temp_state 是每天推进一次的存档值；
      // 涓よ€呬笉涓€鑷存椂鍙湪杩欓噷璇存槑涓€鍙ワ紝涓嶆妸涓や釜鏁板苟鎺掓憜鍑烘潵銆?''
              const now = m.temp_now || m.temp_state || 'warm'
      const saved = m.temp_state || 'warm'
      const color = TEMP_COLOR[now] || '#6cf'
      const tempTip = '温度：' + (TEMP_LABEL[now] || now) +
        (saved !== now ? '（库里的存档还是「' + (TEMP_LABEL[saved] || saved) + '」，等下一次推进）' : '')
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 } },
        h('div', { style: { flex: 1, height: 5, borderRadius: 3, background: 'var(--dsw-alias-border-secondary, #333)' } },
          h('div', { style: { width: Math.round(heat * 100) + '%', height: 5, borderRadius: 3, background: color } })),
        h('span', { className: 'dshc-mono', title: HEAT_TIP }, heat.toFixed(2)),
        h('span', { className: 'dshc-sub', title: tempTip }, TEMP_LABEL[now] || now))
    }

    function SourceLine({ aid, turnId }) {
      const [open, setOpen] = useState(false)
      const [s, setS] = useState(null)
      if (!turnId) return null
      const toggle = async () => {
        if (open) { setOpen(false); return }
        setOpen(true)
        if (s) return
        try { setS(await call('GET', '/v1/agents/' + enc(aid) + '/turns/' + enc(turnId))) }
        catch (e) { setS({ error: e.message }) }
      }
      return h('div', { style: { marginTop: 4 } },
        h(Btn, { ghost: true, onClick: toggle }, open ? '收起原话' : '看原话'),
        open ? h('div', { className: 'dshc-note', style: { marginTop: 4, whiteSpace: 'pre-wrap' } },
          !s ? '读取中…' : s.error ? s.error
            : (s.around || []).map((x) => (x.role === 'user' ? '你：' : '我：') + String(x.text).slice(0, 160)).join('\n')) : null)
    }

    /* 鏃堕棿绾匡細涓€澶╀竴琛岋紝鐐瑰紑鎵嶅睍寮€褰撳ぉ鏄庣粏锛涢粯璁ゅ彧寮€鏈€鏂颁竴澶┿€?*/
    const TL_WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    function tlDayLabel(day, today, yday) {
      if (day === today) return '今天'
      if (day === yday) return '昨天'
      return Number(day.slice(5, 7)) + '月' + Number(day.slice(8, 10)) + '日'
    }
    function tlWeekday(day) {
      const t = Date.parse(day + 'T00:00:00Z')
      return Number.isFinite(t) ? TL_WEEK[new Date(t).getUTCDay()] : ''
    }
    function tlMix(items) {
      const m = new Map()
      for (const it of items) m.set(it.type, (m.get(it.type) || 0) + 1)
      return [...m.entries()].sort((a, b) => b[1] - a[1])
    }
    function TLRow({ m }) {
      return h('div', { className: 'dshc-tl-row' },
        h('span', { className: 'dshc-tl-dot', 'data-t': m.type, title: TYPE_LABEL[m.type] || m.type }),
        h('div', { className: 't', title: m.text }, m.text),
        h('span', { className: 'dshc-tl-strength' }, h(Strength, { m })))
    }

    function TimelineView({ aid }) {
      const [s, reload] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/memory/timeline?days=5'), [aid])
      // 鏃堕棿绾夸笂鐨勭儹搴︽潯鍚屾牱鎸夋鍒荤畻锛屽紑鐫€椤甸潰灏辨瘡 20 绉掑涓€娆?''
              useLive(reload, 20000)
      if (s.loading && !s.data) return h(Empty, null, '读取时间线…')
      if (s.error && !s.data) return h(LoadErr, { error: s.error, retry: reload })
      const d = s.data || {}
      const groups = d.groups || []
      // 鏈湴鍘嗘棩锛堜笉瑕?toISOString锛歎TC 浼氭妸涓浗鍑屾櫒鏍囨垚鏄ㄥぉ锛?''
              const _pad = (n) => String(n).padStart(2, '0')
      const _local = (ms) => { const x = new Date(ms); return x.getFullYear() + '-' + _pad(x.getMonth() + 1) + '-' + _pad(x.getDate()) }
      const today = _local(Date.now())
      const yday = _local(Date.now() - 86400000)
      const filled = groups.filter((g) => g.count > 0).length
      return h(Card, null,
        h('div', { className: 'dshc-tl-meta' },
          h('summary', { className: 'dshc-fold' }, '提案目标（它在攒什么证据）'),
          h('span', { className: 'dshc-mono' }, (d.total || 0) + ' 条 · ' + filled + '/' + (d.days || groups.length || 5) + ' 天有记' +
            (d.at ? ' · 算于 ' + clockOf(d.at) : ''))),
        !(d.total) ? h(Empty, null, '这阵子还没记住什么。')
          : h('div', { className: 'dshc-tl' }, groups.map((g) => {
          const items = g.items || []
          const mx = tlMix(items)
          return h('details', { key: g.day, className: 'dshc-tl-day' },
            h('summary', null,
              h('span', { className: 'dshc-tl-date' },
                tlDayLabel(g.day, today, yday),
                h('em', null, tlWeekday(g.day))),
              h('span', {
                className: 'dshc-tl-mix',
                title: mx.map(([k, n]) => (TYPE_LABEL[k] || k) + ' ' + n).join(' · '),
              }, mx.slice(0, 3).map(([k, n]) => h('i', { key: k, 'data-t': k, style: { flex: String(n) } }))),
              h('span', { className: 'dshc-tl-spacer' }),
              h('span', { className: 'dshc-tl-count' }, (g.count || items.length) + ' 条'),
              h('svg', { className: 'dshc-tl-chev', viewBox: '0 0 12 12', 'aria-hidden': 'true' },
                h('path', {
                  d: 'M4 2.5 L8 6 L4 9.5', fill: 'none', stroke: 'currentColor',
                  strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
                }))),
            items.length === 0
              ? h('div', { className: 'dshc-tl-body' }, h('div', { className: 'dshc-sub' }, '这天没记下什么。'))
              : h('div', { className: 'dshc-tl-body' },
                  items.slice(0, 10).map((m) => h(TLRow, { key: m.id, m })),
                  items.length > 10
                    ? h('details', { className: 'dshc-fold dshc-tl-more' },
                        h('summary', null, '另外 ' + (items.length - 10) + ' 条 · 点开'),
                        items.slice(10).map((m) => h(TLRow, { key: m.id, m })))
                    : null))
        })))
    }

    const REL_TIER_DESC = {
      owner: {
        short: '唯一 · 记得最深',
        long: '主人只有一个：记最细、忘最慢，提示词里按「热情」说话，可以主动关心、提共同经历。',
      },
      acquaintance: {
        short: '长期 · 记得住',
        long: '熟人：记得名字、怎么认识、几条事实和边；60 天没互动会退成生人。',
      },
      stranger: {
        short: '刚认识 · 忘得快',
        long: '生人：只有一个印象，默认不进关系图；14 天没互动就归档，卡片退场但账本留着。',
      },
    }

    /** 涓€妗ｄ汉涓€涓笅鎷夛細鏀惰捣鏃跺彧鏈変汉鏁板拰涓€鍙ュ姛鑳界畝杩帮紱鍒氳涓嬬殑浜哄湪鍝。锛屽摢妗ｈ嚜鍔ㄥ睍寮€銆?*/
