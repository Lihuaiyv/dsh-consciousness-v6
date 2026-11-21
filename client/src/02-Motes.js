    /* ============================================================== atoms */

    const Style = () => h('style', { dangerouslySetInnerHTML: { __html: CSS } })

    function Motes({ n = 9 }) {
      const kids = []
      for (let i = 0; i < n; i++) {
        const s = 2 + (i % 3)
        kids.push(h('span', {
          key: i,
          style: {
            left: (6 + (i * 97) % 88) + '%', bottom: (-6 + (i * 37) % 30) + 'px',
            width: s + 'px', height: s + 'px', '--d': (9 + (i % 5) * 2.4) + 's', '--k': (-(i * 1.7)).toFixed(1) + 's',
          },
        }))
      }
      return h('div', { className: 'dshc-motes', 'aria-hidden': true }, kids)
    }

    const Orb = ({ size = 34 }) => h('span', { className: 'dshc-orb', style: { width: size, height: size } },
      h('i'), h('i'), h('i'),
      h('b', { style: { width: Math.round(size * 0.52), height: Math.round(size * 0.52) } }))

    /* ---------------- 鎯呯华 →澶栬 ----------------
     * 一条连续的光谱，不是几档预设：
     *   绉瀬 = 寰€涓婇銆佸揩銆佷寒銆佽竟涓婂啋閲戣壊鏄熺偣锛堟椿娉硷級锛?     *   娑堟瀬 = 鍐风伆銆佹殫銆佹參鎱㈠線涓嬪潬銆佸洓鍛ㄥ帇涓€灞傛殫锛堟秷娌夛級锛?     *   0 闄勮繎 = 寰堟參鍦拌崱鐫€锛屼笉娲绘臣涔熶笉娌夈€?     * 寮哄害 ins 鍙斁澶?缂╁皬骞呭害锛屼笉鏀规柟鍚戙€?     */
    const EMO_COLD = [96, 108, 142]
    const EMO_MID = [116, 172, 216]
    const EMO_WARM = [126, 224, 255]
    const EMO_SPARK = [255, 222, 148]
    const emoRgb = (a, b, k) => {
      const t = Math.max(0, Math.min(1, k))
      return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t))
    }
    const emoCss = (rgb, alpha) =>
      'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + (alpha === undefined ? 1 : alpha) + ')'

    function emoLook(tV, ins) {
      const v = Math.max(-1, Math.min(1, Number(tV) || 0))
      const i = Math.max(0, Math.min(1, Number(ins) || 0))
      const up = v >= 0
      /* e = 有多「活」：正向、且强度够大才是满的；负向只会更接近 0 */
      const e = Math.max(0, Math.min(1, ((v + 1) / 2) * (0.6 + 0.4 * i) + (up ? 0.08 * i : 0)))
      const base = up ? emoRgb(EMO_MID, EMO_WARM, v) : emoRgb(EMO_MID, EMO_COLD, -v)
      /* 主色走青→灰；金色只留给星点和右上角那团暖光，不去染线条 */
      const accent = base
      return {
        v,
        up,
        e,
        line: emoCss(accent),
        glow: emoCss(accent, (0.14 + 0.32 * e).toFixed(3)),
        glow2: emoCss(up ? EMO_SPARK : base, (0.05 + 0.18 * e).toFixed(3)),
        dot: emoCss(accent, 0.95),
        spark: emoCss(EMO_SPARK),
        drift: (18 - 9.5 * e).toFixed(2) + 's',
        moteD: up ? 9.8 - 4.6 * e : 10.5 + 5.2 * (1 - e),
        ringD: 3.2 + 4.4 * (1 - e) * (1 - e),
        beat: 4.6 - 2.4 * e,
        beacon: 4.8 - 2.4 * e,
        sparks: e > 0.5 ? Math.round(1 + ((e - 0.5) / 0.5) * 5) : 0,
        vig: v < 0 ? Math.min(0.72, -v * 0.72 + 0.08) : 0,
        textGlow: emoCss(accent, (0.16 + 0.34 * e).toFixed(3)),
        coreFilter: 'saturate(' + (0.5 + 0.7 * e).toFixed(2) + ') brightness(' + (0.8 + 0.3 * e).toFixed(2) + ')',
        bodyFilter: 'saturate(' + (0.58 + 0.42 * e + (up ? 0.12 * e : 0)).toFixed(2)
          + ') brightness(' + (0.87 + 0.13 * e).toFixed(2) + ')',
        ring: (0.4 + 0.55 * e).toFixed(2),
        bar: 'linear-gradient(90deg,' + emoCss(base, 0.35) + ',' + emoCss(accent, 0.92) + ')',
      }
    }

    /** 鍗＄墖閲岄偅灞備細鍛煎惛鐨勬皵锛氫袱鍥㈡紓绉荤殑鍏?+ 寰€涓?寰€涓嬭蛋鐨勫井灏?+ 绉瀬鏃舵墠鍐掔殑鏄熺偣 */
    function AffectAura({ look }) {
      const motes = []
      for (let i = 0; i < 13; i++) {
        const s = 2 + (i % 3)
        const d = look.moteD * (0.72 + ((i * 13) % 60) / 100)
        motes.push(h('span', {
          key: 'm' + i,
          className: 'dshc-emo-mote',
          'data-up': look.up ? '1' : '0',
          style: {
            left: (4 + ((i * 76 + 11) % 90)) + '%',
            [look.up ? 'bottom' : 'top']: (-6 + ((i * 31) % 22)) + '%',
            width: s + 'px', height: s + 'px',
            '--d': d.toFixed(2) + 's',
            '--k': (-(i * 1.37)).toFixed(2) + 's',
            '--o': (0.22 + (i % 4) * 0.12).toFixed(2),
            '--sx': ((i % 2 ? 1 : -1) * (4 + ((i * 3) % 9))) + 'px',
            '--sx2': ((i % 2 ? -1 : 1) * (3 + ((i * 5) % 7))) + 'px',
          },
        }))
      }
      const tw = []
      for (let i = 0; i < look.sparks; i++) {
        tw.push(h('span', {
          key: 't' + i,
          className: 'dshc-emo-twinkle',
          style: {
            left: (2 + ((i * 41 + 11) % 38)) + '%',
            top: (4 + ((i * 53 + 7) % 34)) + '%',
            '--d': (2.4 + (i % 3) * 0.85).toFixed(2) + 's',
            '--k': (-(i * 1.9)).toFixed(2) + 's',
          },
        }))
      }
      return h('div', { className: 'dshc-emo-aura', 'aria-hidden': true },
        h('i', { className: 'dshc-emo-glow' }),
        h('i', { className: 'dshc-emo-glow d2' }),
        look.vig > 0.01 ? h('i', { className: 'dshc-emo-vignette', style: { opacity: look.vig.toFixed(2) } }) : null,
        motes,
        tw)
    }

    /** 鍚屼竴棰楃悆锛氱Н鏋佹椂涓€鍦堝湀鐐稿緱蹇€佹牳蹇冧寒锛涙秷鏋佹椂鎱㈡參娑ㄣ€佸彂鐏?*/
    const AffectOrb = ({ size = 44, look }) => {
      const d = look.ringD
      return h('span', {
        className: 'dshc-orb dshc-emo-orb',
        style: { width: size, height: size, '--accent': look.line, '--emo-ring': look.ring },
      },
        [0, 1, 2].map((i) => h('i', {
          key: i,
          style: {
            animationDuration: d.toFixed(2) + 's',
            animationDelay: ((d / 3) * i).toFixed(2) + 's',
          },
        })),
        h('b', {
          className: 'dshc-emo-core',
          style: {
            width: Math.round(size * 0.52),
            height: Math.round(size * 0.52),
            '--emo-beat': look.beat.toFixed(2) + 's',
            filter: look.coreFilter,
          },
        }))
    }

    /**
     * 鏁板瓧婊氬姩锛氱洰鏍囧€煎埌浣嶆椂鏁颁竴閬嶏紙缂撳嚭锛夈€?     * 銆屽噺灏戝姩鎬併€嶆垨娌℃湁 rAF 鐨勭幆澧冪洿鎺ヨ惤缁堝€硷紝缁濅笉鎶?0 鐣欏湪灞忓箷涓娿€?     */
    function useCountUp(target, ms = 900) {
      const to = Number(target) || 0
      const [n, setN] = useState(0)
      useEffect(() => {
        let reduce = false
        try { reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) } catch { /* ignore */ }
        if (reduce || !to) { setN(to); return }
        const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16)
        const unframe = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout
        let stop = false
        let raf = 0
        const t0 = Date.now()
        const step = () => {
          if (stop) return
          const k = Math.min(1, (Date.now() - t0) / ms)
          setN(to * (1 - Math.pow(1 - k, 3)))
          if (k < 1) raf = frame(step)
        }
        raf = frame(step)
        return () => { stop = true; unframe(raf) }
      }, [to, ms])
      return n
    }

    /** 璁板繂浠撳簱鐨勯棬鐗岋細淇濋櫓鏌?+ 杞洏锛屽闈竴鍦堝懠鍚哥殑鍏夌幆 */
    const VaultMark = ({ size = 32 }) => h('span', {
      className: 'dshc-vault-mark', style: { width: size, height: size }, 'aria-hidden': true,
    },
      h('i'),
      h('svg', { viewBox: '0 0 24 24', width: Math.round(size * 0.6), height: Math.round(size * 0.6) },
        h('rect', { x: 3.6, y: 4.4, width: 16.8, height: 15.2, rx: 3.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, opacity: 0.9 }),
        h('circle', { cx: 12, cy: 12, r: 3.1, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: 'M12 8.9V7.5M12 15.1v1.4M8.9 12H7.5M15.1 12h1.4', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', opacity: 0.72 })))

    // 六个分区从亮到淡：越靠后越是「压箱底」的存量
    const VAULT_TONE = [0, 82, 66, 52, 38, 26]
    const vaultTone = (i) => 'color-mix(in srgb,var(--accent) ' + VAULT_TONE[i % VAULT_TONE.length] + '%,transparent)'

    const VIEW_CSS = ".dshc[data-view=\"user\"] .dshc-sec h2{font-size:16px}\n.dshc[data-view=\"user\"] .dshc-sub{font-size:12.5px;opacity:.8}\n.dshc[data-view=\"user\"] .dshc-card{border-radius:15px}\n.dshc[data-view=\"tech\"] .dshc-card{background:color-mix(in srgb,var(--panel) 55%,transparent)}\n.dshc[data-view=\"tech\"] .dshc-sec>header .bar{box-shadow:0 0 8px color-mix(in srgb,var(--accent) 45%,transparent)}\n.dshc[data-view=\"tech\"] .dshc-sec h2{letter-spacing:.4px}"

    function Sparkline({ data, height = 44, tone }) {
      const vals = (data || []).map(Number).filter((n) => Number.isFinite(n))
      if (vals.length < 2) return h('div', { className: 'dshc-sub', style: { padding: '10px 0' } }, '数据还不够，再聊几句就有曲线了。')
      const width = 280
      const max = Math.max(...vals)
      const min = Math.min(...vals)
      const span = Math.max(1e-6, max - min)
      const pts = vals.map((v, i) => [(i / (vals.length - 1)) * width, height - ((v - min) / span) * (height - 8) - 4])
      return h('svg', { width: '100%', height, viewBox: '0 0 ' + width + ' ' + height, preserveAspectRatio: 'none' },
        h('polyline', {
          points: '0,' + height + ' ' + pts.map((p) => p.join(',')).join(' ') + ' ' + width + ',' + height,
          fill: 'color-mix(in srgb, ' + (tone || 'var(--accent)') + ' 12%, transparent)', stroke: 'none',
        }),
        h('polyline', {
          points: pts.map((p) => p.join(',')).join(' '), fill: 'none',
          stroke: tone || 'var(--accent)', strokeWidth: 1.6, strokeLinejoin: 'round', strokeLinecap: 'round', opacity: 0.85,
        }))
    }

    /*
     * 鎯呯华璧板娍锛氱旱杞?-1 ~ +1锛堢湡鐢诲埢搴︾嚎锛夛紝妯酱鏄湡鏃堕棿锛堢湡鐢绘椂闂村埢搴︼級銆?     * 鐧界嚎鏄參鎯呯华杩欎竴绋嬫€庝箞璧扮殑锛涘彸绔偅涓摑鐐规槸姝ゅ埢鐨勫揩鎯呯华锛屽熬宸存槸鍒氭墠鐨勪綑娓┿€?     * 绐楀彛閲岃繕娌¤褰曠殑閭ｄ竴娈电敾鏂滅汗鈥斺€斾笉鎷夋洸绾垮幓濉紝涔熶笉鍋囪鏈夋暟鎹€?     */
    const TR_Y = [1, 0.5, 0, -0.5, -1]
    const trP2 = (n) => (Number(n) < 10 ? '0' + Number(n) : '' + Number(n))

    /** 鏍囬涓嬮潰閭ｈ锛氭鍒荤Н鏋佽繕鏄秷鏋併€佸揩鎯呯华鐢变粈涔堟嫾鍑烘潵锛堟儏缁悕鐪嬪崱閲岄偅涓ぇ瀛楋紝涓嶉噸澶嶏級銆?     *  銆屾鍒汇€嶄紭鍏堢敤鎺ュ彛鐜扮畻鐨?v3锛氳蛋鍔挎渶鍚庝竴鐐规槸閲囨牱鏃剁殑鍊硷紝蹇儏缁細鎸夊垎閽熷洖钀斤紝
     *  涓よ€呭樊涓€鐐瑰氨浼氳鏍囬鍜屽崱閲岀殑銆屾鍒汇€嶅涓嶄笂銆?*/
    function TrendNow({ data, raw, cur }) {
      const pts = (data && data.points) || []
      let last = null
      for (let i = pts.length - 1; i >= 0; i--) if (Number.isFinite(Number(pts[i].f))) { last = pts[i]; break }
      if (!last) return h('span', { style: { opacity: 0.55 } }, '此刻还没有记录')
      const v3 = (cur && cur.v3) || null
      const v4 = (cur && cur.v4) || null
      const live = !!v3 && Number.isFinite(Number(v3.total))
      const hasV4 = !!v4 && Number.isFinite(Number(v4.v))
      const fV = hasV4 ? Number(v4.v) : (Number.isFinite(Number(v3 && v3.fast)) ? Number(v3.fast) : Number(last.f) || 0)
      const tV = live ? Number(v3.total)
        : (Number.isFinite(Number(last.t)) ? Number(last.t) : (Number(last.s) || 0) + 0.35 * fV)
      const pos = tV >= 0
      const sg = (x) => (Number(x) >= 0 ? '+' : '') + Number(x).toFixed(2)
      const fsV = last.fs === null || last.fs === undefined ? null : Number(last.fs)
      const feV = last.fe === null || last.fe === undefined ? null : Number(last.fe)
      /* 鎷嗛」瑕佽兘鍔犲緱鍥炲幓鎵嶅啓锛氭棫閲囨牱閲岀殑銆岃嚜宸?+ 鍏辨儏銆嶅彲鑳藉凡缁忓涓嶄笂鍥炶惤鍚庣殑蹇儏缁?*/
      const decomp = !hasV4 && fsV !== null && feV !== null && Math.abs(fsV + feV - fV) <= 0.02
      const rawName = raw && raw !== last.lb ? (AFFECT_KEY[raw] || raw) : ''
      return h('span', { style: { display: 'inline-flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '0 9px' } },
        h('b', { style: { fontWeight: 600, color: pos ? '#7fd8ff' : '#ff9b9b' } }, (pos ? '积极' : '消极') + ' ' + sg(tV)),
        h('span', { style: { opacity: 0.72 } },
          (hasV4 ? '当场 ' : '快情绪 ') + sg(fV) + (decomp ? ' = 自己 ' + sg(fsV) + ' + 共情 ' + sg(feV) : '')),
        rawName ? h('span', { style: { opacity: 0.55 } }, '· 这一句被判断成「' + rawName + '」') : null)
    }

    function TrendChart({ data, height = 132, look }) {
      const [tip, setTip] = useState(false)
      const pts = (data && data.points) || []
      const W = 560
      const H = height
      const from = (data && Date.parse(data.from)) || (pts.length ? pts[0].at : Date.now())
      const to = (data && Date.parse(data.to)) || (pts.length ? pts[pts.length - 1].at : Date.now())
      const span = Math.max(60000, to - from)
      const PADT = 7
      const PADB = 7
      const X = (ms) => ((ms - from) / span) * W
      const Y = (v) => PADT + (1 - (Math.max(-1, Math.min(1, Number(v) || 0)) + 1) / 2) * (H - PADT - PADB)
      const t0 = pts.length ? pts[0].at : to
      const t1 = pts.length ? pts[pts.length - 1].at : to
      const dataSpan = Math.max(60000, t1 - t0)
      /* 按「这段在屏幕上有多宽」决定切几个桶：窗口拉得再大，曲线也不会糊成一根毛 */
      const visW = Math.max(2, (dataSpan / span) * W)
      const nb = Math.max(2, Math.min(320, Math.round(visW / 2)))
      const step = dataSpan / nb
      const bucket = (pick, fix) => {
        const raw = []
        for (let i = 0; i < nb; i++) {
          const a0 = t0 + i * step
          let sum = 0
          let n = 0
          for (const p of pts) if (p.at >= a0 && p.at < a0 + step) { sum += Number(pick(p)) || 0; n++ }
          raw.push(n ? sum / n : null)
        }
        /* 绌烘《涓嶇‖鎷戒笂涓€涓€硷紙閭ｆ牱鐢诲嚭鏉ユ槸鏂瑰潡锛夛細鍦ㄥ墠鍚庝袱涓湡鏈夋暟鐨勬《涔嬮棿鎷夌洿绾?*/
        const filled = new Array(nb).fill(null)
        let prev = -1
        for (let i = 0; i < nb; i++) {
          if (raw[i] !== null) { filled[i] = raw[i]; prev = i; continue }
          let next = -1
          for (let j = i + 1; j < nb; j++) if (raw[j] !== null) { next = j; break }
          if (prev < 0) { if (next >= 0) filled[i] = raw[next] }
          else if (next < 0) filled[i] = raw[prev]
          else filled[i] = raw[prev] + (raw[next] - raw[prev]) * ((i - prev) / (next - prev))
        }
        /* 绌烘。閲岃鍑轰綅缃細閭ｆ褰㈢姸鐢辨湇鍔＄鐨勬帹婕旀洸绾跨粰锛屼笉鍦ㄧ洿绾夸笂纭媺銆?           鎹㈠湪纾ㄥ钩涔嬪墠锛屽墠鍚庝袱涓《杩樿兘鎶婅繖鏍圭嚎鍜屾洸绾挎帴涓婏紝鎺ョ紳灏变笉浼氳烦銆?*/
        if (fix) {
          for (let i = 0; i < nb; i++) {
            const v = fix(t0 + i * step + step / 2)
            if (v !== null && v !== undefined) filled[i] = v
          }
        }
        const out = []
        for (let i = 0; i < nb; i++) if (filled[i] !== null) out.push({ at: t0 + i * step + step / 2, v: filled[i] })
        /* 鍐嶈繃涓€閬嶉偦鍩燂細鎱㈡儏缁竴姝ヤ竴璺筹紝寰楃（鎴愬潯锛屼笉鐒跺氨鏄彴闃躲€? 鐐规牳 = 鍓嶅悗鍚?3 涓《 */
        const w = [1, 2, 4, 6, 4, 2, 1]
        const sm = out.map((p, i) => {
          let acc = 0
          let c = 0
          for (let k = -3; k <= 3; k++) {
            const q = out[i + k]
            if (!q) continue
            acc += q.v * w[k + 3]
            c += w[k + 3]
          }
          return { at: p.at, v: acc / c }
        })
        if (sm.length === 1) sm.push({ at: t1, v: sm[0].v })
        return sm
      }
      /* 平滑：Catmull-Rom 转三次贝塞尔，不折角 */
      const curve = (seq, fx, fy) => {
        let d = 'M' + fx(seq[0]).toFixed(1) + ',' + fy(seq[0]).toFixed(1)
        for (let i = 0; i < seq.length - 1; i++) {
          const p0 = seq[Math.max(0, i - 1)]
          const p1 = seq[i]
          const p2 = seq[i + 1]
          const p3 = seq[Math.min(seq.length - 1, i + 2)]
          const x1 = fx(p1)
          const y1 = fy(p1)
          const x2 = fx(p2)
          const y2 = fy(p2)
          d += 'C' + (x1 + (x2 - fx(p0)) / 6).toFixed(1) + ',' + (y1 + (y2 - fy(p0)) / 6).toFixed(1)
            + ' ' + (x2 - (fx(p3) - x1) / 6).toFixed(1) + ',' + (y2 - (fy(p3) - y1) / 6).toFixed(1)
            + ' ' + x2.toFixed(1) + ',' + y2.toFixed(1)
        }
        return d
      }
      const hasLine = pts.length >= 2
      /* 这段在屏幕上不到 8 像素宽（比如只有几天记录却看一年），就别画线了，画出来是根竖刺 */
      const drawLine = hasLine && visW >= 8
      /* 绌烘。 →鍥炶惤鏇茬嚎锛氭湇鍔＄绠楀ソ褰㈢姸锛岃繖閲屽彧璐熻矗鐢汇€?         sleep = 鐫＄潃/涓嶅湪锛堝帇娣★級锛宺est = 閱掔潃浣嗘柇浜嗗崄鍒嗛挓浠ヤ笂锛堟洿娣★級銆?*/
      const sleeps = (data && data.sleep) || []
      const rests = (data && data.rest) || []
      const toRange = (s) => ({ aMs: Date.parse(s.from), bMs: Date.parse(s.to) })
      /* 长空档数组里其实混着两种：真睡着（kind=sleep）和白天超过三小时的「不在」（kind=away）。
         只有真睡着的才画成「睡」那层更亮的淡色；「不在」跟短断聊一样，画最淡的那层。 */
      const isSleepItem = (s) => String((s && s.kind) || 'sleep') !== 'away'
      const sleepItems = sleeps.filter(isSleepItem)
      const awayItems = sleeps.filter((s) => String((s && s.kind) || '') === 'away')
      const inRange = (g) => Number.isFinite(g.aMs) && Number.isFinite(g.bMs) && g.bMs > g.aMs
      const sleepRanges = sleepItems.map(toRange).filter(inRange)
      const restRanges = rests.map(toRange).concat(awayItems.map(toRange)).filter(inRange)
      const modeAt = (ms) => (sleepRanges.some((g) => ms > g.aMs && ms < g.bMs) ? 'sleep'
        : (restRanges.some((g) => ms > g.aMs && ms < g.bMs) ? 'rest' : 'live'))
      /* 姣忔绌烘。鎷兼垚銆岃捣鐐?→鎺ㄦ紨鏇茬嚎 →涓嬩竴涓湡璇绘暟銆嶄竴鏉＄偣鍒椼€?         涓荤嚎涔熻蛋杩欎唤鐐癸紝鎵€浠ユ贰鐨勯偅鎴拰浜殑閭ｆ埅鏄悓涓€鏍圭嚎锛屾帴缂濆涓嶄細涓€鏍瑰仠鍦ㄨ繖銆佷竴鏍逛粠鍒璧枫€?*/
      const gapSeries = [...sleeps, ...rests].map((s) => {
        const list = [{ at: Date.parse(s.from), v: Number(s.s0) }]
        for (const p of s.curve || []) list.push({ at: Number(p.at), v: Number(p.s) })
        if (Number.isFinite(Number(s.actual))) list.push({ at: Date.parse(s.to), v: Number(s.actual) })
        return list
          .filter((p) => Number.isFinite(p.at) && Number.isFinite(p.v))
          .sort((a, b) => a.at - b.at)
      }).filter((l) => l.length >= 2)
      /* 绌烘。閲岀殑鍊硷細鍦ㄦ帹婕旀洸绾夸笂鎸夋椂闂寸嚎鎬у彇锛涗笉鍦ㄤ换浣曠┖妗ｉ噷灏辫繑鍥?null锛堥偅鐢ㄧ湡璇绘暟锛?*/
      const restValAt = (ms) => {
        for (const list of gapSeries) {
          if (ms < list[0].at || ms > list[list.length - 1].at) continue
          for (let i = 1; i < list.length; i++) {
            if (ms <= list[i].at) {
              const a = list[i - 1]
              const b = list[i]
              const u = (ms - a.at) / (b.at - a.at || 1)
              return a.v + (b.v - a.v) * u
            }
          }
        }
        return null
      }
      const rows = hasLine ? bucket((p) => p.s, restValAt) : []
      /* 姘翠綅锛氬簳鑹蹭笁娈靛彔鍑烘潵鐨勯偅鏉＄嚎锛堟寮忔參娉?+ 鏃ヨ妭寰?+ 绱Н璐熻嵎锛夈€?         鎱㈡儏缁槸姘撮潰锛屾按浣嶆槸瀹冭鍘荤殑鍦版柟锛涗袱鏉℃憜鍦ㄤ竴璧锋墠鐪嬪緱鍑恒€岃皝鍦ㄦ嫋璋併€嶃€?*/
      const hasB = pts.some((p) => Number.isFinite(Number(p.b)))
      const bRows = hasLine && hasB ? bucket((p) => p.b) : []
      const gxOf = (p) => X(p.at)
      const gyOf = (p) => Y(p.v)
      const waterD = drawLine && bRows.length >= 2 ? curve(bRows, gxOf, gyOf) : ''
      /* 鎶婃參鎯呯华閭ｆ潯绾挎寜銆屽疄 / 鐭┖妗?/ 鐫＄潃銆嶅垏鎴愬嚑娈碉細杈圭晫鐐逛袱杈瑰叡鐢紝鎺ョ紳澶勭湅涓嶅嚭鏂ご */
      const runs = []
      if (drawLine && rows.length >= 2) {
        let cur = [rows[0]]
        let curMode = modeAt((rows[0].at + rows[1].at) / 2)
        for (let i = 1; i < rows.length; i++) {
          const mode = modeAt((rows[i - 1].at + rows[i].at) / 2)
          if (mode === curMode) { cur.push(rows[i]); continue }
          runs.push({ mode: curMode, pts: cur })
          cur = [rows[i - 1], rows[i]]
          curMode = mode
        }
        runs.push({ mode: curMode, pts: cur })
      }
      const liveRuns = runs.filter((r) => r.mode === 'live' && r.pts.length >= 2)
      const slowD = liveRuns.map((r) => curve(r.pts, gxOf, gyOf)).join(' ')
      /* 鏁存潯绾垮厛鏈€娣＄敾涓€閬嶏紙鍚煭绌烘。锛夛細瀹冨拰浜殑鏄悓涓€浠界偣銆佸悓涓€鏉℃洸绾裤€?         鐭┖妗ｉ偅鎴潬杩欎竴灞傦紝鐫＄潃閭ｆ埅鍐嶅彔涓€灞傛洿浜竴鐐圭殑娣¤壊銆?*/
      const restD = drawLine && rows.length >= 2 && runs.some((r) => r.mode !== 'live')
        ? curve(rows, gxOf, gyOf)
        : ''
      const sleepD = drawLine && rows.length >= 2 && runs.some((r) => r.mode === 'sleep')
        ? runs.filter((r) => r.mode === 'sleep').map((r) => curve(r.pts, gxOf, gyOf)).join(' ')
        : ''
      const areaD = liveRuns.length
        ? liveRuns.map((r) => curve(r.pts, gxOf, gyOf)
          + 'L' + X(r.pts[r.pts.length - 1].at).toFixed(1) + ',' + H
          + ' L' + gxOf(r.pts[0]).toFixed(1) + ',' + H + ' Z').join(' ')
        : ''
      const hasF = (p) => Number.isFinite(Number(p.f))
      const totalOfP = (p) => (Number.isFinite(Number(p.t))
        ? Number(p.t)
        : Math.max(-1, Math.min(1, (Number(p.s) || 0) + 0.35 * (Number(p.f) || 0))))
      /* 蹇儏缁偅涓€鍥㈡寕鍦ㄦ渶鍚庝竴涓湡鏈夎鏁扮殑鐐逛笂锛涢挸浣嶆墦婊＄殑鐐逛笉绠楄鏁?*/
      let last = null
      for (let i = pts.length - 1; i >= 0; i--) if (hasF(pts[i])) { last = pts[i]; break }
      let nx = 0
      let ny = 0
      let sy = 0
      let tailD = ''
      const ghosts = []
      const sparks = []
      if (last) {
        nx = X(last.at)
        ny = Y(totalOfP(last))
        sy = Y(last.s)
        /* 灏惧反 = 杩欎竴娈甸噷鏈€鍚庨偅涓€灏忔埅蹇儏缁細绐楀彛涓€鍙樺畠涔熻窡鐫€鍙橈紱涓€澶╄繖绉嶇煭绐楀彛灏惧反缁欓暱鐐癸紝涓嶇劧鐪嬩笉鍑鸿捣浼?*/
        const tailFrac = span <= 2 * 86400000 ? 0.3 : 0.18
        const tailFrom = Math.max(t0, last.at - Math.min(span * tailFrac, dataSpan * 0.45))
        const tailPts = []
        for (let i = pts.length - 1; i >= 0; i--) {
          const p = pts[i]
          if (p.at < tailFrom || !hasF(p)) break
          tailPts.unshift(p)
        }
        /* 鎶界█鍒?48 涓偣锛氫互鍓嶅彧鍙?18 涓紝30 灏忔椂鐨勬姈鍔ㄨ鐢绘垚鍑犱釜澶ф姌瑙掞紝鐪嬬潃鍍忛殢鎵嬬敾鐨?*/
        const gstep = Math.max(1, Math.ceil(tailPts.length / 48))
        for (let i = 0; i < tailPts.length - 1; i += gstep) {
          const p = tailPts[i]
          ghosts.push({ x: X(p.at), y: Y(totalOfP(p)) })
        }
        /* 光点只留十来个：48 个一起点会糊成一条毛毛虫 */
        const every = Math.max(1, Math.ceil(ghosts.length / 11))
        ghosts.forEach((g, i) => { if (i % every === 0) sparks.push({ x: g.x, y: g.y, k: sparks.length }) })
        /* 只用直线段：样条在这种又短又跳的点上会绕出怪圈 */
        tailD = ghosts.concat([{ x: nx, y: ny }])
          .map((p, i) => (i ? 'L' : 'M') + p.x.toFixed(1) + ',' + p.y.toFixed(1))
          .join(' ')
      }
      const fmtT = (ms) => {
        const d = new Date(ms)
        if (span <= 2 * 86400000) return trP2(d.getHours()) + ':' + trP2(d.getMinutes())
        if (span <= 70 * 86400000) return (d.getMonth() + 1) + '/' + d.getDate()
        if (span <= 420 * 86400000) return (d.getMonth() + 1) + '月'
        return String(d.getFullYear())
      }
      const xTicks = [0, 0.25, 0.5, 0.75, 1].map((k) => ({ k, at: from + k * span }))
      const fV = last ? Number(last.f) || 0 : 0
      const fsV = last && last.fs !== null && last.fs !== undefined ? Number(last.fs) : null
      const feV = last && last.fe !== null && last.fe !== undefined ? Number(last.fe) : null
      const tV = last ? totalOfP(last) : 0
      const pos = tV >= 0
      const accent = pos ? '#7fd8ff' : '#ff9b9b'
      const lk = look || emoLook(tV, Math.abs(fV))
      const sg = (x) => (Number(x) >= 0 ? '+' : '') + Number(x).toFixed(2)
      const emptyX = hasLine ? X(t0) : W
      const showHatch = emptyX > 1.5
      return h('div', null,
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'stretch' } },
          /* 绾佃酱鏍囧昂 */
          h('div', { style: { position: 'relative', width: 24, flex: 'none', height: H } },
            TR_Y.map((v) => h('span', {
              key: 'y' + v,
              className: 'dshc-mono',
              style: {
                position: 'absolute', right: 0, top: (Y(v) - 6).toFixed(1) + 'px',
                fontSize: 10, lineHeight: '12px', opacity: v === 0 ? 0.8 : 0.4,
              },
            }, v > 0 ? '+' + v : String(v)))),
          /* 鐢诲竷 */
          h('div', { style: { position: 'relative', flex: 1, minWidth: 0, height: H } },
            h('svg', {
              viewBox: '0 0 ' + W + ' ' + H,
              width: '100%',
              height: H,
              preserveAspectRatio: 'none',
              style: { display: 'block', overflow: 'visible' },
            },
            h('defs', null,
              h('pattern', {
                id: 'dshcTrendHatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)',
              }, h('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'currentColor', strokeOpacity: 0.09, strokeWidth: 1.4 })),
              h('linearGradient', { id: 'dshcTrendFill', x1: '0', y1: '0', x2: '0', y2: '1' },
                h('stop', { offset: '0%', stopColor: lk.line, stopOpacity: '0.14' }),
                h('stop', { offset: '100%', stopColor: lk.line, stopOpacity: '0' })),
              h('radialGradient', { id: 'dshcTrendGlow' },
                h('stop', { offset: '0%', stopColor: '#5ec8ff', stopOpacity: '0.6' }),
                h('stop', { offset: '55%', stopColor: '#5ec8ff', stopOpacity: '0.15' }),
                h('stop', { offset: '100%', stopColor: '#5ec8ff', stopOpacity: '0' }))),
            TR_Y.map((v) => h('line', {
              key: 'g' + v, x1: 0, x2: W, y1: Y(v), y2: Y(v),
              stroke: 'currentColor', strokeOpacity: v === 0 ? 0.22 : 0.07,
              strokeWidth: 1, strokeDasharray: v === 0 ? '3 5' : '1 5',
            })),
            /* 还没记录的那一段：斜纹，明摆着告诉你这里空着 */
            showHatch ? h('rect', {
              x: 0, y: 0, width: emptyX.toFixed(1), height: H, fill: 'url(#dshcTrendHatch)', stroke: 'none',
            }) : null,
            showHatch ? h('line', {
              x1: emptyX.toFixed(1), x2: emptyX.toFixed(1), y1: 0, y2: H,
              stroke: 'currentColor', strokeOpacity: 0.18, strokeWidth: 1, strokeDasharray: '3 4',
            }) : null,
            /* 浼戞伅鐨勯偅鍑犳锛氭祬鏂滅汗锛岃竟鐣岀粰涓€鏍规洿娣＄殑铏氱嚎锛屼竴鐪艰兘鐪嬪嚭銆岃繖閲屽ス娌¤璇濄€?*/
            waterD ? h('path', {
              d: waterD, fill: 'none', stroke: 'currentColor', strokeOpacity: 0.16,
              strokeWidth: 1.3, strokeDasharray: '4 4', strokeLinecap: 'round',
            }) : null,
            h('path', { d: areaD, fill: 'url(#dshcTrendFill)' }),
            /* 鏁存潯绾垮厛鏈€娣＄敾涓€閬嶏細鐭┖妗ｉ偅鎴氨闈犺繖涓€灞傦紙濂规湰鏉ュ氨鍦ㄥ線姘翠綅璧帮紝鍙槸鏂簡鍗佸嚑鍒嗛挓锛?*/
            restD ? h('path', {
              d: restD, fill: 'none', stroke: '#ffffff', strokeOpacity: 0.16, strokeWidth: 1.3,
              strokeLinecap: 'round', strokeLinejoin: 'round',
            }) : null,
            /* 睡着的那几截：同一根曲线，再叠一层更淡的白——睡着的时候本来就不该太亮 */
            sleepD ? h('path', {
              d: sleepD, fill: 'none', stroke: '#ffffff', strokeOpacity: 0.28, strokeWidth: 1.6,
              strokeLinecap: 'round', strokeLinejoin: 'round',
            }) : null,
            h('path', {
              d: slowD, fill: 'none', stroke: '#ffffff', strokeOpacity: 0.13, strokeWidth: 9,
              style: { filter: 'blur(6px)' },
            }),
            h('path', {
              d: slowD, fill: 'none', stroke: '#ffffff', strokeWidth: 1.8, strokeOpacity: 0.94,
              strokeLinecap: 'round', strokeLinejoin: 'round',
            }),
            /* 醒来那个点：每一觉醒来，在曲线接头处点一个空心小圈。
               它不解释什么，只是她睡过又醒过来了的记号。 */
            sleepItems.map((s, i) => {
              const at = Date.parse(s.to)
              const v = Number(s.actual != null ? s.actual : s.s_end)
              if (!Number.isFinite(at) || !Number.isFinite(v) || at < t0 || at > t1) return null
              const cx = X(at).toFixed(1)
              const cy = Y(v).toFixed(1)
              return h('g', { key: 'wake' + i },
                h('circle', { cx, cy, r: 4.6, fill: 'none', stroke: '#ffffff', strokeOpacity: 0.13, strokeWidth: 1 }),
                h('circle', { cx, cy, r: 2.3, fill: 'none', stroke: '#ffffff', strokeOpacity: 0.9, strokeWidth: 1.2 }))
            }),
            last ? h('line', {
              x1: nx.toFixed(1), y1: sy.toFixed(1), x2: nx.toFixed(1), y2: ny.toFixed(1),
              stroke: '#5ec8ff', strokeOpacity: 0.4, strokeWidth: 1, strokeDasharray: '2 3',
            }) : null,
            h('path', {
              d: tailD, fill: 'none', stroke: '#5ec8ff', strokeOpacity: 0.12, strokeWidth: 9,
              style: { filter: 'blur(5px)' },
            }),
            h('path', {
              d: tailD, fill: 'none', stroke: '#5ec8ff', strokeOpacity: 0.7, strokeWidth: 1.7,
              strokeLinecap: 'round',
            }),
            sparks.map((g, i) => {
              const fade = sparks.length > 1 ? i / (sparks.length - 1) : 1
              return h('circle', {
                key: 'gh' + i,
                cx: g.x.toFixed(1),
                cy: g.y.toFixed(1),
                r: (0.9 + 2.4 * fade).toFixed(2),
                fill: '#5ec8ff',
                opacity: (0.12 + 0.5 * fade).toFixed(2),
              })
            }),
            last ? h('circle', { cx: nx.toFixed(1), cy: ny.toFixed(1), r: (11 + 5 * lk.e).toFixed(1), fill: 'url(#dshcTrendGlow)' }) : null,
            /* 姝ゅ埢閭ｄ竴鍦堟稛婕細瓒婄Н鏋佽烦寰楄秺蹇秺浜紝瓒婃秷鏋佽秺鎱㈣秺娣★紝娌夊埌涓€瀹氱▼搴﹀共鑴嗕笉璺?*/
            last ? h('circle', {
              className: 'dshc-emo-beacon',
              cx: nx.toFixed(1), cy: ny.toFixed(1), r: 4, fill: 'none',
              stroke: '#5ec8ff', strokeWidth: 1.1,
              strokeOpacity: (0.1 + 0.5 * lk.e).toFixed(2),
              style: { '--emo-beacon': lk.beacon.toFixed(2) + 's' },
            }) : null,
            last ? h('circle', {
              cx: nx.toFixed(1), cy: ny.toFixed(1), r: (3.2 + 0.9 * lk.e).toFixed(2),
              fill: lk.up ? '#5ec8ff' : '#8f9dc0', opacity: (0.7 + 0.3 * lk.e).toFixed(2),
            }) : null,
            last ? h('circle', { cx: nx.toFixed(1), cy: ny.toFixed(1), r: 1.4, fill: '#ffffff' }) : null,
            last ? h('circle', {
              cx: nx.toFixed(1),
              cy: ny.toFixed(1),
              r: 15,
              fill: 'transparent',
              style: { cursor: 'pointer' },
              onMouseEnter: () => setTip(true),
              onMouseLeave: () => setTip(false),
            }) : null),
            /* 绌虹殑閭ｄ竴娈佃涓€鍙ヤ负浠€涔?*/
            showHatch && emptyX > 78 ? h('span', {
              style: {
                position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)',
                fontSize: 10.5, opacity: 0.5, pointerEvents: 'none',
              },
            }, '这段时间还没有记录') : null,
            !hasLine ? h('div', {
              style: {
                position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
                justifyContent: 'center', fontSize: 12, opacity: 0.5, pointerEvents: 'none',
              },
            }, '这段还没有记录，聊几句就有了') : null,
            tip && last ? h('div', {
              style: {
                position: 'absolute',
                left: Math.max(10, Math.min(86, (nx / W) * 100)).toFixed(1) + '%',
                top: Math.max(0, Math.min(100, (ny / H) * 100)).toFixed(1) + '%',
                transform: 'translate(-50%, 18px)',
                padding: '8px 11px', borderRadius: 10,
                border: '1px solid var(--line)',
                background: 'color-mix(in srgb, var(--panel2) 82%, #000 18%)',
                fontSize: 11.5, lineHeight: 1.7, whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 3,
              },
            },
            h('div', { style: { fontSize: 12.5, fontWeight: 600, color: accent } }, (pos ? '积极 ' : '消极 ') + sg(tV)),
            last.lb ? h('div', null, '情绪 ' + (AFFECT_KEY[last.lb] || last.lb)) : null,
            h('div', null, '慢情绪 ' + sg(last.s)),
            h('div', { style: { opacity: 0.72 } },
              '水位 ' + sg(Number(last.b) || 0)
              + (last.bo === null || last.bo === undefined ? '' : '（负荷 ' + sg(Number(last.bo)) + '）')),
            h('div', null, '当场 ' + sg(fV)),
            fsV === null ? null : h('div', { style: { opacity: 0.72 } }, '· 自己 ' + sg(fsV)),
            feV === null ? null : h('div', { style: { opacity: 0.72 } }, '· 共情 ' + sg(feV))) : null)),
        /* 横轴时间刻度 */
        h('div', { style: { position: 'relative', height: 14, marginTop: 3, marginLeft: 30 } },
          xTicks.map((t) => h('span', {
            key: 'x' + t.k,
            className: 'dshc-mono',
            style: {
              position: 'absolute', top: 0, fontSize: 10, opacity: 0.42, whiteSpace: 'nowrap',
              left: ((X(t.at) / W) * 100).toFixed(2) + '%',
              transform: t.k === 0 ? 'translateX(0)' : t.k === 1 ? 'translateX(-100%)' : 'translateX(-50%)',
            },
          }, fmtT(t.at)))),
        h('div', { style: { display: 'flex', gap: 16, marginTop: 5, marginLeft: 30 } },
          h('span', { className: 'dshc-sub', style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('span', { style: { width: 16, height: 2, background: '#fff', borderRadius: 2, display: 'inline-block' } }), '慢情绪'),
          h('span', { className: 'dshc-sub', style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('span', { style: { width: 16, height: 2, background: '#5ec8ff', borderRadius: 2, display: 'inline-block' } }), '当场（历史样本是旧快情绪）'),
          h('span', { className: 'dshc-sub', style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('span', {
              style: {
                width: 7, height: 7, background: '#5ec8ff', borderRadius: '50%',
                display: 'inline-block', boxShadow: '0 0 8px #5ec8ff',
              },
            }), '此刻'),
          sleeps.length ? h('span', { className: 'dshc-sub', style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('span', {
              style: {
                width: 16, height: 2, display: 'inline-block', borderRadius: 2,
                background: '#fff', opacity: 0.4,
              },
            }), '休眠（睡着的几小时，淡色是推演）') : null,
          /* 涓や釜鏁帮細鐜板湪绂绘按浣嶅杩溿€佺収杩欎釜閫熷害澶氫箙鍥炰竴鍗婏紙鎸夊績鎯呭湪楂樹綅/浣庝綅閫夐€熷害锛?*/
          (data && data.now) ? h('span', {
            className: 'dshc-sub dshc-mono',
            title: '离水位 = 慢情绪 − 水位；回一半 = 按当前的恢复速度算的半衰期',
          }, (Number(data.now.dist) >= 0 ? '离水位 +' : '离水位 −')
            + Math.abs(Number(data.now.dist) || 0).toFixed(2)
            + ' · 约 ' + Number(data.now.half_h || 0).toFixed(1) + ' 小时回一半') : null))
    }

    function MiniBars({ rows }) {      return h('div', { className: 'dshc-list' }, (rows || []).map(([k, v, max], i) => h('div', { key: i, className: 'dshc-item' },
        h('div', { className: 't', style: { minWidth: 62 } }, k),
        h('div', { style: { flex: 1, height: 6, borderRadius: 999, background: 'var(--panel2)', overflow: 'hidden' } },
          h('div', {
            style: {
              width: Math.round(Math.max(0, Math.min(1, Number(v) / Number(max || 1))) * 100) + '%',
              height: '100%', background: 'var(--accent)', opacity: 0.72,
            },
          })),
        h('span', { className: 'm dshc-mono', style: { minWidth: 42, textAlign: 'right' } }, String(Math.round(Number(v) * 100) / 100)))))
    }

    function Tech({ children }) {
      return h('div', {
        className: 'dshc-note',
        style: { fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.75, whiteSpace: 'pre-wrap', marginTop: 8 },
      }, children)
    }

    /** 澶村儚鍘嬪埌 256 鐨?webp/jpeg锛屽啀瀛樺簱锛堝彧缁欒缃〉鎹㈠ご鍍忕敤锛?*/
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

    /** 只读「输入框」里的打字机效果：按字符浮现，末尾留一个会眨的光标 */
    const TYPED = new Set()
    function Typer({ text, speed = 14, delay = 0 }) {
      const full = String(text || '')
      const [n, setN] = useState(TYPED.has(full) ? full.length : 0)
      useEffect(() => {
        let reduce = false
        try { reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) } catch { /* ignore */ }
        if (reduce || !full || TYPED.has(full)) { setN(full.length); TYPED.add(full); return }
        setN(0)
        let timer = null
        const start = setTimeout(() => {
          timer = setInterval(() => {
            setN((k) => {
              if (k >= full.length) { if (timer) clearInterval(timer); TYPED.add(full); return k }
              return k + 1
            })
          }, speed)
        }, delay)
        return () => { clearTimeout(start); if (timer) clearInterval(timer) }
      }, [full, speed, delay])
      const done = n >= full.length
      return h('span', { className: 'dshc-typer' },
        h('span', null, full.slice(0, n)),
        h('i', { className: 'dshc-caret', 'data-done': done ? '1' : '0' }))
    }

    function Avatar({ src, size = 44 }) {
      return h('span', {
        className: 'dshc-av', style: { position: 'relative', display: 'inline-block', flex: '0 0 auto' },
      },
        h('span', { className: 'dshc-orb', style: { width: size, height: size } },
          h('i'), h('i'), h('i'),
          h('b', { style: { width: Math.round(size * 0.8), height: Math.round(size * 0.8), overflow: 'hidden', padding: 0 } },
            h('img', { src: src || DEFAULT_AVATAR, alt: '', draggable: false, style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' } }))))
    }

    const Dot = ({ state }) => h('span', { className: 'dshc-dot', 'data-s': state || 'ok' })
    const Pill = ({ on, tone, children, title }) => h('span', {
      className: 'dshc-pill', 'data-on': on ? '1' : '0', 'data-tone': tone, title,
    }, children)

    let CURRENT_VIEW = 'user'
    const Sec = ({ title, desc, children, right, techOnly }) => (techOnly && CURRENT_VIEW !== 'tech') ? null : h('section', { className: 'dshc-sec' },
      h('header', null,
        h('div', { className: 'dshc-sec-h' },
          h('span', { className: 'bar' }),
          h('h2', null, title),
          right ? h('span', { className: 'dshc-sec-act' }, right) : null),
        desc ? h('p', { className: 'dshc-sec-d' }, desc) : null),
      children)

    const Card = ({ children, style, className }) => h('div', {
      className: 'dshc-card ' + (className || ''), style,
    }, children)

    const Row = ({ label, children, value }) => h('div', { className: 'dshc-row' },
      h('span', { className: 'l' }, label), children,
      value !== undefined ? h('span', { className: 'v dshc-mono' }, value) : null)

    function Bar({ value, tone, color }) {
      const v = Math.max(0, Math.min(1, Number(value) || 0))
      return h('div', { className: 'dshc-bar', 'data-tone': tone },
        h('i', { style: { width: (v * 100).toFixed(1) + '%', background: color || undefined } }))
    }

    /**
     * 五维需要画成「杯子」：杯口宽度 = 它自己长出来的胃口（setpoint），
     * 姘?= 宸茬粡婊¤冻鍒扮殑姘翠綅锛岀┖鐫€鐨勯偅鎴?= 缂哄彛 n_i 鈥斺€?涔熷氨鏄畠鐜板湪鐨勬鏈涖€?     * 缂哄彛瓒婇暱瓒婇タ锛?.10 璧疯浆姗欑孩锛?.25 璧风儳绾紝0.45 璧峰彂鐑紙鍏夋檿 + 鍛煎惛 + 绾㈢偣锛夈€?     */
    const NEED_LV = [[0.03, '不饿'], [0.10, '一点点'], [0.30, '有点饿'], [0.50, '挺饿'], [1.01, '很饿']]
    function needWord(n) { for (const [t, w] of NEED_LV) if (n < t) return w; return '很饿' }
    function needRank(d) {
      return DIMS.map(([k, l]) => ({ k, l, n: Math.max(0, Math.min(1, Number(d.deficits && d.deficits[k]) || 0)) }))
        .sort((a, b) => b.n - a.n)
    }
    function NeedCups({ d, tech }) {
      // 点一下展开这一维的账：胃口怎么来的、算数为什么是 ×1.06、缺口怎么算的
      const [open, setOpen] = useState({})
      const sp = d.setpoint || {}
      const ds = d.deficits || {}
      const xs = d.dims || {}
      const ws = d.weights || {}
      const parts = d.weight_parts || {}
      const habit = (d.learn && d.learn.habit) || {}
      const mods = (d.learn && d.learn.mods) || {}
      const ranked = needRank(d)
      const topN = ranked.length ? ranked[0].n : 0
      const sgn = (v) => (v >= 0 ? '+' : '') + v.toFixed(3)
      return h('div', { className: 'dshc-needs' }, DIMS.map(([k, label], i) => {
        const s = Math.max(0.08, Math.min(1, Number(sp[k]) || 0.6))
        const n = Math.max(0, Math.min(1, Number(ds[k]) || 0))
        const x = Math.max(0, Math.min(1, Number(xs[k]) || 0))
        const heat = n >= 0.45 ? 4 : n >= 0.25 ? 3 : n >= 0.10 ? 2 : n >= 0.03 ? 1 : 0
        const isTop = n >= 0.03 && n >= topN - 1e-9
        const isOpen = !!open[k]
        // 鍒嗚В锛氭潈閲嶈〃缁欑殑鏄?0.35路T 涓?0.25路V锛屽弽瑙ｅ嚭 T銆乂锛屽啀鎹㈡垚鑳冨彛鐨勯噺绾?''
              const W = Number(ws[k]) || 1
        const p = parts[k] || {}
        const tw = Number(p.trait) || 0
        const vw = Number(p.value) || 0
        const T = tw / 0.35
        const V = vw / 0.25
        /* 璐︽湰鍙湁涓€涓潵婧愶細鏈嶅姟绔畻濂界殑鑳冨彛鎷嗛」銆?           浠ュ墠杩欓噷鏄嚜宸辨嬁 0.08路(1鈭抙/2) 鍙嶆帹鐨勶紝鎶婅儍鍙ｅ€嶇巼 k 蹇樹簡 鈥斺€?           浜旈」鍔犺捣鏉?0.700锛岃儍鍙ｅ嵈鍐欑潃 0.821锛岃处鏍规湰瀵逛笉涓娿€傝€佸簱娌℃湁 detail 鎵嶅洖閫€銆?*/
        const kk = Math.max(0.2, Math.min(3, Number(d.learn && d.learn.appetite_k) || 2))
        const det = (d.learn && d.learn.detail && d.learn.detail[k]) || null
        const numOr = (v, fb) => (Number.isFinite(Number(v)) ? Number(v) : fb)
        const hRaw = det && det.habit != null ? det.habit : habit[k]
        const hh = Math.max(0, Math.min(1, numOr(hRaw, x)))
        const aEff = det && det.appetite != null ? numOr(det.appetite, 0) : 0.08 * kk * (1 - 0.5 * hh)
        const dTrait = det && det.trait != null ? numOr(det.trait, 0) : 0.10 * T
        const dValue = det && det.value != null ? numOr(det.value, 0) : 0.05 * V
        const dMod = det && det.mod != null ? numOr(det.mod, 0) : (Number(mods[k]) || 0)
        const rankNo = ranked.findIndex((r) => r.k === k) + 1
        const row = h('div', {
          key: k,
          className: 'dshc-need' + (isOpen ? ' open' : ''),
          'data-heat': heat ? String(heat) : undefined,
          'data-top': isTop ? '1' : undefined,
          role: 'button',
          tabIndex: 0,
          onClick: () => setOpen((o) => ({ ...o, [k]: !o[k] })),
          onKeyDown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setOpen((o) => ({ ...o, [k]: !o[k] }))
            }
          },
        },
          h('span', { className: 'l' }, label),
          h('span', {
            className: 'track',
            title: '胃口 ' + s.toFixed(2) + ' · 现在 ' + x.toFixed(2) + ' · 缺口 ' + n.toFixed(2),
          },
            h('i', {
              className: 'halo',
              style: { left: (s * (1 - n) * 100).toFixed(1) + '%', width: (s * n * 100).toFixed(1) + '%' },
            }),
            h('span', { className: 'cup', style: { width: (s * 100).toFixed(1) + '%', animationDelay: i * 45 + 'ms' } },
              h('i', { className: 'water', style: { width: ((1 - n) * 100).toFixed(1) + '%' } }),
              n > 0.004 ? h('i', { className: 'gap', style: { width: (n * 100).toFixed(1) + '%' } }) : null),
            h('i', { className: 'rim', style: { left: (s * 100).toFixed(1) + '%' } })),
          h('span', { className: 'v' },
            h('i', { className: 'dot' }),
            tech
              ? h('span', null,
                '缺口 ' + n.toFixed(2),
                h('span', { className: 'num' }, ' · 胃口 ' + s.toFixed(2) + ' · 现在 ' + x.toFixed(2)))
              : h('span', null, needWord(n), h('span', { className: 'num' }, ' ' + n.toFixed(2)))),
          h('span', { className: 'chev' }, isOpen ? '⌃' : '⌄'))
        const detail = isOpen
          ? h('div', { key: k + '-d', className: 'dshc-need-detail' },
            // 鈶?涓€鍙ヨ瘽鍏堣缁撹锛氱幇鍦ㄤ粈涔堢姸鎬併€佸湪绗嚑浣嶃€佸涓嶅鏍煎紑鍙?''
              h('div', { className: 'nd-line nd-strong' },
              needWord(n),
              '　空着 ', h('b', null, Math.round(n * 100) + '%'),
              '　·　', rankNo === 1 ? '五条里最饿的' : '五条里第 ' + rankNo + ' 饿',
              '　·　', n >= 0.18 ? '够进档位了' : n >= 0.10 ? '还不到想主动说的程度' : '基本满足了'),
            // 鈶?鐢ㄦ澂瀛愯浜鸿瘽锛氭兂瑕佸灏?/ 鐜板湪澶氬皯 / 宸灏?''
              h('div', { className: 'nd-line' },
              '它想被喂到 ', h('b', null, s.toFixed(2)),
              '，现在只有 ', h('b', null, x.toFixed(2)),
              '，还差 ', h('b', null, Math.max(0, s - x).toFixed(2)),
              h('span', { className: 'nd-soft' }, '　（缺口 = 差多少 ÷ 想要多少，所以永远是 0~1 之间的比例）')),
            // 鈶?鑳冨彛鎬庝箞鏀掑嚭鏉ョ殑锛氫竴椤逛竴鍙ヨ瘽
            h('div', { className: 'nd-line nd-soft' }, '这个 ', s.toFixed(2), ' 是怎么攒出来的：'),
            h('div', { className: 'nd-line' }, '　平时就是这样 ', h('b', null, hh.toFixed(2)),
              h('span', { className: 'nd-soft' }, '　习惯在哪儿，胃口就落在哪儿')),
            h('div', { className: 'nd-line' }, '　天生还想多要 ', h('b', null, sgn(aEff)),
              h('span', { className: 'nd-soft' }, '　这类需求本来就要一点，习惯越深要得越少')),
            h('div', { className: 'nd-line' }, '　性子带了一下 ', h('b', null, sgn(dTrait)),
              h('span', { className: 'nd-soft' }, '　它的性格把这一格往上带（负数就是往下带）')),
            h('div', { className: 'nd-line' }, '　看重的东西 ', h('b', null, sgn(dValue)),
              h('span', { className: 'nd-soft' }, '　价值观里这块排得靠前就抬、靠后就压')),
            Math.abs(dMod) >= 0.0005
              ? h('div', { className: 'nd-line' }, '　外面也推了 ', h('b', null, sgn(dMod)),
                h('span', { className: 'nd-soft' }, '　关系亲密度 / 情绪底色 / 工况 / 长期情绪 合起来的'))
              : h('div', { className: 'nd-line nd-soft' }, '　外面没推：关系、情绪底色、工况、长期情绪，这会儿都没动它'),
            // 鈶?鎹㈡垚鍒嗘暟
            h('div', { className: 'nd-line' },
              '换成分数 ', h('b', null, (W * n).toFixed(3)),
              h('span', { className: 'nd-soft' },
                '　同一条缺口，落在它更看重的地方就更疼（×' + W.toFixed(2) + '），排档位就看这个')),
            // 鈶?鍘熷鍏紡鍙暀缁欐妧鏈鍥撅紝骞虫椂鍒湅
            tech
              ? h('div', { className: 'nd-line nd-soft' },
                '缺口 (', s.toFixed(3), ' − ', x.toFixed(3), ') ÷ ', s.toFixed(3), ' = ', n.toFixed(3),
                ' · 权重 1 + 0.35·T', sgn(tw), ' + 0.25·V', sgn(vw), ' 归一 = ', W.toFixed(3),
                ' · T ', T.toFixed(3), ' · V ', V.toFixed(3), ' · 胃口倍率 k ', kk.toFixed(2))
              : null)
          : null
        return h(React.Fragment, { key: k }, row, detail)
      }))
    }

    /** 鍏竟褰㈤浄杈撅細labels 涓?{ joy:n, ... } */

