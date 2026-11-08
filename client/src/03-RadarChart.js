    function RadarChart({ labels, size = 180 }) {
      const keys = Object.keys(AFFECT_KEY)
      const raw = keys.map((k) => Number((labels && labels[k]) || 0))
      const max = Math.max(1, ...raw)
      const vals = raw.map((n) => n / max)
      const cx = size / 2, cy = size / 2, r = size * 0.38
      const pt = (i, v) => {
        const a = (-Math.PI / 2) + (i / keys.length) * Math.PI * 2
        return [cx + Math.cos(a) * r * v, cy + Math.sin(a) * r * v]
      }
      const poly = vals.map((v, i) => pt(i, v).join(',')).join(' ')
      const grid = [0.33, 0.66, 1].map((g) => vals.map((_, i) => pt(i, g).join(',')).join(' '))
      return h('svg', { width: size, height: size, viewBox: '0 0 ' + size + ' ' + size, style: { display: 'block', margin: '0 auto' } },
        grid.map((g, i) => h('polygon', { key: 'g' + i, points: g, fill: 'none', stroke: 'currentColor', opacity: 0.15 })),
        h('polygon', { points: poly, fill: 'color-mix(in srgb, var(--accent) 28%, transparent)', stroke: 'var(--accent)', strokeWidth: 1.5 }),
        keys.map((k, i) => {
          const [x, y] = pt(i, 1.18)
          return h('text', { key: k, x, y, fill: 'currentColor', fontSize: 9, textAnchor: 'middle', dominantBaseline: 'middle', opacity: 0.75 }, AFFECT_KEY[k] || k)
        }))
    }

    /** 妯″潡鍏崇郴杈圭畝鍥?*/
    function EdgeGraphView({ graph }) {
      const g = graph || { nodes: [], edges: [], relations: [] }
      const w = 340, hgt = 220
      const mods = ['memory', 'persona', 'affect', 'drive', 'relation', 'condition', 'selfmod']
      const pos = {}
      mods.forEach((id, i) => {
        const a = (-Math.PI / 2) + (i / mods.length) * Math.PI * 2
        pos[id] = [w / 2 + Math.cos(a) * 78, hgt / 2 + Math.sin(a) * 68]
      })
      const labelOf = (id) => ((g.nodes || []).find((n) => n.id === id) || {}).label || id
      return h('div', null,
        h('svg', { width: w, height: hgt, viewBox: '0 0 ' + w + ' ' + hgt },
          (g.edges || []).filter((e) => pos[e.from] && pos[e.to]).map((e) => {
            const [x1, y1] = pos[e.from], [x2, y2] = pos[e.to]
            return h('line', {
              key: e.id, x1, y1, x2, y2,
              stroke: e.sign < 0 ? 'var(--bad)' : 'var(--accent)',
              strokeWidth: 1 + Number(e.gain || 0), opacity: 0.55,
            })
          }),
          mods.map((id) => h('g', { key: id },
            h('circle', { cx: pos[id][0], cy: pos[id][1], r: 14, fill: 'var(--panel2)', stroke: 'var(--line2)' }),
            h('text', { x: pos[id][0], y: pos[id][1] + 3, textAnchor: 'middle', fontSize: 9, fill: 'currentColor' }, labelOf(id).slice(0, 2))))),
        (g.bias && g.bias.fired && g.bias.fired.length)
          ? h('div', { className: 'dshc-note' }, '当前触发：' + g.bias.fired.join(', ') + ' · intensity×' + Number(g.bias.intensityMul).toFixed(2))
          : h('div', { className: 'dshc-note' }, '12 条模块边；颜色：青为正、红为负。'),
        (g.relations || []).length ? h('div', { className: 'dshc-sub', style: { marginTop: 6 } },
          '人物：' + g.relations.map((r) => r.name + '(' + Number(r.closeness).toFixed(2) + ')').join(' · ')) : null)
    }

    const KV = ({ label, value, hint }) => h('div', null,
      h('div', { className: 'dshc-kv' }, h('b', { className: 'dshc-mono' }, value), h('span', null, hint || '')),
      h('div', { className: 'dshc-sub' }, label))

    const Empty = ({ children }) => h('div', { className: 'dshc-empty' }, children)

    const Btn = ({ children, onClick, primary, danger, ghost, tint, disabled, title, sm }) => {
      // 闃查噸澶嶇偣鍑伙細鐐逛笅绔嬪埢鑷攣 700ms锛岄伩鍏嶅弻鍑?杩炵偣閲嶅鎻愪氦
      const [locked, setLocked] = useState(false)
      const fire = (e) => {
        if (locked || !onClick) return
        setLocked(true)
        Promise.resolve().then(() => onClick(e)).finally(() => setTimeout(() => setLocked(false), 700))
      }
      return h('button', {
        type: 'button', title, disabled: disabled || locked,
        className: 'dshc-btn' + (primary ? ' dshc-btn--primary' : '') + (danger ? ' dshc-btn--danger' : '') + (tint ? ' dshc-btn--tint' : '') + (ghost ? ' dshc-btn--ghost' : '') + (sm ? ' dshc-btn--sm' : ''),
        onClick: fire,
      }, children)
    }

    const Seg = ({ items, value, onChange }) => h('div', { className: 'dshc-seg' },
      items.map(([k, label]) => h('button', {
        key: k, type: 'button', 'data-on': value === k ? '1' : '0', onClick: () => onChange(k),
      }, label)))

    const Input = (props) => h('input', { ...props, className: 'dshc-in ' + (props.className || '') })
    const TextArea = (props) => h('textarea', { ...props, className: 'dshc-ta ' + (props.className || '') })
    /** 瀛楁暟璁℃暟鍣細杩欎簺瀛楁瘡杞兘浼氳繘鎻愮ず璇嶏紝瓒呴檺鐢辫緭鍏ユ maxLength 鎸′綇锛屾樉绀哄彧鍋氭彁閱?*/
    const CharCount = ({ value, limit }) => {
      const n = Array.from(String(value == null ? '' : value)).length
      return h('span', { className: 'dshc-count', 'data-over': n > limit ? '1' : '0' }, n + '/' + limit)
    }

    function useAsync(loader, deps) {
      const [s, set] = useState({ loading: true, data: null, error: '' })
      const tick = useRef(0)
      const run = useCallback(() => {
        const my = ++tick.current
        set((p) => ({ ...p, loading: true, error: '' }))
        Promise.resolve().then(loader)
          .then((data) => { if (my === tick.current) set({ loading: false, data, error: '' }) })
          .catch((e) => { if (my === tick.current) set((p) => ({ ...p, loading: false, error: e.message || String(e) })) })
      }, deps)
      useEffect(() => { run() }, [run])
      return [s, run]
    }

    /**
     * 椤甸潰寮€鐫€灏遍殧涓€浼氬効閲嶅彇涓€娆°€?     *
     * 鐑害閲岀殑鏂伴矞搴︽槸鎸夌鍦ㄨ“鍑忕殑锛屽彧鍦ㄦ寕杞芥椂鍙栦竴娆★紝鐪嬪埌鐨勬案杩滄槸寮€椤甸偅涓€鍒荤殑蹇収銆?     * 绐楀彛鍒囧埌鍚庡彴灏卞仠锛堢渷璇锋眰锛夛紝鍒囧洖鏉ョ珛鍒昏ˉ涓€娆★紝涓嶈嚦浜庡洖鏉ヨ繕鐪嬬潃鏃ф暟銆?     */
    function useLive(run, ms) {
      useEffect(() => {
        if (!run || !ms) return undefined
        let iv = null
        const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
        const kick = () => { if (visible()) run() }
        const start = () => { if (!iv) iv = setInterval(kick, ms) }
        const stop = () => { if (iv) { clearInterval(iv); iv = null } }
        const onVis = () => { if (visible()) { start(); kick() } else stop() }
        start()
        window.addEventListener('focus', kick)
        document.addEventListener('visibilitychange', onVis)
        return () => {
          stop()
          window.removeEventListener('focus', kick)
          document.removeEventListener('visibilitychange', onVis)
        }
      }, [run, ms])
    }

    /** 鍙彇鏃跺垎绉掞細闈㈡澘涓婃爣銆岀畻浜?13:24:07銆嶆瘮鏁存潯 ISO 濂借 */
    const clockOf = (iso) => {
      const t = Date.parse(iso)
      if (!Number.isFinite(t)) return ''
      const d = new Date(t)
      const p = (n) => String(n).padStart(2, '0')
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    }

    // 涓婂眰璺宠浆鎺ュ彛锛氶〉闈㈠彧鎶ョ洰鐨勫湴锛孌etail 缁熶竴鍒囬〉骞惰仛鐒?''
              const NAV = { handler: null, queue: [] }
    function requestJump(dest) {
      if (!dest) return
      if (NAV.handler) NAV.handler(dest)
      else NAV.queue.push(dest)
    }

    /* ------------------------------------------------ 椤甸潰鍐呰烦杞紙钀界偣瀵归綈锛?*/

    /**
     * 婊氬埌鏌愪釜鍖哄潡銆傝繖閲屽埢鎰忎笉鐢?scrollIntoView({block:'start'})锛?     *
     * 1) 璇︽儏椤甸《閮ㄩ偅鏉￠〉澶存槸 sticky 鐨勩€俿crollIntoView 鎶婂尯鍧楅《杈瑰榻愬埌婊氬姩鍖?     *    鏈€涓婇潰锛屾爣棰樻濂借椤靛ご鍘嬩綇 鈥斺€?鐪嬬潃灏辨槸銆岃烦鍋忎簡涓€澶ф埅銆嶃€?     * 2) scrollIntoView 浼氳繛甯︽粴鍔ㄦ墍鏈夊灞傚彲婊氱鍏堬紙璁剧疆寮瑰眰 + 鏂囨。灞傦級锛屽亸宸彔涓ら亶銆?     * 3) 鍖哄潡楂樺害鏄弬鏁板紓姝ユ媺鍥炴潵鎵嶅畾鐨勶紝鍒氳烦杩囧幓鏃惰繕鏄崰浣嶉珮搴︼紝钀界偣杩樹細鍐嶉銆?     *
     * 鍋氭硶锛氬彧婊氫竴涓鍣紱鍏堢矖婊氬埌鍖哄潡椤讹紝鍐嶆寜銆屽疄娴嬬殑閬尅閲忋€嶆牎涓€娆?     * 锛堥〉澶村埌搴曞惛涓嶅惛椤躲€佸惛澶氶珮锛岄兘閲忓嚭鏉ワ紝涓嶉潬鐚滐級锛涘竷灞€绋冲畾鍚庡啀琛ユ牎銆?     */
    const SCROLL_GAP = 10
    const SCROLL_NAV = { token: 0 }
    const isDocBox = (b) => b === document.scrollingElement || b === document.documentElement

    /** 最近的可滚祖先；都没有就滚文档 */
    function scrollBoxOf(el) {
      let n = el && el.parentElement
      while (n && n.nodeType === 1 && n !== document.body && n !== document.documentElement) {
        const oy = window.getComputedStyle(n).overflowY
        if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && n.scrollHeight > n.clientHeight + 1) return n
        n = n.parentElement
      }
      return document.scrollingElement || document.documentElement
    }

    /** 能放下内容的可视上边界：容器顶，或者已经吸顶的页头下沿 */
    function readTopEdge(el, box) {
      const base = isDocBox(box) ? 0 : box.getBoundingClientRect().top
      const root = (el.closest && el.closest('.dshc')) || document
      const bar = root.querySelector ? root.querySelector('.dshc-stick') : null
      if (!bar) return base
      const br = bar.getBoundingClientRect()
      // 页头贴着顶边才算遮挡；被滚走了就不占位置
      return br.top <= base + 1 ? Math.max(base, br.bottom) : base
    }

    function scrollBoxTo(box, top, behavior) {
      const t = Math.max(0, top)
      if (isDocBox(box)) window.scrollTo({ top: t, behavior })
      else if (box.scrollTo) box.scrollTo({ top: t, behavior })
      else box.scrollTop = t
    }

    /** 鎵句笉鍒板厓绱犺繑鍥?false锛岃皟鐢ㄦ柟鍙互闅斾竴浼氬効鍐嶈瘯锛堝唴瀹规槸寮傛鏉ョ殑锛?*/
    function scrollToBlock(target, opts) {
      const el = typeof target === 'string' ? document.getElementById(target) : target
      if (!el) return false
      const my = ++SCROLL_NAV.token
      const smooth = !opts || opts.smooth !== false
      const box = scrollBoxOf(el)
      // 鍏滃簳锛氬疄鍦ㄦ壘涓嶅埌鑳芥粴鐨勫鍣紙娌℃湁鍙粴绁栧厛锛屾枃妗ｄ篃涓嶈兘婊氾級锛屼氦缁欐祻瑙堝櫒鑷繁鎵?''
              const scrollable = isDocBox(box)
        ? document.documentElement.scrollHeight > window.innerHeight + 4
        : box.scrollHeight > box.clientHeight + 4
      if (!scrollable && el.scrollIntoView) {
        try { el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' }) } catch { /* ignore */ }
        return true
      }
      const nowTop = isDocBox(box) ? (window.scrollY || 0) : box.scrollTop
      const boxTop = isDocBox(box) ? 0 : box.getBoundingClientRect().top
      // 绮楁粴锛氬厛鎶婂尯鍧楅《瀵归綈鍒板鍣ㄩ《锛屼笉鐚滈〉澶村楂?''
              scrollBoxTo(box, nowTop + el.getBoundingClientRect().top - boxTop, smooth ? 'smooth' : 'auto')

      let canceled = false
      const cancel = () => { canceled = true }
      window.addEventListener('wheel', cancel, { passive: true })
      window.addEventListener('touchstart', cancel, { passive: true })
      window.addEventListener('keydown', cancel)
      const cleanup = () => {
        window.removeEventListener('wheel', cancel)
        window.removeEventListener('touchstart', cancel)
        window.removeEventListener('keydown', cancel)
      }
      const fix = () => {
        if (canceled || my !== SCROLL_NAV.token || !el.isConnected) return
        const b = scrollBoxOf(el)
        const want = readTopEdge(el, b) + SCROLL_GAP
        const delta = el.getBoundingClientRect().top - want
        if (Math.abs(delta) > 2) {
          scrollBoxTo(b, (isDocBox(b) ? (window.scrollY || 0) : b.scrollTop) + delta, 'auto')
        }
      }
      // 骞虫粦鍔ㄧ敾澶х害 300~600ms锛涗箣鍚庢寜瀹炴祴鏍′袱娆★紝椤轰究鍏滀綇寮傛闀块珮鐨勫尯鍧?      ;[480, 1000, 1600].forEach((ms) => setTimeout(fix, ms))
      setTimeout(cleanup, 1700)
      return true
    }

    /** 目标可能还没渲染出来：按 0 / 260 / 800 / 1500ms 试几次，找到就停 */
    function scrollToBlockWhenReady(id, tries) {
      const wait = [0, 260, 800, 1500]
      let done = false
      wait.slice(0, tries || wait.length).forEach((ms) => {
        setTimeout(() => {
          if (done) return
          if (scrollToBlock(id)) done = true
        }, ms)
      })
    }

    const LoadErr = ({ error, retry }) => !error ? null : h('div', { className: 'dshc-err' },
      error, ' ', retry ? h('a', { href: '#', onClick: (e) => { e.preventDefault(); retry() } }, '重试') : null)

    const ageDays = (iso) => {
      const t = Date.parse(iso)
      if (!Number.isFinite(t)) return 0
      return Math.max(0, Math.floor((Date.now() - t) / 86400000))
    }

    const ago = (iso) => {
      if (!iso) return '—'
      const t = Date.parse(iso)
      if (!Number.isFinite(t)) return '—'
      const m = Math.floor((Date.now() - t) / 60000)
      if (m < 1) return '刚刚'
      if (m < 60) return m + ' 分钟前'
      const hr = Math.floor(m / 60)
      if (hr < 24) return hr + ' 小时前'
      return Math.floor(hr / 24) + ' 天前'
    }

    /** 澶村儚鍘嬪埌 256 鐨?webp/jpeg锛屽啀瀛樺簱 */
    async function compressAvatar(file) {
      if (!file) return null
      if (!/^image\//.test(file.type || '')) throw new Error('只支持图片文件')
      const bmp = await createImageBitmap(file)
      const S = 256
      const scale = Math.min(1, S / Math.max(bmp.width, bmp.height))
      const w = Math.max(1, Math.round(bmp.width * scale))
      const hgt = Math.max(1, Math.round(bmp.height * scale))
      const cv = document.createElement('canvas')
      cv.width = w; cv.height = hgt
      cv.getContext('2d').drawImage(bmp, 0, 0, w, hgt)
      let data = cv.toDataURL('image/webp', 0.85)
      if (!data.startsWith('data:image/webp')) data = cv.toDataURL('image/jpeg', 0.85)
      return data
    }

    /* ============================================================ roster */

    /** 鍦ㄥ満鐘舵€侊細涓€寮犲崱涓婂彧鍐欎竴浠朵簨锛屽埆璁┿€岃繍琛屼腑銆嶅拰銆岀粦鐫€鍑犳銆嶆尋鍦ㄤ竴鍙ラ噷銆?*/
    function presenceOf(a) {
      // status 是用户意图真值；runtime_state=offline 只在 paused 时成立，
      // 婵€娲诲悗鑻ョ紦瀛樻病鍒峰共鍑€锛屼笉鑳藉啀褰撳皬鍗°€?''
              const st = a.status === 'soft_deleted' ? 'deleted'
        : a.status === 'paused' ? 'offline'
          : (a.runtime_state === 'offline' ? 'idle' : (a.runtime_state || 'idle'))
      const n = Number(a.bound_sessions || 0)
      if (st === 'deleted') return { key: 'deleted', label: '已删除', pill: '已删除', tone: 'bad' }
      if (st === 'offline') return { key: 'offline', label: '休眠', pill: '休眠', tone: 'warn', tip: '用户关掉的：不注入、不推送、不跳心跳' }
      if (st === 'dormant') return { key: 'dormant', label: '自动休眠', pill: '自动休眠', tone: 'warn', tip: '14 天没互动，自己退到一边（心跳照跳，很慢）' }
      if (st === 'bound' || n > 0) return { key: 'bound', label: '运行中', pill: '接着 ' + n + ' 段对话', tone: 'ok', tip: '只在这 ' + n + ' 段对话里说话，别处是普通 DSH' }
      return { key: 'idle', label: '在线 · 空闲', pill: '在线 · 还没对话', tone: null, tip: '醒着，但还没绑到任何对话' }
    }

    function CharacterCard({ a, onOpen, onExport, onDelete, onPause, featured, arrived, ov: preloaded, actions, actionsAlign, headActions }) {
      const [ov] = useAsync(
        () => preloaded ? Promise.resolve(preloaded) : call('GET', '/v1/agents/' + enc(a.id) + '/overview'),
        [a.id, preloaded ? 1 : 0])
      const o = preloaded || ov.data || {}
      const running = a.status === 'active'
      const status = o.status || (running ? 'good' : 'warn')
      const alerts = (o.alerts || []).slice(0, 2)
      const [expBusy, setExpBusy] = useState(false)
      const [expNote, setExpNote] = useState(null)
      // 鏁村崱澶囦唤锛氬叏閮ㄨ〃鎵撹繘涓€涓?zip锛屽鍏ラ偅杈瑰悆鍚屼竴涓寘
      async function doExport() {
        if (!onExport || expBusy) return
        setExpBusy(true); setExpNote(null)
        try {
          await onExport(a)
          setExpNote({ tone: 'ok', text: '已下载整卡备份包' })
          setTimeout(() => setExpNote((n) => (n && n.tone === 'ok' ? null : n)), 3200)
        } catch (e) {
          setExpNote({ tone: 'err', text: (e && e.message) || String(e) })
        } finally { setExpBusy(false) }
      }
      return h('div', { className: 'dshc-char' + (featured ? ' dshc-char--feature' : '') + (arrived ? ' dshc-char--arrive' : ''), 'data-running': running ? '1' : '0' },
        h('span', { className: 'dshc-grid', 'aria-hidden': true }),
        featured ? h('span', { className: 'dshc-char-node', 'aria-hidden': true }) : null,
        h('header', null,
          h(Avatar, { src: a.avatar, size: featured ? 72 : 44 }),
          h('div', { style: { minWidth: 0, flex: 1 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('h3', { style: featured ? { fontSize: 19, letterSpacing: .3 } : null }, a.name),
              alerts.length
                ? h('button', {
                  type: 'button',
                  onClick: () => {
                    const dest = Number(o.conflicts_open || 0) > 0 ? { tab: 'memory', focus: 'conflicts' }
                      : Number(o.unread || 0) > 0 ? { tab: 'self' } : null
                    if (dest) requestJump(dest)
                    if (onOpen) onOpen(a, running)
                  },
                  style: { background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'var(--bad)', fontSize: 12.5, fontWeight: 600 },
                }, '需处理')
                : h('span', { style: { color: 'var(--ok)', fontSize: 12.5, fontWeight: 600 } }, '良好')),
            h('div', { className: 'dshc-sub' },
              presenceOf(a).label, ' · ', a.mode === 'work' ? '工作模式' : '日常模式',
              ' · 出生 ' + Math.max(1, ageDays(a.created_at)) + ' 天',
              ' · 上次互动 ', ago(o.recent && o.recent.last_interaction) + (a.last_interaction_at ? '' : '（还没聊过）'))),
          h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, flex: '0 0 auto', paddingTop: 6 } },
            (() => {
              const p = presenceOf(a)
              return h(Pill, { tone: p.tone, title: p.tip || p.pill }, p.pill)
            })())),

        h('div', { className: 'meta' },
          h(Pill, null, AFFECT_KEY[(o.affect && o.affect.label)] || '平静'),
          h(Pill, null, '记得你 ' + (o.memory_count || 0) + ' 件事'),
          a.pending_bind ? h(Pill, { tone: 'ok', title: '下一个新建的对话会归它' }, '下一个新对话') : null,
          o.inbox && o.inbox.todo ? h(Pill, { tone: 'warn' }, '想做的事 ' + o.inbox.todo) : null,
          o.inbox && o.inbox.change ? h(Pill, { tone: 'warn' }, '想改的 ' + o.inbox.change) : null,
          headActions && headActions.length
            ? h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' } }, headActions)
            : null),

        actions
          ? (actions.length
            ? h('div', {
              className: 'acts',
              style: actionsAlign === 'end' ? { justifyContent: 'flex-end', marginTop: 16 } : null,
            }, actions)
            : null)
          : h('div', null,
            h('div', { className: 'acts' },
              h(Btn, { primary: true, onClick: () => onOpen(a, running) }, running ? '进入' : '选择并进入'),
              running && onPause
                ? h(Btn, {
                  ghost: true, onClick: () => onPause(a),
                  title: '关掉：不注入、不推送、不跳心跳',
                }, '休眠')
                : null,
              onExport
                ? h(Btn, {
                  ghost: true, disabled: expBusy, onClick: doExport,
                  title: '整卡备份包：全部表 + manifest，可以再导入回来',
                }, expBusy ? '打包中…' : '整体导出')
                : null,
              h(Btn, { ghost: true, danger: true, onClick: () => onDelete(a) }, '删除')),
            expNote
              ? h('div', {
                className: expNote.tone === 'err' ? 'dshc-err' : 'dshc-sub',
                style: expNote.tone === 'err' ? { marginTop: 8 } : { marginTop: 8, color: 'var(--ok)' },
              }, expNote.text)
              : null))
    }

    const ASCEND_CSS = "@keyframes dshcFxFlash{0%{opacity:0}20%{opacity:.2}100%{opacity:0}}\n@keyframes dshcFxRing{0%{transform:translate(-50%,-50%) scale(.22);opacity:.34}100%{transform:translate(-50%,-50%) scale(1.9);opacity:0}}\n@keyframes dshcFxScan{0%{transform:translateY(-90%);opacity:0}30%{opacity:.2}100%{transform:translateY(130%);opacity:0}}\n@keyframes dshcFxRise{0%{transform:translateY(0)}45%{transform:translateY(-5px);filter:brightness(1.1)}100%{transform:translateY(0)}}\n@keyframes dshcCharArrive{0%{transform:scale(.984);box-shadow:0 0 0 transparent}50%{transform:scale(1.005);box-shadow:0 0 20px rgba(142,166,255,.22)}100%{transform:scale(1);box-shadow:0 18px 48px -44px rgba(142,166,255,.42)}}\n.dshc-fx{position:fixed;inset:0;z-index:9999;pointer-events:none;overflow:hidden}\n.dshc-fx-flash{position:absolute;inset:0;background:radial-gradient(circle at 50% 45%, rgba(142,166,255,.22), transparent 58%);animation:dshcFxFlash .75s ease forwards}\n.dshc-fx-ring{position:absolute;left:50%;top:45%;width:52vmin;height:52vmin;border:1px solid rgba(142,166,255,.34);border-radius:50%;transform:translate(-50%,-50%);animation:dshcFxRing 1s cubic-bezier(.22,.61,.36,1) forwards}\n.dshc-fx-ring.d2{border-color:rgba(99,132,255,.24);animation-delay:.12s;width:34vmin;height:34vmin}\n.dshc-fx-scan{position:absolute;left:0;right:0;height:26%;background:linear-gradient(180deg,transparent,rgba(190,205,255,.045),transparent);animation:dshcFxScan .85s ease forwards}\n.dshc-char--feature{position:relative;overflow:hidden;border-radius:16px;\n border-color:color-mix(in srgb,var(--accent) 28%,var(--line));\n background:\n  radial-gradient(120% 90% at 6% 0%, color-mix(in srgb,var(--accent) 11%, transparent), transparent 62%),\n  radial-gradient(80% 60% at 92% 0%, rgba(77,107,254,.08), transparent 66%),\n  radial-gradient(90% 70% at 0% 100%, rgba(77,107,254,.04), transparent 72%),\n  linear-gradient(165deg,#0c1117 0%,var(--panel) 55%,#090d13 100%);\n box-shadow:0 22px 54px -44px rgba(77,107,254,.42), inset 0 1px 0 rgba(142,166,255,.08)}\n.dshc-char--feature .dshc-grid{opacity:.4}\n.dshc-char--feature::before{content:'';position:absolute;inset:0;pointer-events:none;opacity:.9;\n background:linear-gradient(180deg, rgba(142,166,255,.05), transparent 28%)}\n.dshc-char--feature::after{content:'';position:absolute;left:22px;right:22px;top:0;height:1px;pointer-events:none;\n background:linear-gradient(90deg,transparent,rgba(142,166,255,.5) 26%,rgba(142,166,255,.3) 62%,transparent)}\n.dshc-char--feature h3{font-weight:650;letter-spacing:.5px}\n.dshc-char-node{position:absolute;top:16px;right:18px;width:4px;height:4px;border-radius:50%;background:#9db1ff;box-shadow:0 0 9px 1px rgba(99,132,255,.4);opacity:.8;pointer-events:none;z-index:2}\n.dshc-char-node::after{content:'';position:absolute;right:8px;top:1px;width:14px;height:1px;background:linear-gradient(90deg,transparent,rgba(157,177,255,.45))}\n.dshc-char--arrive{animation:dshcCharArrive .95s cubic-bezier(.22,.61,.36,1)}\n.dshc-char{transition:filter .45s ease,opacity .45s ease}\n.dshc-char[data-running=\"0\"]{filter:grayscale(.62) saturate(.55) brightness(.9);opacity:.88}\n.dshc-char[data-running=\"0\"] .dshc-orb i{animation-duration:9.5s}\n.dshc-char[data-running=\"0\"] .dshc-char-node{opacity:.3}"

    function AscendFx() {
      return h('div', { className: 'dshc-fx' },
        h('div', { className: 'dshc-fx-flash' }),
        h('div', { className: 'dshc-fx-ring' }),
        h('div', { className: 'dshc-fx-ring d2' }),
        h('div', { className: 'dshc-fx-scan' }),
        h(Motes, { n: 8 }))
    }

    function CompactCard({ a, onAscend, busy }) {
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
          border: '1px solid var(--line)', borderRadius: 10, padding: '7px 10px',
          opacity: busy ? 1 : 0.72, filter: busy ? 'none' : 'grayscale(0.35)',
          color: 'var(--muted)', background: 'none',
          animation: busy ? 'dshcFxRise .6s ease' : 'none',
        },
      },
        h(Avatar, { src: a.avatar, size: 26 }),
        h('span', { style: { fontSize: 13 } }, a.name),
        h('button', {
          type: 'button', disabled: busy, onClick: () => onAscend(a),
          style: {
            marginLeft: 'auto', padding: '3px 12px', borderRadius: 999, cursor: busy ? 'default' : 'pointer',
            border: '1px solid color-mix(in srgb, var(--accent) 55%, transparent)',
            background: 'color-mix(in srgb, var(--accent) 14%, transparent)',
            color: 'var(--ink)', fontSize: 12, fontWeight: 600, letterSpacing: .3,
            opacity: busy ? 0.6 : 1,
            boxShadow: '0 0 10px color-mix(in srgb, var(--accent) 18%, transparent)',
          },
        }, busy ? '唤醒中…' : '唤醒'))
    }

    /**
     * 杩愯涓庡績璺筹細璋佸湪璺戙€佸悇鎸傚嚑娈靛璇濄€佸績璺宠烦寰楁€庝箞鏍枫€?     * 浠ュ墠杩欓噷浠€涔堥兘鐪嬩笉鍒扳€斺€斿彧鏈変竴涓叏灞€ tick锛屽仠浜嗕篃娌′汉鐭ラ亾銆?     */
    function RuntimePanel({ reload }) {
      const [rt, retry] = useAsync(() => call('GET', '/v1/runtime'), [])
      useLive(retry, 15000)
      const d = rt.data || {}
      const [cap, setCap] = useState('')
      const [saving, setSaving] = useState(false)
      const [note, setNote] = useState('')
      useEffect(() => {
        if (d.max_running != null) setCap(String(d.max_running))
      }, [d.max_running])
      const items = Array.isArray(d.agents) ? d.agents : []
      function hbLine(x) {
        const hb = x.heartbeat
        if (!hb) return '还没心跳过'
        const nowMs = Date.now()
        const ago2 = hb.last_at ? Math.round((nowMs - Number(hb.last_at)) / 1000) : null
        const next = Math.round((Number(hb.next_at) - nowMs) / 1000)
        return (ago2 == null ? '还没跳过' : ago2 + 's 前跳过（' + (hb.last_ms || 0) + 'ms）')
          + ' · 下次 ' + (next > 0 ? next + 's 后' : '已到期')
          + (hb.failures ? ' · 连续失败 ' + hb.failures + ' 次' : '')
      }
      async function saveCap() {
        if (saving) return
        setSaving(true); setNote('')
        try {
          await call('POST', '/v1/runtime/max-running', { max_running: Number(cap) || 0 }, true)
          setNote('已保存：同时最多 ' + (Number(cap) || 0) + ' 个' + (Number(cap) === 0 ? '（不限）' : ''))
          if (reload) await reload()
          await retry()
        } catch (e) { setNote('保存失败：' + (e.message || e)) } finally { setSaving(false) }
      }
      return h(Card, { style: { marginBottom: 14 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('b', { style: { fontSize: 13 } }, '运行与心跳'),
          h(Pill, { tone: d.slots_left === 0 ? 'warn' : null },
            '运行中 ' + (d.running || 0) + ' / ' + (d.max_running || 0) + (d.slots_left == null ? '' : ' · 还能开 ' + d.slots_left + ' 个')),
          h('div', { style: { flex: 1 } }),
          h(Input, {
            className: 'dshc-input', style: { width: 72 }, value: cap, inputMode: 'numeric',
            onChange: (e) => setCap(e.target.value.replace(/[^\d]/g, '')),
            title: '同时最多几个实例在跑（0 = 不限）',
          }),
          h(Btn, { ghost: true, sm: true, disabled: saving, onClick: saveCap }, saving ? '保存中…' : '保存上限')),
        note ? h('div', { className: note.startsWith('保存失败') ? 'dshc-err' : 'dshc-sub', style: { marginTop: 6 } }, note) : null,
        items.length
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 } },
            items.map((x) => h('div', {
              key: x.id,
              style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--muted)', flexWrap: 'wrap' },
            },
              h('span', { style: { color: 'var(--ink)', minWidth: 72 } }, x.name),
              h(Pill, { tone: x.runtime_state === 'bound' ? 'ok' : x.runtime_state === 'offline' ? 'warn' : null },
                x.runtime_state === 'bound' ? '接着 ' + x.bound_sessions + ' 段' : x.runtime_state === 'idle' ? '在线空闲' : x.runtime_state === 'dormant' ? '自动休眠' : '休眠'),
              h('span', { className: 'dshc-mono' }, hbLine(x)))))
          : h('div', { className: 'dshc-sub', style: { marginTop: 8 } }, '还没有意识体。'))
    }

    /**
     * 未归档的对话：DSH 侧边栏里还挂着的、没被归档的会话。
     * 按侧边栏的分支（ds / knowledge / …）分组，标题也用侧边栏那一个；
     * 没归人的挑卡归过去，已归人的也在同一列表里，随时能改。
     */
    function UnboundSessions({ agents, act, reload }) {
      const [data, retry] = useAsync(() => call('GET', '/v1/sessions?limit=60'), [])
      useLive(retry, 20000)
      const [pick, setPick] = useState({})
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState('')
      const payload = data.data || {}
      const all = (Array.isArray(payload.items) ? payload.items : []).filter((s) => s && s.session_id !== 'legacy')
      const unbound = all.filter((s) => !s.bound)
      // 宿主还没重载时这条路由不存在，返回的是空对象——别假装「都归好了」。
      const notReady = !data.loading && !data.error && !!data.data && !Array.isArray(payload.items)
      const choices = (agents || []).filter((a) => a.status !== 'soft_deleted')
      // 按分支聚合：顺序照侧边栏（group_order），未分组排最后；组内仍是最近说话的在前。
      const groups = (() => {
        const map = new Map()
        for (const s of all) {
          const name = s.workspace || s.group || '未分组'
          if (!map.has(name)) map.set(name, { name, order: Number(s.group_order) || 9999, items: [] })
          map.get(name).items.push(s)
        }
        return [...map.values()].sort((a, b) => a.order - b.order || String(a.name).localeCompare(String(b.name)))
      })()
      const timeAgo = (iso) => {
        const t = Date.parse(iso || '')
        if (!Number.isFinite(t)) return '—'
        const m = Math.floor((Date.now() - t) / 60000)
        if (m < 1) return '刚刚'
        if (m < 60) return m + ' 分钟前'
        if (m < 60 * 24) return Math.floor(m / 60) + ' 小时前'
        return Math.floor(m / 1440) + ' 天前'
      }

      async function bind(sid) {
        if (busy) return
        const aid = pick[sid] || (choices[0] && choices[0].id)
        if (!aid) { setNote('先建一张角色卡'); return }
        setBusy(sid); setNote('')
        try {
          const a = choices.find((x) => x.id === aid)
          // QQ 旧通道（qq:p: / qq:g:）的归属在 conversations 表，不能走 bindings。
          if (sid.startsWith('qq:')) {
            await act(() => call('POST', '/v1/conversations/bind', { conversation_id: sid, agent_id: aid, channel: 'qq' }, true))
          } else {
            await act(() => call('POST', '/v1/agents/' + enc(aid) + '/bind', { session_id: sid }, true))
          }
          setNote('这段对话归「' + ((a && a.name) || aid) + '」了，下一句就按它说话')
          await retry()
          if (reload) await reload()
          PRESENCE.bump()
        } catch (e) { setNote('绑定失败：' + ((e && e.message) || e)) } finally { setBusy('') }
      }

      const row = (s, isBound) => h('div', {
        key: s.session_id,
        style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', borderTop: '1px solid var(--line)', paddingTop: 8 },
      },
        h('div', { style: { minWidth: 0, flex: '1 1 220px' } },
          h('div', {
            style: { fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            // 标题跟侧边栏一致；悬停能看到第一句原文和会话 id，对不上号时好核
            title: (s.first_text && s.first_text !== s.title ? s.first_text + '\n' : '') + s.session_id,
          }, s.title),
          h('div', { className: 'dshc-sub', style: { fontSize: 11.5 } },
            (s.channel === 'qq' ? 'QQ · ' : '')
            + (isBound ? '归「' + (s.agent_name || '已删除的人') + '」 · ' : '还没归人 · ')
            + (s.turns || 0) + ' 轮 · ' + timeAgo(s.last_at))),
        h('select', {
          value: pick[s.session_id] || s.agent_id || (choices[0] ? choices[0].id : ''),
          disabled: !choices.length || busy === s.session_id,
          onChange: (e) => setPick((p) => ({ ...p, [s.session_id]: e.target.value })),
          style: {
            padding: '5px 8px', borderRadius: 8, background: 'var(--panel2)',
            color: 'var(--ink)', border: '1px solid var(--line2)', fontSize: 12,
          },
        }, choices.map((a) => h('option', { key: a.id, value: a.id }, a.name))),
        h(Btn, {
          ghost: true, sm: true, disabled: busy === s.session_id || !choices.length,
          onClick: () => bind(s.session_id),
        }, busy === s.session_id ? '绑定中…' : (isBound ? '改绑' : '归它')))

      // 一个分支一小块：标题就是侧边栏里的那个分支名，右边跟段数
      const groupBlock = (g) => h('div', {
        key: 'grp:' + g.name,
        style: { border: '1px solid var(--line)', borderRadius: 10, padding: '8px 10px 2px' },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 2 } },
          h('span', { className: 'dshc-sub', style: { fontSize: 11.5, opacity: 0.75 } }, '▸'),
          h('b', { style: { fontSize: 12.5 } }, g.name),
          h('span', { className: 'dshc-sub', style: { fontSize: 11.5 } }, g.items.length + ' 段')),
        g.items.map((s) => row(s, !!s.bound)))

      return h(Card, { style: { marginTop: 14 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('b', { style: { fontSize: 13 } }, '未归档的对话'),
          h(Pill, { tone: unbound.length ? 'warn' : null }, unbound.length
            ? unbound.length + ' 段还没归人'
            : (all.length ? all.length + ' 段都有主' : '还没有对话')),
          h('div', { style: { flex: 1 } }),
          h('span', { className: 'dshc-sub' }, '按分支分组；没主的挑卡归过去，有主的随时能改')),
        note ? h('div', {
          className: note.startsWith('绑定失败') ? 'dshc-err' : 'dshc-sub',
          style: { marginTop: 6, color: note.startsWith('绑定失败') ? null : 'var(--ok)' },
        }, note) : null,
        data.error ? h('div', { className: 'dshc-err', style: { marginTop: 8 } }, '读取会话失败：' + data.error) : null,
        notReady
          ? h('div', { className: 'dshc-sub', style: { marginTop: 8 } }, '宿主插件还是旧版：重启一次 DSH，这里才会列出会话。')
          : all.length
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 } },
            groups.map(groupBlock))
          : h('div', { className: 'dshc-sub', style: { marginTop: 8 } }, '没有未归档的对话。'))
    }

    function Roster({ agents, loading, error, reload, setAid, act }) {
      const [name, setName] = useState('')
      const [busy, setBusy] = useState(false)
      const [growing, setGrowing] = useState(false)
      const [msg, setMsg] = useState('')
      const [okMsg, setOkMsg] = useState('')
      const [ascending, setAscending] = useState('')
      const [importing, setImporting] = useState(false)
      const [importOpen, setImportOpen] = useState(false)
      const [dragOver, setDragOver] = useState(false)
      const [importErr, setImportErr] = useState('')
      const [freeText, setFreeText] = useState('')
      const [freeName, setFreeName] = useState('')
      const [freeBusy, setFreeBusy] = useState(false)
      const [freeErr, setFreeErr] = useState('')
      const [freeRes, setFreeRes] = useState(null)
      const [arrived, setArrived] = useState('')
      const live = (agents || []).filter((a) => a.status !== 'soft_deleted')
      const dead = (agents || []).filter((a) => a.status === 'soft_deleted')

      async function open(a) {
        setMsg('')
        try {
          // 选卡即启动：同时把「下一个新会话」指向它（重复调用是幂等的）
          await act(() => call('POST', '/v1/agents/' + enc(a.id) + '/activate', {}, true))
          await reload()
          PRESENCE.bump()
          setAid(a.id)
        } catch (e) { setMsg(e.message) }
      }

      async function ascend(a) {
        if (ascending) return
        setMsg('')
        setAscending(a.id)
        try {
          await act(() => call('POST', '/v1/agents/' + enc(a.id) + '/activate', {}, true))
          await new Promise((r) => setTimeout(r, 520))
          await reload()
          PRESENCE.bump()
          setArrived(a.id)
          setTimeout(() => setArrived((x) => (x === a.id ? '' : x)), 1100)
        } catch (e) { setMsg(e.message || String(e)) } finally { setAscending('') }
      }

      // 鏁村崱澶囦唤锛氬叏閮ㄨ〃鎵撹繘涓€涓?zip锛屽鍏ユ剰璇嗕綋鏃跺悆瀹冿紙璁板繂浠撳簱鐨勩€屽鍑鸿蹇嗐€嶅彧鍚蹇嗚〃锛?''
              async function exportOne(a) {
        const r = await act(() => call('GET', '/v1/agents/' + enc(a.id) + '/export'))
        if (r.encrypted) throw new Error('备份包加密了，导入要在服务端配同一个 DSHC_EXPORT_KEY')
        const name = 'consciousness-' + String(a.name || a.id) + '-' + new Date().toISOString().slice(0, 10) + '.zip'
        const link = document.createElement('a')
        link.href = 'data:application/zip;base64,' + r.zip_base64
        link.download = name
        link.click()
      }

      async function importAgentFile(file) {
        if (!file || importing) return
        setImportErr(''); setMsg(''); setOkMsg('')
        if (!/\.zip$/i.test(file.name || '')) { setImportErr('只接受 .zip 导出包'); return }
        setImporting(true)
        try {
          const bytes = new Uint8Array(await file.arrayBuffer())
          if (!(bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b)) { setImportErr('不是合法的 zip 文件'); return }
          let bin = ''
          const CH = 0x8000
          for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH))
          const r = await act(() => call('POST', '/v1/agents/import', { zip_base64: btoa(bin) }, true))
          setImportOpen(false)
          await reload()
          setOkMsg('已导入：' + (r.name || ''))
          setTimeout(() => setOkMsg(''), 3000)
        } catch (e) { setImportErr(e.message || String(e)) } finally { setImporting(false) }
      }

      async function create() {
        if (!name.trim()) {
          setMsg('先给它起个名字')
          try { document.getElementById('dshc-new-name')?.focus() } catch { /* ignore */ }
          setTimeout(() => setMsg((m) => (m === '先给它起个名字' ? '' : m)), 2500)
          return
        }
        if (live.some((x) => String(x.name || '').trim() === name.trim())) {
          setMsg('已经有同名的意识体了')
          try { document.getElementById('dshc-new-name')?.focus() } catch { /* ignore */ }
          setTimeout(() => setMsg((m) => (m === '已经有同名的意识体了' ? '' : m)), 2500)
          return
        }
        setBusy(true); setMsg('重算中…')
        try {
          const r = await act(() => call('POST', '/v1/agents', { name: name.trim() || '新意识体' }, true))
          await act(() => call('POST', '/v1/agents/' + enc(r.id) + '/activate', {}, true))
          setName('')
          await reload()
          PRESENCE.bump()
          setArrived(r.id)
          setTimeout(() => setArrived((x) => (x === r.id ? '' : x)), 1100)
          setOkMsg('已创建并唤醒')
          setTimeout(() => setOkMsg(''), 2500)
        } catch (e) { setMsg(e.message) } finally { setBusy(false) }
      }

      async function freeformImport() {
        if (freeBusy) return
        if (freeText.trim().length < 10) { setFreeErr('内容太少，至少 10 个字'); return }
        setFreeBusy(true); setFreeErr(''); setFreeRes(null)
        try {
          const r = await act(() => call('POST', '/v1/agents/import/freeform', { text: freeText.slice(0, 20000), filename: freeName }, true))
          setFreeRes(r)
          await reload()
          setOkMsg('已导入：' + r.name)
          setTimeout(() => setOkMsg(''), 4000)
        } catch (e) { setFreeErr(e.message || String(e)) } finally { setFreeBusy(false) }
      }

      async function remove(a) {
        if (!window.confirm('软删「' + a.name + '」？记忆、鱼格、情绪都会保留，7 天内可恢复。')) return
        try {
          await act(() => call('DELETE', '/v1/agents/' + enc(a.id), {}, true))
          await reload()
          PRESENCE.bump()
        } catch (e) { setMsg(e.message) }
      }

      async function pause(a) {
        setMsg('')
        try {
          await act(() => call('POST', '/v1/agents/' + enc(a.id) + '/pause', {}, true))
          await reload()
          PRESENCE.bump()
        } catch (e) { setMsg(e.message) }
      }

      // 澶у崱 = 閱掔潃锛坅ctive锛夛紱灏忓崱 = 鐢ㄦ埛浼戠湢 / 鑷姩浼戠湢銆備笉鎷垮彲鑳借繃鏈熺殑 runtime_state 鎸″睍寮€銆?''
              const wokenOf = (a) => String(a.woken_at || a.last_interaction_at || '')
      const runningCards = live.filter((a) => a.status === 'active' && presenceOf(a).key !== 'dormant')
        .sort((x, y) => wokenOf(y).localeCompare(wokenOf(x))
          || Number(y.bound_sessions || 0) - Number(x.bound_sessions || 0))
      const others = live.filter((a) => !runningCards.some((r) => r.id === a.id))
        .sort((x, y) => wokenOf(y).localeCompare(wokenOf(x)))

      return h('div', { className: 'dshc', 'data-view': 'user' },
        h(Style),
        h('style', null, VIEW_CSS),
        h('style', null, ASCEND_CSS),
        ascending ? h(AscendFx, { key: ascending }) : null,
        h('div', { className: 'dshc-hero' },
          h('span', { className: 'dshc-grid', 'aria-hidden': true }),
          h('span', { className: 'dshc-scan', 'aria-hidden': true }),
          h(Motes, { n: 12 }),
          h('div', { className: 'dshc-hero-row' },
            h('div', { className: 'dshc-id' }, h(Orb, { size: 42 }),
              h('div', null,
                h('h1', null, '意识'),
                h('div', { className: 'dshc-sub' }, '选一个角色卡，接下来新建的对话就是它。'))),
            h('div', { className: 'dshc-spacer' }),
            h('span', { className: 'dshc-sub dshc-mono' }, live.length + ' 个' + (dead.length ? ' · ' + dead.length + ' 个已删除' : '')))),

        h(Sec, { title: '新建角色卡', desc: '建好之后会立刻成为「下一个新对话」的说话对象。' },
          h(Card, null,
            h('div', { className: 'dshc-form' },
              h(Input, {
                id: 'dshc-new-name', className: 'grow', placeholder: '给它一个名字，比如「阿念」', value: name,
                onChange: (e) => setName(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter' && !busy) create() },
              }),
              h(Btn, { primary: true, disabled: busy, onClick: create }, busy ? '创建中…' : '创建并唤醒')),
            msg ? h('div', { className: 'dshc-err' }, msg) : null,
            okMsg ? h('div', { className: 'dshc-sub', style: { color: 'var(--ok)' } }, okMsg) : null)),

        h(Sec, {
          title: '角色卡',
          desc: '可以同时有好几个在运行；新对话自动归给最近唤醒的那只，老对话没归人的可以在下面手动挑。',
        },
          h(RuntimePanel, { reload }),
          loading ? h(Empty, null, '读取中…')
            : error ? h(LoadErr, { error, retry: reload })
              : live.length === 0 ? h(Empty, null, '还没有意识体。上面建一个，它才有「今天」。')
                : h('div', null,
                  runningCards.length
                    ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 14 } },
                      runningCards.map((a) => h(CharacterCard, {
                        key: a.id, a, featured: true, arrived: arrived === a.id,
                        onOpen: open, onExport: exportOne, onDelete: remove, onPause: pause,
                      })))
                    : null,
                  others.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                    others.map((a) => h(CompactCard, {
                      key: a.id, a, onAscend: ascend, busy: ascending === a.id,
                    }))) : null),
          h('div', { style: { marginTop: 16, display: 'flex', justifyContent: 'flex-end' } },
            h(Btn, { primary: true, onClick: () => { setImportErr(''); setFreeErr(''); setFreeRes(null); setImportOpen(true) } }, '导入意识体')),
          h(UnboundSessions, { agents: live, act, reload }),
          importOpen ? h('div', { style: { position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(3,6,12,.62)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 } },
            h('div', { style: { width: '100%', maxWidth: 780, maxHeight: '86vh', overflow: 'auto', background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 16, padding: 18, boxShadow: '0 30px 80px -40px rgba(0,0,0,.8)' } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 } },
                h('b', { style: { fontSize: 15, letterSpacing: .3 } }, '导入意识'),
                h('div', { style: { flex: 1 } }),
                h(Btn, { ghost: true, onClick: () => setImportOpen(false) }, '关闭')),
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 } },
                h('div', { style: { border: '1px solid var(--line)', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 240, background: 'color-mix(in srgb, var(--panel) 70%, transparent)' } },
                  h('div', { style: { fontSize: 13.5, fontWeight: 650, letterSpacing: .3 } }, '规范导入'),
                  h('div', { className: 'dshc-sub' }, '本插件导出的 zip，整卡恢复'),
                  h('div', {
                    onDragOver: (e) => { e.preventDefault(); setDragOver(true) },
                    onDragLeave: () => setDragOver(false),
                    onDrop: (e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) importAgentFile(f) },
                    style: {
                      padding: '18px 14px', textAlign: 'center', borderRadius: 12, flex: 1,
                      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
                      border: '1px dashed ' + (dragOver ? 'var(--accent)' : 'var(--line2)'),
                      background: dragOver ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'transparent',
                      transition: 'border-color .15s, background .15s',
                    },
                  },
                    h('div', { style: { fontSize: 13, opacity: .85 } }, importing ? '正在导入…' : '把 zip 拖到这里'),
                    h('div', { className: 'dshc-sub' }, '或'),
                    h('label', { className: 'dshc-btn dshc-btn--ghost', style: { display: 'inline-block', cursor: 'pointer' } },
                      '选择文件',
                      h('input', {
                        type: 'file', accept: '.zip,application/zip', disabled: importing,
                        style: { display: 'none' },
                        onChange: (e) => { const f = e.target.files && e.target.files[0]; if (f) importAgentFile(f); e.target.value = '' },
                      }))),
                  importErr ? h('div', { className: 'dshc-err' }, importErr) : null),
                h('div', { style: { border: '1px solid var(--line)', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 240, background: 'color-mix(in srgb, var(--panel) 70%, transparent)' } },
                  h('div', { style: { fontSize: 13.5, fontWeight: 650, letterSpacing: .3 } }, '随意导入'),
                  h('div', { className: 'dshc-sub' }, '任意文本，交给大模型整理成模板'),
                  h('textarea', {
                    value: freeText, rows: 5, disabled: freeBusy,
                    placeholder: '把文件拖到这里，或直接粘贴内容…',
                    onChange: (e) => setFreeText(e.target.value),
                    onDragOver: (e) => e.preventDefault(),
                    onDrop: async (e) => {
                      e.preventDefault()
                      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
                      if (!f) return
                      setFreeName(f.name); setFreeErr('')
                      try { setFreeText(String(await f.text()).slice(0, 20000)) } catch { setFreeErr('读不出文本内容') }
                    },
                    style: { width: '100%', resize: 'vertical', minHeight: 96, background: 'transparent', color: 'var(--ink)', border: '1px solid var(--line2)', borderRadius: 10, padding: 10, font: 'inherit' },
                  }),
                  h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                    h('label', { className: 'dshc-btn dshc-btn--ghost', style: { display: 'inline-block', cursor: 'pointer' } },
                      '选择文件',
                      h('input', {
                        type: 'file', disabled: freeBusy, style: { display: 'none' },
                        onChange: async (e) => {
                          const f = e.target.files && e.target.files[0]
                          if (f) { setFreeName(f.name); setFreeErr(''); try { setFreeText(String(await f.text()).slice(0, 20000)) } catch { setFreeErr('读不出文本内容') } }
                          e.target.value = ''
                        },
                      })),
                    h('div', { style: { flex: 1 } }),
                    h(Btn, { primary: true, disabled: freeBusy || freeText.trim().length < 10, onClick: freeformImport },
                      freeBusy ? '整理中…' : '整理并导入')),
                  freeErr ? h('div', { className: 'dshc-err' }, freeErr) : null,
                  freeRes ? h('div', { className: 'dshc-note', style: { marginTop: 2 } },
                    '采用 ' + freeRes.adoption.adopted + '/' + freeRes.adoption.total + ' 项 · ' + Math.round(freeRes.adoption.rate * 100) + '% · 继承约 ' + freeRes.adoption.chars + ' 字',
                    h('div', { className: 'dshc-sub' },
                      '记忆 ' + freeRes.imported.memory + ' · 鱼格 ' + freeRes.imported.persona + ' · 偏好 ' + freeRes.imported.preferences + ' · 禁忌 ' + freeRes.imported.taboos + ' · 关系 ' + freeRes.imported.relations)) : null)))
            ) : null),

        dead.length ? h(Sec, { title: '已删除', desc: '7 天冷静期内可恢复，到期后主存与索引一起清除。' },
          h('div', { className: 'dshc-list' }, dead.map((a) => h('div', {
            key: a.id, className: 'dshc-item', style: { opacity: 0.7 },
          },
            h('div', { className: 't' }, a.name),
            h('div', { className: 'm' }, '软删 · ' + (a.deleted_at || '').slice(0, 10)),
            h(Btn, {
              onClick: async () => { await act(() => call('POST', '/v1/agents/' + enc(a.id) + '/restore', {}, true)); await reload() },
            }, '恢复'))))) : null)
    }

