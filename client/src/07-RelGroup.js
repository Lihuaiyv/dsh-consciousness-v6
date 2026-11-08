    function RelGroup({ tier, items, aid, act, onChanged, flash }) {
      const [open, setOpen] = useState(false)
      const desc = REL_TIER_DESC[tier] || { short: '', long: '' }
      const flashAt = flash ? flash.at : 0
      useEffect(() => {
        if (flash && flash.tier === tier) setOpen(true)
      }, [flashAt])
      return h('div', { className: 'dshc-relgroup' },
        h('div', { className: 'dshc-relgroup-h', onClick: () => setOpen((v) => !v) },
          h('span', { className: 'caret', 'data-open': open ? '1' : '0' }, '▸'),
          h('b', null, REL_TIER_LABEL[tier] || tier),
          h('span', { className: 'n' }, items.length + ' 人'),
          h('div', { className: 'dshc-spacer' }),
          h('span', { className: 'dshc-sub' }, desc.short)),
        open ? h('div', { className: 'dshc-relgroup-b' },
          h('div', { className: 'dshc-sub dshc-relgroup-d' }, desc.long),
          items.map((p) => h(PersonRow, {
            key: p.id, aid, act, p, onChanged,
            flash: flash && flash.tier === tier && flash.name === p.name,
          }))) : null)
    }

    /** 涓夎酱璧板娍锛氫翰杩?/ 淇′换 / 渚濊禆锛?..1锛涙暟鎹潵鑷处鏈噸鏀撅紝涓嶅彟瀛樿〃銆?*/
    function AxisTrend({ data }) {
      const pts = (data && data.points) || []
      if (pts.length < 2) return h('div', { className: 'dshc-sub', style: { marginTop: 6 } }, '还没有能画成走势的变化：至少要有两次记账。')
      const W = 520
      const H = 96
      const PAD = 6
      const t0 = pts[0].at
      const t1 = pts[pts.length - 1].at
      const span = Math.max(60000, t1 - t0)
      const X = (ms) => PAD + ((ms - t0) / span) * (W - PAD * 2)
      const Y = (v) => PAD + (1 - Math.max(0, Math.min(1, Number(v) || 0))) * (H - PAD * 2)
      const line = (key, color) => h('polyline', {
        key,
        points: pts.map((p) => X(p.at).toFixed(1) + ',' + Y(p[key]).toFixed(1)).join(' '),
        fill: 'none', stroke: color, strokeWidth: 1.6, strokeLinejoin: 'round', strokeLinecap: 'round',
      })
      return h('div', { style: { marginTop: 8 } },
        h('div', { className: 'dshc-sub', style: { display: 'flex', gap: 10, alignItems: 'center' } },
          h('span', { style: { color: '#7fd8ff' } }, '■ 亲近'),
          h('span', { style: { color: '#ffd479' } }, '■ 信任'),
          h('span', { style: { color: '#b48bff' } }, '■ 依赖'),
          h('div', { className: 'dshc-spacer' }),
          h('span', null, (data.days || 30) + ' 天 · ' + pts.length + ' 次变化')),
        h('svg', { viewBox: '0 0 ' + W + ' ' + H, style: { width: '100%', height: 96 } },
          [0.25, 0.5, 0.75].map((g) => h('line', {
            key: 'g' + g, x1: PAD, y1: Y(g), x2: W - PAD, y2: Y(g),
            stroke: 'var(--line)', strokeWidth: 0.5, opacity: 0.5,
          })),
          line('c', '#7fd8ff'), line('t', '#ffd479'), line('d', '#b48bff')))
    }

    /** 涓€涓汉涓€琛岋細鐐瑰紑鐪嬪崱銆佽瘉鎹€佷粬-浠栬竟锛涜兘鎶婁汉鏀捐繘鍏崇郴鍥炬垨褰掓。銆?*/
    function PersonRow({ aid, act, p, onChanged, flash }) {
      const [open, setOpen] = useState(false)
      const [det, reloadDet] = useAsync(
        () => (open ? call('GET', '/v1/agents/' + enc(aid) + '/persons/' + enc(p.id)) : Promise.resolve(null)),
        [open, p.id, p.version],
      )
      const [axes] = useAsync(
        () => (open ? call('GET', '/v1/agents/' + enc(aid) + '/persons/' + enc(p.id) + '/axes?days=30') : Promise.resolve(null)),
        [open, p.id, p.version],
      )
      const [busy, setBusy] = useState('')
      const [askDel, setAskDel] = useState(false)
      const [err, setErr] = useState('')
      // WebView 閲岀殑 window.confirm 鍙兘琚涓婚潤榛樻帀锛堣繑鍥?false锛夛紝鎵€浠ョ敤銆岀偣涓ゆ銆嶄唬鏇垮脊绐椼€?''
      // 纭鎬佷笉鍐嶈嚜鍔ㄨ秴鏃讹細4 绉掍竴鍒版寜閽嚜宸辩缉鍥炲幓锛岀湅鐫€灏卞儚銆屽垹涓嶆帀銆嶃€?''
              async function run(kind) {
        setErr('')
        setBusy(kind)
        try {
          if (kind === 'promote') await call('POST', '/v1/persons/' + enc(p.id) + '/promote', {}, true)
          if (kind === 'remove') await call('DELETE', '/v1/persons/' + enc(p.id), {}, true)
          onChanged()
        } catch (e) { setErr(e.message) } finally { setBusy('') }
      }
      const d = det.data || null
      return h('div', {
        style: {
          padding: '7px 0', borderBottom: '1px dashed var(--line)',
          ...(flash ? { background: 'color-mix(in srgb, var(--accent) 10%, transparent)', paddingLeft: 6, paddingRight: 6, borderRadius: 6 } : {}),
        },
      },
        h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' },
          onClick: () => { setAskDel(false); setOpen((v) => !v) },
        },
          h('b', { style: { fontSize: 12.5 } }, p.name),
          h(Pill, { on: p.tier === 'owner' }, REL_TIER_LABEL[p.tier] || p.tier),
          p.status !== 'active' ? h(Pill, null, p.status === 'faded' ? '淡出中' : '已归档') : null,
          p.graph_visible ? h(Pill, { on: true }, '入图') : null,
          h('div', { className: 'dshc-spacer' }),
          h('span', { className: 'm' },
            '亲近 ' + Number(p.closeness || 0).toFixed(2)
            + ' · 信任 ' + Number(p.trust || 0).toFixed(2)
            + ' · 依赖 ' + Number(p.dependence || 0).toFixed(2)),
          p.tier !== 'owner'
            ? h('button', {
              className: 'dshc-del' + (askDel ? ' dshc-del-ask' : ''),
              title: askDel ? '再点一次就删掉' : '删掉这个人物卡（账本留着）',
              onClick: (e) => {
                e.stopPropagation()
                if (!askDel) { setAskDel(true); return }
                setAskDel(false)
                run('remove')
              },
            }, busy === 'remove' ? '…' : (askDel ? '确认删' : '删'))
            : null),
        h('div', { style: { display: 'flex', gap: 6, marginTop: 4, alignItems: 'center' } },
          h(Bar, { value: Number(p.closeness || 0) }),
          h(Bar, { value: Number(p.trust || 0) }),
          h(Bar, { value: Number(p.dependence || 0) }),
          h('div', { className: 'dshc-spacer' }),
          h('span', { className: 'dshc-sub' }, '上次 ' + relAgo(p.last_talk_at) + ' · 说过 ' + (p.talk_count || 0) + ' 次')),
        open ? h('div', { style: { marginTop: 8 } },
          h(LoadErr, { error: det.error, retry: reloadDet }),
          d ? h('div', { className: 'dshc-note', style: { whiteSpace: 'pre-wrap' } }, d.card) : null,
          axes.data ? h(AxisTrend, { data: axes.data }) : null,
          d && (d.evidence || []).length ? h('div', { className: 'dshc-sub', style: { marginTop: 6 } },
            '它是从这些话知道的：' + d.evidence.map((e) => '「' + String(e.text || '').slice(0, 28) + '」').join('；')) : null,
          d && (d.edges || []).length ? h('div', { className: 'dshc-sub', style: { marginTop: 4 } },
            '和谁有关系：' + d.edges.map((e) => e.other.name + '（' + (e.role_label || e.kind) + '）').join('、')) : null,
          h('div', { className: 'dshc-form', style: { marginTop: 8 } },
            !p.graph_visible && p.tier !== 'owner'
              ? h(Btn, { onClick: () => run('promote'), disabled: busy === 'promote' }, busy === 'promote' ? '提升中…' : '放进关系图')
              : null)) : null,
        err ? h('div', { className: 'dshc-err', style: { marginTop: 6 } }, err) : null)
    }

    /** 鎵嬭涓€涓汉锛氬悕瀛?+ 鍒嗗眰 + 涓€鍙ヨ瘽銆傚垎绫绘槸绛栫暐锛屼汉鍙互闅忔椂鎹㈠眰銆?*/
    /** 鎵嬪姩娣诲姞鍏崇郴锛氬厛濉悕瀛楋紝閫夌啛浜?/ 鐢熶汉锛屽啀琛ヤ竴鍙ヨ瘽锛岃涓嬨€?*/
    function PersonEditor({ aid, act, persons, onAdded, onDone }) {
      const [tier, setTier] = useState('acquaintance')
      const [name, setName] = useState('')
      const [line, setLine] = useState('')
      const [busy, setBusy] = useState(false)
      const [open, setOpen] = useState(false)
      const [err, setErr] = useState('')
      const [done, setDone] = useState(null)
      const nm = name.trim()
      // 鍚屽悕鐨勪汉鍙細鏈変竴寮犲崱锛氬啀鍔犱粬 = 鎸埌杩欎竴灞傦紝鍏堟妸璇濊鍦ㄥ墠澶?''
              const existing = nm ? (persons || []).find((p) => p.name === nm) : null
      async function add() {
        if (!nm) { setErr('先填名字：这人叫什么'); return }
        setErr('')
        setBusy(true)
        try {
          await call('POST', '/v1/agents/' + enc(aid) + '/persons', { name: nm, tier, summary: line.trim() || null }, true)
          setDone({ name: nm, tier })
          setName('')
          setLine('')
          if (onAdded) onAdded({ name: nm, tier })
          else if (onDone) onDone()
        } catch (e) { setErr(e.message) } finally { setBusy(false) }
      }
      return h('div', { className: 'dshc-relgroup', style: { marginTop: 4 } },
        h('div', { className: 'dshc-relgroup-h', onClick: () => setOpen((v) => !v) },
          h('span', { className: 'caret', 'data-open': open ? '1' : '0' }, '▸'),
          h('b', null, '手动添加关系'),
          h('div', { className: 'dshc-spacer' }),
          h('span', { className: 'dshc-sub' }, open ? '收起' : '名字 + 类型 + 一句话')),
        open ? h('div', { className: 'dshc-relgroup-b' },
          h('div', { className: 'dshc-sub dshc-relgroup-d' },
            '名字单独填；再选熟人或生人，用一句话说清这人是谁。'),
          h('div', { className: 'dshc-form', style: { marginTop: 6 } },
            h(Input, {
              className: 'grow', placeholder: '名字：比如「小周」', value: name,
              maxLength: 24, onChange: (e) => setName(e.target.value),
            })),
          existing ? h('div', { className: 'dshc-sub', style: { marginTop: 4 } },
            existing.tier === tier
              ? '「' + nm + '」已经在列表里，记下会更新这张卡'
              : '「' + nm + '」现在在「' + (REL_TIER_LABEL[existing.tier] || existing.tier)
                + '」，记下会把它挪到「' + (REL_TIER_LABEL[tier] || tier) + '」')
            : null,
          h('div', { className: 'dshc-form', style: { marginTop: 6 } },
            h('select', {
              className: 'dshc-sel', value: tier, onChange: (e) => setTier(e.target.value),
            },
              h('option', { value: 'acquaintance' }, '熟人 · 长期记得住'),
              h('option', { value: 'stranger' }, '生人 · 刚认识忘得快'))),
          h('div', { className: 'dshc-form', style: { marginTop: 6 } },
            h(Input, {
              className: 'grow', placeholder: '一句话：比如「同事，帮我修过电脑」', value: line,
              maxLength: 80, onChange: (e) => setLine(e.target.value),
            })),
          h('div', { className: 'dshc-form', style: { marginTop: 8, alignItems: 'center' } },
            h(Btn, { onClick: add, disabled: busy }, busy ? '记下中…' : '记下'),
            h('span', { className: 'dshc-sub' }, '记下之后点开那个人，还能放进关系图或删掉。')),
          done ? h('div', { className: 'dshc-sub', style: { marginTop: 6 } },
            '已记在「' + (REL_TIER_LABEL[done.tier] || done.tier) + '」：' + done.name) : null,
          err ? h('div', { className: 'dshc-err' }, err) : null) : null)
    }

    /** 娌¤鍑烘潵鐨勫悕瀛楋細鎸傚埌鏌愪釜浜哄崱涓婏紝鎴栬€呭拷鐣ャ€?*/
    function MentionRow({ aid, m, persons, onChanged }) {
      const [pid, setPid] = useState('')
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')
      async function send(ignore) {
        setErr('')
        setBusy(ignore ? 'ignore' : 'link')
        try {
          await call('POST', '/v1/mentions/' + enc(m.id) + (ignore ? '/ignore' : '/link'),
            ignore ? {} : { person_id: pid }, true)
          onChanged()
        } catch (e) { setErr(e.message) } finally { setBusy('') }
      }
      return h('div', { style: { padding: '6px 0', borderBottom: '1px dashed var(--line)' } },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('b', { style: { fontSize: 12.5 } }, m.surface),
          h(Pill, null, m.how === 'role' ? '称呼' : '名字'),
          h('div', { className: 'dshc-spacer' }),
          h('span', { className: 'dshc-sub' }, relAgo(m.created_at))),
        m.context ? h('div', { className: 'dshc-sub', style: { marginTop: 2 } }, '「' + String(m.context).slice(0, 60) + '」') : null,
        h('div', { className: 'dshc-form', style: { marginTop: 6 } },
          h('select', {
            className: 'dshc-sel grow', value: pid, onChange: (e) => setPid(e.target.value),
          },
            h('option', { value: '' }, '选一个人…'),
            persons.map((p) => h('option', { key: p.id, value: p.id },
              p.name + '（' + (REL_TIER_LABEL[p.tier] || p.tier) + '）'))),
          h(Btn, { onClick: () => send(false), disabled: !pid || !!busy }, busy === 'link' ? '…' : '是 TA'),
          h(Btn, { onClick: () => send(true), disabled: !!busy }, busy === 'ignore' ? '…' : '忽略')),
        err ? h('div', { className: 'dshc-err' }, err) : null)
    }

    /** 鍘屾伓搴?→浜鸿瘽 + 鑹茶皟銆?.35 浠ヤ笅绠楀枩娆紝0.65 浠ヤ笂绠楄鍘岋紝涓棿鏄湅鎯呭喌銆?*/
    function prefSense(av) {
      const v = Math.max(0, Math.min(1, Number(av) || 0))
      if (v <= 0.35) return { word: '喜欢', tone: 'ok' }
      if (v >= 0.65) return { word: '讨厌', tone: 'bad' }
      return { word: '看情况', tone: undefined }
    }

    /**
     * 涓€琛屽亸濂姐€傛墜鍐欏拰鑷繁闀跨殑鏄?*鍚屼竴绉嶈**锛堟爣绛?+ 鏉″舰 + 鍘屾伓搴?+ 鍠滄/璁ㄥ帉 + 鏉ユ簮锛夛紝
     * 鍞竴鐨勫尯鍒槸鑷繁闀垮嚭鏉ョ殑娌℃湁鍒犻櫎鍏ュ彛鈥斺€旀湇鍔＄涔熶細鎷掞紙409 LOCKED锛夈€?     */
    function PrefRow({ aid, act, r, onDone }) {
      const [askDel, setAskDel] = useState(false)
      const [busy, setBusy] = useState(false)
      const auto = r.origin === 'auto'
      async function del() {
        setBusy(true)
        try {
          await act(() => call('DELETE', '/v1/agents/' + enc(aid) + '/preferences/' + enc(r.id), {}, true))
          onDone()
        } catch { /* 服务端不让删就保持原样，绝不装作删掉了 */ } finally { setBusy(false) }
      }
      const sense = prefSense(r.aversion)
      return h(Row, { label: r.tag },
        h(Bar, { value: Number(r.aversion), tone: sense.tone }),
        h('span', { className: 'm dshc-mono' }, Number(r.aversion).toFixed(2)),
        h(Pill, { tone: sense.tone, title: sense.word === '喜欢' ? '厌恶度低：它喜欢这个' : sense.word === '讨厌' ? '厌恶度高：它受不了这个' : '厌恶度居中：看情况' }, sense.word),
        h(Pill, { title: auto ? '它自己长出来的，删不掉' : '手写的，可以删' }, auto ? '自己长' : '手写'),
        auto ? null : h('button', {
          className: 'dshc-del' + (askDel ? ' dshc-del-ask' : ''),
          title: askDel ? '再点一次就删掉' : '删掉这条偏好',
          onClick: () => {
            if (!askDel) { setAskDel(true); return }
            setAskDel(false)
            del()
          },
        }, busy ? '…' : (askDel ? '确认删' : '删')))
    }

    function PreferenceForm({ aid, act, onDone, limit = DEFAULT_LIMITS.preferenceTag }) {
      const [tag, setTag] = useState('')
      const [av, setAv] = useState('0.5')
      const [err, setErr] = useState('')
      const [ok, setOk] = useState('')
      const [busy, setBusy] = useState(false)
      async function add() {
        setErr(''); setOk('')
        // 绌虹潃鐐广€屽姞鍋忓ソ銆嶄互鍓嶆槸闈欓粯 return锛岀湅鐫€灏卞儚鎸夐挳鍧忎簡锛涙敼鎴愭槑璇?''
        if (!tag.trim()) { setErr('先写一个标签，再点加偏好。比如「香菜」。'); return }
        if (busy) return
        setBusy(true)
        try {
          await act(() => call('POST', '/v1/agents/' + enc(aid) + '/preferences', { tag: tag.trim(), aversion: Number(av) || 0 }, true))
          setOk('已记下「' + tag.trim() + '」')
          setTag(''); onDone()
        } catch (e) { setErr(e.message) } finally { setBusy(false) }
      }
      return h('div', null,
        h('div', { className: 'dshc-form', style: { marginTop: 8 } },
          h(Input, {
            className: 'grow', placeholder: '偏好标签，比如「香菜」', value: tag, maxLength: limit,
            onChange: (e) => { setTag(e.target.value); if (err) setErr('') },
            onKeyDown: (e) => { if (e.key === 'Enter') add() },
          }),
          h(CharCount, { value: tag, limit }),
          h(Input, {
            style: { width: 84 }, value: av, placeholder: '0—',
            title: '它现在觉得你：',
            onChange: (e) => setAv(e.target.value),
          }),
          h(Pill, { tone: prefSense(av).tone, title: '按你填的数字，这条会被记成「' + prefSense(av).word + '」' }, prefSense(av).word),
          h(Btn, { onClick: add, disabled: busy }, busy ? '加入中…' : '加偏好')),
        ok ? h('div', { className: 'dshc-note' }, ok) : null,
        err ? h('div', { className: 'dshc-err' }, err) : null)
    }

    function TabooForm({ aid, act, onDone, limit = DEFAULT_LIMITS.tabooText }) {
      const [text, setText] = useState('')
      const [level, setLevel] = useState('soft')
      const [err, setErr] = useState('')
      const [ok, setOk] = useState('')
      const [busy, setBusy] = useState(false)
      async function add() {
        setErr(''); setOk('')
        if (!text.trim()) { setErr('先写一条线，再点加一条。比如「别提家人去世」。'); return }
        if (busy) return
        setBusy(true)
        try {
          await act(() => call('POST', '/v1/agents/' + enc(aid) + '/taboos', { text: text.trim(), level }, true))
          setOk('已加：' + (level === 'root' ? 'root（一票否决）' : 'soft（会被 G1 记下来）'))
          setText(''); onDone()
        } catch (e) { setErr(e.message) } finally { setBusy(false) }
      }
      return h('div', null,
        h('div', { className: 'dshc-form', style: { marginTop: 8 } },
          h(Input, {
            className: 'grow', placeholder: '禁忌内容，比如「别提家人去世」', value: text, maxLength: limit,
            onChange: (e) => { setText(e.target.value); if (err) setErr('') },
            onKeyDown: (e) => { if (e.key === 'Enter') add() },
          }),
          h(CharCount, { value: text, limit }),
          h('select', {
            className: 'dshc-sel', style: { width: 88 }, value: level, onChange: (e) => setLevel(e.target.value),
          }, h('option', { value: 'soft' }, 'soft'), h('option', { value: 'root' }, 'root')),
          h(Btn, { onClick: add, disabled: busy }, busy ? '加入中…' : '加一条')),
        ok ? h('div', { className: 'dshc-note' }, ok) : null,
        err ? h('div', { className: 'dshc-err' }, err) : null)
    }

    /* ---------------------------------------------- 它觉得你：一条判断的对错 */

    /**
     * 銆岀寽寰楀鍚椼€嶏細瀵?→璁版垚鍛戒腑锛涗笉瀵?→鍏堥€変綘鐪熸湁鐨勯偅涓儏缁紝鍐嶅洖鍐欍€?     * compact 缁欐渶杩戜簨浠跺垪琛ㄧ敤锛氬钩鏃跺彧闇蹭袱涓皬鎸夐挳锛岀偣銆屼笉瀵广€嶆墠灞曞紑鍏被銆?     */
    function ReadFeedback({ aid, item, act, onChange, compact }) {
      const [picking, setPicking] = useState(false)
      const [busy, setBusy] = useState(false)
      const [actual, setActual] = useState('')
      const [note, setNote] = useState('')
      const [err, setErr] = useState('')
      const fb = item && item.feedback

      async function send(body) {
        if (busy || !item) return
        setErr(''); setBusy(true)
        try {
          await act(() => call('POST', '/v1/agents/' + enc(aid) + '/affect/feedback',
            { episode_id: item.episode_id, ...body }, true))
          setPicking(false); setActual(''); setNote('')
          if (onChange) onChange()
        } catch (e) { setErr(e.message) } finally { setBusy(false) }
      }

      if (!item || !item.dist) return null

      if (fb && !picking) {
        return h('div', { className: 'dshc-read' },
          h('div', { className: 'dshc-read-line' },
            h('span', { className: 'dshc-sub' },
              (compact ? '你说是「' : '记下了：你说此刻是「') + (AFFECT_KEY[fb.actual_label] || fb.actual_label) + '」' +
              (fb.correct ? '，它猜对了' : '')),
            h(Btn, { sm: true, onClick: () => { setPicking(true); setActual(fb.actual_label) } }, '改'),
            h(Btn, { sm: true, ghost: true, onClick: () => send({ clear: true }) }, '撤销')),
          err ? h('div', { className: 'dshc-err' }, err) : null)
      }

      if (picking) {
        return h('div', { className: 'dshc-read' },
          h('div', { className: 'dshc-read-pick' },
                  h('div', { className: 'dshc-sub' }, '它自己此刻'),
            h('div', { className: 'dshc-form', style: { marginTop: 7 } },
              AFFECT_ORDER.map((k) => h(Btn, {
                key: k, sm: true, primary: actual === k,
                onClick: () => setActual(k),
              }, AFFECT_KEY[k]))),
            h('div', { className: 'dshc-form', style: { marginTop: 8 } },
              h(Input, {
                className: 'grow', value: note, maxLength: 40, disabled: busy,
                placeholder: '想补一句也行：它下次会更懂（可不填）',
                onChange: (e) => setNote(e.target.value),
              }),
              h(Btn, { primary: true, disabled: !actual || busy, onClick: () => send({ actual_label: actual, note }) }, '记下，让它学'),
              h(Btn, { onClick: () => { setPicking(false); setErr('') } }, '算了')),
            err ? h('div', { className: 'dshc-err' }, err) : null))
      }

      return h('div', { className: 'dshc-read' },
        h('div', { className: 'dshc-read-line' },
          h('span', { className: 'dshc-sub' }, compact ? '猜得对吗' : '猜得对吗？'),
          h('span', { className: 'dshc-read-mini' },
            h(Btn, { sm: compact, onClick: () => send({ correct: true }) }, compact ? '对' : '对，就是这样'),
            h(Btn, { sm: compact, tint: true, onClick: () => { setPicking(true); setActual('') } }, compact ? '不对' : '不太对，我其实是…'))),
        err ? h('div', { className: 'dshc-err' }, err) : null)
    }

    /* ============================================================= affect */

    /* ============================================================ 三观 */
    // 椤甸潰鍙 /sangguan/* 鎶曞奖锛屼笉鍦ㄥ墠绔噸绠椾换浣曢椄闂ㄦ垨璁℃暟锛涚敤鎴疯鍥鹃浂鏈锛宼ech 瑙嗗浘鎵嶉湶绗﹀彿涓?id

    const SG_LAYER = { W: '世界观', L: '人生观', V: '价值观' }
    const SG_LEAD = { W: '它认定世界是这样的', L: '它觉得自己是来', V: '它此刻更看重' }
    const SG_CORE = { W: 'core', L: 'telos', V: 'principle' }
    const SG_STATUS = {
      active: '', contested: '在争', provisional: '试用中', superseded: '后来改了看法', falsified: '后来发现不对',
      sublated: '已被更完整的看法吸收', demoted: '旧地图', withdrawn: '试过，没站住',
    }
    const SG_SIGMA = { struggle: '正在想', suspended: '先放着', coexist: '两样都要', sub_trial: '找到一个说法，正在试', resolved: '已有结论', sublated: '想通了' }
    const SG_BRANCH = { RESOLVE: '分出了高下', SUB: '找了个合起来的说法', COEX: '决定两样都要', SUSPEND: '先放下了' }
    const SG_TURN = ['SUB_CONFIRM', 'ELEV_COMMIT', 'COEX', 'RESOLVE', 'CORE_ESTABLISH']
    // 缁堟€佸懡棰樺彧杩涢摼娴忚涓庡彶锛屼笉涓婁富鍖?''
              const SG_TERMINAL_OF = (s) => ['superseded', 'falsified', 'sublated', 'demoted', 'withdrawn'].includes(s)
    const sgRank = (a, b) => (b.e - a.e) || (b.pi - a.pi) || String(b.id).localeCompare(String(a.id))
    const sgDay = (iso) => String(iso || '').slice(0, 10)

    function SgClaim({ c, tech, onOpen, onWithdraw, big }) {
      const st = SG_STATUS[c.status] || ''
      const hollow = c.origin === 'seed' && c.pi === 0 && c.n === 0 && c.status === 'active'
      return h('div', {
        className: 'dshc-row', role: 'button', tabIndex: 0, style: { cursor: 'pointer', alignItems: 'baseline' },
        onClick: () => onOpen && onOpen(c.id),
      },
        h('span', { style: { flex: 1, fontSize: big ? 15 : 13, fontWeight: big ? 600 : 400, lineHeight: 1.55 } }, c.text),
        c.review ? h(Pill, { tone: 'warn' }, '在重新核对') : null,
        hollow ? h(Pill, null, '尚未立论') : null,
        st ? h(Pill, { tone: c.status === 'contested' ? 'warn' : undefined }, st) : null,
        hollow && onWithdraw ? h(Btn, { sm: true, onClick: (e) => { e.stopPropagation(); onWithdraw(c) } }, '撤回') : null,
        tech ? h('span', { className: 'v dshc-mono' }, 'π ' + Number(c.pi).toFixed(2) + ' · n ' + c.n + ' · ' + c.kind + ' · ' + c.id) : null)
    }

    /** 两极对峙卡：在争 / 先放着 / 试用中（待验证）/ 两样都要 + 代价 */
    function SgPair({ k, tech, onOpen, onWithdraw, precedent }) {
      const word = k.sigma === 'sub_trial' && k.dormant_since ? '待验证' : (SG_SIGMA[k.sigma] || k.sigma)
      const lean = k.loss && k.loss.lean_pole ? (k.loss.lean_pole === 'pos' ? k.pos.text : k.neg.text) : ''
      return h(Card, { style: { marginBottom: 8 } },
        h('div', { className: 'dshc-sub', style: { marginBottom: 6 } }, k.q ? '「' + k.q + '」' : '两种看法', '　', h(Pill, { tone: k.sigma === 'struggle' ? 'warn' : undefined }, word)),
        h('div', { style: { display: 'flex', gap: 10, alignItems: 'stretch' } },
          h('div', { style: { flex: 1, cursor: 'pointer' }, onClick: () => onOpen(k.pos.id) }, k.pos.text),
          h('div', { className: 'dshc-sub', style: { alignSelf: 'center' } }, k.sigma === 'coexist' ? '和' : '还是'),
          h('div', { style: { flex: 1, cursor: 'pointer', textAlign: 'right' }, onClick: () => onOpen(k.neg.id) }, k.neg.text)),
        k.sub_id ? h('div', { className: 'dshc-note', style: { cursor: 'pointer' }, onClick: () => onOpen(k.sub_id) },
          (k.sigma === 'sublated' ? '想通了：' : '正在试的说法：') + (k.sub || '')) : null,
        k.sigma === 'coexist' && k.loss ? h('div', { className: 'dshc-note' },
          '平时偏向「' + lean + '」' + (k.loss.cost ? '，付出的是' + k.loss.cost : '') + '。') : null,
        precedent !== undefined ? h('div', { className: 'dshc-note' }, precedent || '没有可参照的旧事。') : null,
        tech ? h('div', { className: 'dshc-sub dshc-mono' }, k.id + ' · σ=' + k.sigma + ' · π⁺' + k.pos.pi.toFixed(2) + ' / π⁻' + k.neg.pi.toFixed(2)
          + (k.trial_until ? ' · 试用至 ' + sgDay(k.trial_until) : '') + ' · 审议 ' + (k.deliberations || 0) + ' 次') : null)
    }

    /** 鏃х淮搴︿华琛紙涓夎寮曟搸涔嬪墠鐨勫崄缁翠环鍊?/ 鍏淮涓栫晫 / 涓冪淮浜虹敓锛夛紝鍙 */
    function SgSideMeter({ vals, world, life }) {
      const lp = life || {}
      const lifeRows = Array.isArray(lp) ? lp : (lp.items || [])
      const box = (title, rows) => h('div', { style: { flex: '1 1 150px', minWidth: 150 } },
        h('div', { className: 'dshc-sub', style: { textAlign: 'center' } }, title),
        h(ValuesRadar, { rows: rows || [], size: 140 }))
      return h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 12 } },
        box('世界（旧八维）', world), box('人生（旧七维）', lifeRows), box('价值（旧十维）', vals))
    }

    function SgSeed({ label, layer, base, act, done }) {
      const [text, setText] = useState('')
      const t = text.trim()
      return h('div', null,
        h('div', { className: 'dshc-sub' }, label + '：尚未立论。可以先种一句，之后看事实怎么说。'),
        h('div', { className: 'dshc-row', style: { gap: 6, marginTop: 4 } },
          h('input', { className: 'dshc-in', style: { flex: 1 }, value: text, maxLength: 200, placeholder: '一句话（4–200 字）', onChange: (e) => setText(e.target.value) }),
          h(Btn, { sm: true, disabled: t.length < 4, onClick: () => act(() => call('POST', base + '/seed', { layer, text: t }, true)).then(() => { setText(''); done() }).catch(() => {}) }, '种下')))
    }

    /**
     * 涓変釜鏁帮細瀹冩湁娌℃湁涓哄摢鍙ヨ瘽鐪熺殑浠樿繃璐︺€?     * 杩濊儗 / 鍏戠幇 / 鏀逛富鎰忥紝鍏ㄩ儴鍙?/sangguan/scorecard 鐨勬湇鍔＄鐜扮畻缁撴灉锛屽墠绔彧鍋氭樉绀猴紝涓嶉噸绠椼€?     * 娌″彂鐢熻繃灏卞啓 0锛屼笉鍐欍€屾殏鏃犮€嶁€斺€? 鏄疄璇濓紝鍚硦涓嶆槸銆?     */
    function SgLedgerBar({ sc, tech }) {
      if (!sc) return null
      const v = sc.violated || {}
      const n = sc.nu || {}
      const c = sc.changed || {}
      const rate = n.kept_rate == null ? '还没到期' : Math.round(n.kept_rate * 100) + '%'
      const item = (label, value, note, tone) => h('div', { style: { flex: '1 1 128px', minWidth: 118 } },
        h('div', { className: 'dshc-sub' }, label),
        h('div', { style: { fontSize: 19, fontWeight: 600, lineHeight: 1.35, color: tone || 'inherit', fontVariantNumeric: 'tabular-nums' } }, value),
        h('div', { className: 'dshc-note', style: { marginTop: 2 } }, note))
      const ready = (sc.kernel && sc.kernel.ready) || false
      const four = sc.kernel ? ['pain', 'debt', 'revision', 'tension'].filter((k) => sc.kernel[k]).length : 0
      return h('div', { style: { marginBottom: 10 } },
        h('div', { style: { display: 'flex', gap: 18, flexWrap: 'wrap' } },
          item('说过的没做到', (v.total || 0) + ' 次', v.window ? '近 30 天 ' + v.window + ' 次' : '近 30 天没有', v.total ? 'var(--warn)' : null),
          item('答应的事兑现了', rate, n.settled ? '到期 ' + n.settled + ' 件：对 ' + (n.hit || 0) + '、没对 ' + (n.miss || 0) : '还没有到期的承诺'),
          item('自己改了主意', (c.total || 0) + ' 次', c.window ? '近 30 天 ' + c.window + ' 次' : '近 30 天没有'),
          tech ? h('div', { className: 'dshc-sub dshc-mono', style: { flex: '1 1 100%', alignSelf: 'flex-end' } },
            'VIOLATE ' + (v.total || 0) + ' · 结算 ' + (n.settled || 0) + '（hit ' + (n.hit || 0) + ' / miss ' + (n.miss || 0) + ' / pending ' + (n.pending || 0) + '）'
            + ' · 自改 ' + (c.self || 0) + ' / 人替 ' + (c.owner || 0) + ' · 闸门四点 ' + (ready ? '齐' : four + '/4')) : null),
        h('details', { className: 'dshc-fold', style: { marginTop: 2 } },
          h('summary', null, '这三个数怎么来的'),
          h('div', { className: 'dshc-note' },
            '说过的没做到：它自己认下的话，跟实际回复对不上的次数，每记一笔都要有原句。'
            + '答应的事兑现了：它说过「我明天…」这类带期限的话，到期看有没有做到；只算已经到期的，没到期的不能算数，所以这里可能是「还没到期」。'
            + '自己改了主意：它主动改说法、升维、认下合题的次数。人替它收掉的旧账不算在这里。'
            + '三个数都是 0 的时候，是它还没为自己的哪句话付过账，不是没记。')))
    }

    /* ---- 涓夊垪鍒ゆ嵁 + 鑽夌鏀朵欢绠?---- */
    const SG_LANE = {
      W: { name: '世界观', judge: '能预测事、经得起撞', how: '它先猜世界怎样，再看后来对不对；猜错也算数。', empty: '还没碰到需要它解释世界的冲突' },
      L: { name: '人生观', judge: '走过哪几章、花了多久', how: '不是它说想成为谁，是它把日子真的花在哪。', empty: '还没想清楚自己要来做什么' },
      V: { name: '价值观', judge: '选了这边、放弃了什么', how: '不是词表，是冲突时它真让了哪一步。', empty: '这段时间没出现让它非选不可的取舍' },
    }
    const SG_IDX = { W: '01', L: '02', V: '03' }
    const SG_GATE = [
      ['g1', '有另一条路', '当时也可以不那么做'],
      ['g2', '说了代价', '放弃了什么，要具体'],
      ['g3', '能排除', '读得出「不会怎么做」'],
      ['g4', '不是工作说明', '把项目、代码抽掉还成立'],
      ['g5', '有生活作证', '自动要两条跨天；手写要一条真事 + 你认'],
    ]

    function SgGates({ gates }) {
      return h('div', { className: 'dshc-gatebar' },
        SG_GATE.map(([k, label, hint]) => h('span', {
          key: k,
          className: 'dshc-gate' + (gates && gates[k] ? ' on' : ''),
          title: (gates && gates[k] ? '过了：' : '还差：') + hint,
        }, label)))
    }

    /** 涓€鏉¤崏绋匡細姝ｆ枃 / 鍙︿竴鏉¤矾 / 浠ｄ环 / 杈圭晫 / 璇佹嵁 / 浜旈椄锛涙敼鍒板叏杩囨墠鑳藉叆搴撱€?*/
    function SgDraftCard({ d, base, act, tech, onDone, setMsg }) {
      const [edit, setEdit] = useState(false)
      const [f, setF] = useState({
        text: d.text, alt: d.alt || '', foregone: d.foregone || '', cost_to: d.cost_to || '',
        exclusion: d.exclusion || '', counterexample: d.counterexample || '', vouch: d.vouch === true,
      })
      const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }))
      const save = () => act(() => call('POST', base + '/drafts/' + enc(d.id) + '/patch', f, true))
        .then(() => { setEdit(false); onDone() })
        .catch((e) => setMsg(e.message || String(e)))
      const commit = () => act(() => call('POST', base + '/drafts/' + enc(d.id) + '/commit', {}, true))
        .then(() => { setMsg('入库了。这一条以后会出现在「你更看重」里。'); onDone() }).catch((e) => setMsg(e.message || String(e)))
      const drop = () => act(() => call('POST', base + '/drafts/' + enc(d.id) + '/discard', {}, true))
        .then(() => { setMsg('丢掉了。'); onDone() })
        .catch((e) => setMsg(e.message || String(e)))
      const pass = !!(d.gates && d.gates.pass)
      return h('div', { className: 'dshc-pkt' + (pass ? '' : ' blocked') },
        h('div', { className: 'dshc-pkt-t' },
          h('span', null, d.source === 'manual' ? '手写' : '自动'),
          h('span', null, d.kind || '其他'),
          h('span', { className: 'st ' + (pass ? 'ok' : 'hold') }, pass ? '五闸全过' : '待补闸')),
        edit
          ? h('div', null,
            h('div', { className: 'dshc-sub' }, '正文（6–120 字）'),
            h('textarea', { className: 'dshc-ta', value: f.text, maxLength: 120, onChange: set('text'), style: { width: '100%', minHeight: 54 } }),
            h('div', { className: 'dshc-sub' }, '当时另一条路'),
            h('input', { className: 'dshc-in', value: f.alt, maxLength: 200, onChange: set('alt'), style: { width: '100%' } }),
            h('div', { className: 'dshc-sub' }, '放弃了什么'),
            h('input', { className: 'dshc-in', value: f.foregone, maxLength: 200, onChange: set('foregone'), style: { width: '100%' } }),
            h('div', { className: 'dshc-sub' }, '所以这件事上不会怎么做'),
            h('input', { className: 'dshc-in', value: f.exclusion, maxLength: 200, onChange: set('exclusion'), style: { width: '100%' } }),
            d.source === 'manual' ? h('label', { style: { display: 'block', marginTop: 6, fontSize: 13 } },
              h('input', { type: 'checkbox', checked: f.vouch, onChange: (e) => setF((x) => ({ ...x, vouch: e.target.checked })) }), ' 这条我认，愿意为它付代价') : null,
            h('div', { style: { marginTop: 8 } },
              h(Btn, { sm: true, onClick: save }, '存好'),
              h(Btn, { sm: true, ghost: true, onClick: () => setEdit(false) }, '算了')))
          : h('div', null,
            h('div', { style: { fontSize: 14, fontWeight: 600, lineHeight: 1.55 } }, d.text),
            (d.vouch || !pass) ? h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', margin: '4px 0' } },
              d.vouch ? h(Pill, null, '你认过') : null,
              pass ? null : h(Pill, { tone: 'warn' }, '还差几道')) : null,
            d.alt ? h('div', { className: 'dshc-note' }, '另一条路：' + d.alt) : null,
            d.foregone ? h('div', { className: 'dshc-note' }, '放弃了：' + d.foregone + (d.cost_to ? '（落在' + d.cost_to + '身上）' : '')) : null,
            d.exclusion ? h('div', { className: 'dshc-note' }, '所以这件事上不会：' + d.exclusion) : null,
            h('div', { style: { marginTop: 6 } }, h(SgGates, { gates: d.gates })),
            (d.evidence || []).length ? h('div', { className: 'dshc-sub', style: { marginTop: 6 } },
              (d.evidence || []).slice(0, 3).map((e, i) => h('div', { key: i }, '· ' + (e.at || '') + ' ' + String(e.quote || '').slice(0, 70)))) : null,
            h('div', { style: { marginTop: 8 } },
              h(Btn, { sm: true, onClick: () => setEdit(true) }, '改'),
              h(Btn, { sm: true, disabled: !pass, onClick: commit }, '入库'),
              h(Btn, { sm: true, ghost: true, onClick: drop }, '丢掉')),
            tech ? h('div', { className: 'dshc-sub dshc-mono' }, d.id + ' · ' + d.source + ' · vouch=' + d.vouch + ' · batch=' + (d.batch_key || '-') + ' · gates=' + ['g1', 'g2', 'g3', 'g4', 'g5'].map((k) => (d.gates && d.gates[k] ? 1 : 0)).join('')) : null))
    }

    /** 手写一条：字段按五闸排，边写边知道还差什么。 */
    function SgDraftNew({ base, act, onDone, setMsg }) {
      const [f, setF] = useState({
        text: '', alt: '', foregone: '', cost_to: '', exclusion: '', counterexample: '',
        vouch: false, at: '', quote: '',
      })
      const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }))
      const submit = () => act(() => call('POST', base + '/drafts', {
        text: f.text, alt: f.alt, foregone: f.foregone, cost_to: f.cost_to,
        exclusion: f.exclusion, counterexample: f.counterexample, vouch: f.vouch,
        evidence: f.quote.trim() ? [{ at: f.at, quote: f.quote }] : [],
      }, true)).then((r) => {
        if (r && r.duplicate) setMsg('这条已经在箱子里了。')
        else {
          setMsg(r && r.draft && r.draft.gates.pass ? '存进去了，五闸全过。' : '存进箱了；还差的那几道，旁边写着缺什么。')
          setF({ text: '', alt: '', foregone: '', cost_to: '', exclusion: '', counterexample: '', vouch: false, at: '', quote: '' })
        }
        onDone()
      }).catch((e) => setMsg(e.message || String(e)))
      return h('div', { className: 'dshc-term' },
        h('div', { className: 'lbl' },
          h('span', null, 'NEW ENTRY'),
          h('span', { style: { marginLeft: 'auto', opacity: .8 } }, '手写')),
        h('div', { className: 'dshc-sub' }, '写一条你自己的判断。要能说出「当时还有另一条路」和「为此放弃了什么」，不然只是一句口号。'),
        h('textarea', { className: 'dshc-ta', value: f.text, maxLength: 120, placeholder: '那句话本身（6–120 字）', onChange: set('text'), style: { width: '100%', minHeight: 54, marginTop: 6 } }),
        h('div', { className: 'dshc-sub', style: { marginTop: 6 } }, '当时另一条路'),
        h('input', { className: 'dshc-in', value: f.alt, maxLength: 200, placeholder: '另一个也说得通的做法', onChange: set('alt'), style: { width: '100%' } }),
        h('div', { className: 'dshc-sub', style: { marginTop: 6 } }, '为此放弃了什么'),
        h('input', { className: 'dshc-in', value: f.foregone, maxLength: 200, placeholder: '时间 / 面子 / 省事 / 被喜欢……要具体', onChange: set('foregone'), style: { width: '100%' } }),
        h('div', { className: 'dshc-sub', style: { marginTop: 6 } }, '所以这件事上不会怎么做'),
        h('input', { className: 'dshc-in', value: f.exclusion, maxLength: 200, placeholder: '读得出来的那条界线', onChange: set('exclusion'), style: { width: '100%' } }),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 } },
          h('input', { className: 'dshc-in', type: 'date', value: f.at, onChange: set('at'), style: { flex: '0 0 150px' } }),
          h('input', { className: 'dshc-in', value: f.quote, maxLength: 200, placeholder: '那天的一句原话（证据）', onChange: set('quote'), style: { flex: '1 1 220px' } })),
        h('label', { style: { display: 'block', marginTop: 8, fontSize: 13 } },
          h('input', { type: 'checkbox', checked: f.vouch, onChange: (e) => setF((x) => ({ ...x, vouch: e.target.checked })) }), ' 这条我认，愿意为它付代价'),
        h('div', { style: { marginTop: 8 } }, h(Btn, { sm: true, primary: true, onClick: submit }, '放进草稿箱')))
    }

    function SangguanPage({ aid, view, act }) {
      const tech = view === 'tech'
      const base = '/v1/agents/' + enc(aid) + '/sangguan'
      const [tick, setTick] = useState(0)
      const bump = () => setTick((t) => t + 1)
      const [st, reloadSt] = useAsync(() => call('GET', base + '/status'), [aid, tick])
      const on = !!(st.data && st.data.enabled)
      const get = (p) => () => (on ? call('GET', base + p) : null)
      const [hd] = useAsync(get('/heads'), [aid, tick, on])
      const [kp] = useAsync(get('/kappa'), [aid, tick, on])
      const [pc] = useAsync(get('/precedents'), [aid, tick, on])
      const [pr] = useAsync(get('/predictions'), [aid, tick, on])
      const [ep] = useAsync(get('/epochs'), [aid, tick, on])
      const [lv] = useAsync(get('/liveness'), [aid, tick, on])
      const [tl] = useAsync(get('/timeline?days=365'), [aid, tick, on])
      const [ln] = useAsync(get('/lanes'), [aid, tick, on])
      const [dr] = useAsync(get('/drafts'), [aid, tick, on])
      const [recallQ, setRecallQ] = useState('')
      const [recallR, setRecallR] = useState(null)
      const [newOpen, setNewOpen] = useState(false)
      const [el] = useAsync(get('/elev'), [aid, tick, on])
      const [evBefore, setEvBefore] = useState(0)
      const [ev] = useAsync(() => (on && tech ? call('GET', base + '/events?limit=30' + (evBefore ? '&before=' + evBefore : '')) : null), [aid, tick, on, tech, evBefore])
      const [pv] = useAsync(() => (on && tech ? call('GET', base + '/inject/preview') : null), [aid, tick, on, tech])
      const [vals] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/values'), [aid])
      const [world] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/worldview'), [aid])
      const [life] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/lifeview'), [aid])
      const [open, setOpen] = useState(null)
      const [chain] = useAsync(() => (on && open ? call('GET', base + '/claims/' + enc(open) + '/chain') : null), [aid, tick, on, open])
      const [why] = useAsync(() => (on && open ? call('GET', base + '/claims/' + enc(open) + '/explain') : null), [aid, tick, on, open])
      const [turnLayer, setTurnLayer] = useState('all')
      const [turnN, setTurnN] = useState(30)
      const [msg, setMsg] = useState('')
      /* 璧疯崏鏄悗鍙拌窇鐨勶細寮€鐫€杩欐潯椤甸潰灏遍殧鍑犵鐪嬩竴鐪硷紝璺戝畬鑷姩鍒峰嚭鏉?*/
      const jobRunning = !!(st.data && st.data.drafts && st.data.drafts.job && st.data.drafts.job.status === 'running')
      const jobLive = useRef(false)
      jobLive.current = jobRunning
      useLive(useCallback(() => { if (jobLive.current) bump() }, []), 4000)

      const side = h('details', { className: 'dshc-fold', style: { marginTop: 8 } },
        h('summary', null, '旧维度仪表（只读，仅供参照）'),
        h(SgSideMeter, { vals: vals.data, world: world.data, life: life.data }))

      if (st.loading && !st.data) return h(Empty, null, '读取三观…')
      if (st.error && !st.data) return h(LoadErr, { error: st.error, retry: reloadSt })
      if (!on) {
        return h('div', null,
          h(Sec, {
            title: '三观', desc: '三观引擎未启用：下面是旧的维度仪表。打开后它会从对话里慢慢长出自己的看法，先观察 7 天再真正进入说话。',
            right: h(Btn, { primary: true, onClick: () => act(() => call('PUT', base + '/config', { enabled: true }, true)).then(bump).catch(() => {}) }, '打开三观引擎'),
          }, h(Card, null, h(SgSideMeter, { vals: vals.data, world: world.data, life: life.data }))))
      }

      const S = st.data
      const layers = (hd.data && hd.data.layers) || {}
      const kappas = (kp.data && kp.data.kappas) || []
      const pIdx = new Map(((pc.data && pc.data.precedents) || []).map((p) => [p.id, p]))
      const cuts = (ep.data && ep.data.cuts) || []
      const summaries = (ep.data && ep.data.summaries) || []
      const days = (tl.data && tl.data.days) || []
      const allEv = days.flatMap((d) => d.events)
      const onOpen = (id) => setOpen((o) => (o === id ? null : id))
      const live = (l) => (layers[l] || []).filter((c) => !SG_TERMINAL_OF(c.status))
      const cores = (l) => live(l).filter((c) => c.kind === SG_CORE[l] && c.status === 'active').sort(sgRank)
      // 鎵胯锛坘ind=commit锛変笉绠椾环鍊艰锛氬畠鏄埌鐐硅鍏戠幇鐨勪竴绗旇处锛屽彧鍦ㄣ€岄瑙佷笌鍥炴祦銆嶉噷闇?''
              const belts = (l, kind) => live(l).filter((c) => c.kind !== SG_CORE[l] && c.kind !== 'commit' && (!kind || c.kind === kind)).sort(sgRank)
      const kOf = (l, pred) => kappas.filter((k) => k.layer === l && (!pred || pred(k)))
      const cap = (arr) => (tech ? arr : arr.slice(0, 5))

      async function withdraw(c) {
        try {
          await act(() => call('POST', base + '/claims/' + enc(c.id) + '/withdraw', {}, true))
          setMsg('已撤回')
          bump()
        } catch (e) { setMsg(e.message || String(e)) }
      }
      const onWithdraw = withdraw
      async function judge(body, okText) {
        try {
          const r = await act(() => call('POST', base + '/verdict', body, true))
          setMsg(r && r.counted ? okText : '今天已经记过这一条了，明天再说。')
          bump()
        } catch (e) { setMsg(e.message || String(e)) }
      }
      const precedentLine = (k) => {
        const ps = (k.precedent_ids || []).map((id) => pIdx.get(id)).filter(Boolean).sort((a, b) => Math.abs(b.o) - Math.abs(a.o) || String(b.at).localeCompare(String(a.at)))
        const p = ps[0]
        if (!p) return ''
        return '上回类似的事「' + (p.q || p.pos) + '」，' + (SG_BRANCH[p.branch] || '做了决定') + '，' + (p.o > 0 ? '后来证明还行' : p.o < 0 ? '后来发现不太对' : '结果还没出来') + '。'
      }

      // ---- 三列：每列一种判据，不再共用「像不像立场」这一把尺 ----
      const stamp = (l) => {
        const c = cuts.filter((x) => x.layer === l).pop()
        const n = (S.epoch && S.epoch[l]) || 0
        return '第 ' + n + ' 季 · ' + (c ? '自' + sgDay(c.at) : '自启用起')
      }
      const established = (c) => !(c.origin === 'seed' && c.pi === 0 && c.n === 0)
      const stats = (ln.data && ln.data.stats) || {}
      const laneOnOf = (l) => !!(S.lanes && S.lanes[l])
      async function toggleLane(l, v) {
        try {
          await act(() => call('PUT', base + '/config', { lanes: { ...(S.lanes || {}), [l]: v } }, true))
          setMsg(v ? SG_LAYER[l] + '这一列打开了。' : SG_LAYER[l] + '这一列关上了。')
          bump()
        } catch (e) { setMsg(e.message || String(e)) }
      }
      /* 銆屾€庝箞闀垮嚭鏉ョ殑銆嶅彧鎶ュ凡缁忓彂鐢熺殑鏁帮紝涓嶈閬撶悊锛涙病鏈夊氨璇存病鏈夈€?*/
      const statLine = (l) => {
        const st = stats[l] || {}
        if (l === 'W') {
          if (!st.claims) return '还没有能拿去检验的看法。'
          const nu = st.nus || {}
          return '认下 ' + st.claims + ' 条 · ' + (st.scenes || 0) + ' 个场景里都这样 · 预言 ' + (nu.settled || 0) + ' 次，对了 ' + (nu.hit || 0) + ' 次'
        }
        if (l === 'L') {
          return st.claims ? ('近 30 天有 ' + (st.invest_days || 0) + ' 天在真的检验 · 写成 ' + st.claims + ' 章') : '还没有成章的经历。'
        }
        return '草稿 ' + (st.drafts || 0) + ' 条等你批 · 已经入库 ' + (st.committed || 0) + ' 条'
      }
      const col = (l) => {
        const cs = cores(l).filter(established)
        const bs = belts(l).filter(established)
        const ks = kOf(l).filter((k) => k.open)
        const on = laneOnOf(l)
        return h('section', { key: l, className: 'dshc-sgcol', 'data-l': l },
          h('i', { className: 'dshc-scan' }),
          h('div', { className: 'dshc-sghead' },
            h('span', { className: 'dshc-sgidx' }, SG_IDX[l]),
            h('h2', null, SG_LAYER[l]),
            h('i', { className: 'dshc-sgdot' + (on ? ' on' : '') }),
            h('span', { className: 'dshc-sgst' + (on ? ' on' : '') }, on ? 'ON' : 'IDLE'),
            h('span', { className: 'dshc-sub', style: { marginLeft: 'auto' } }, stamp(l))),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            h(Pill, { tone: on ? undefined : 'warn' }, on ? '开着' : '还没开'),
            h('span', { className: 'dshc-sub' }, '看的是：' + SG_LANE[l].judge)),
          cs.length ? cs.map((c) => h(SgClaim, { key: c.id, c, tech, onOpen, onWithdraw, big: true }))
            : h('div', null,
              h('div', { style: { fontSize: 14, fontWeight: 600 } }, '尚未立论'),
              h('div', { className: 'dshc-sub' }, SG_LANE[l].empty),
              h(SgSeed, { label: SG_LEAD[l], layer: l, base, act, done: bump })),
          l === 'W' && bs.length ? h('div', null, cap(bs).map((c) => h(SgClaim, { key: c.id, c, tech, onOpen, onWithdraw }))) : null,
          l === 'L' && belts('L', 'role').length ? h('div', null,
            h('div', { className: 'dshc-sub' }, '它在关系里的角色'),
            cap(belts('L', 'role')).map((c) => h(SgClaim, { key: c.id, c, tech, onOpen, onWithdraw }))) : null,
          l === 'V' && belts('V', 'norm').length ? h('div', null,
            h('div', { className: 'dshc-sub' }, '平时怎么做'),
            cap(belts('V', 'norm')).map((c) => h(SgClaim, { key: c.id, c, tech, onOpen, onWithdraw }))) : null,
          l === 'V' && belts('V', 'ideal').length ? h('div', null,
            h('div', { className: 'dshc-sub' }, '仰望什么'),
            cap(belts('V', 'ideal')).map((c) => h(SgClaim, { key: c.id, c, tech, onOpen, onWithdraw }))) : null,
          ks.length ? ks.slice(0, tech ? 3 : 1).map((k) => h(SgPair, { key: k.id, k, tech, onOpen, onWithdraw, precedent: precedentLine(k) })) : null,
          l === 'L' ? arc : null,
          h('div', { className: 'dshc-note' }, statLine(l)),
          h('div', { className: 'dshc-sub' }, SG_LANE[l].how),
          on ? null : h('div', null, h(Btn, { sm: true, ghost: true, onClick: () => toggleLane(l, true) }, '打开这一列')),
          tech ? h('div', { className: 'dshc-sub dshc-mono' }, 'lane=' + on + ' · claims=' + cs.length + ' · belts=' + bs.length + ' · kappas=' + ks.length) : null)
      }
      /* 鎷夸竴鍙ヨ瘽璇曞彫鍥烇細鐪嬪緱瑙佸畠杩欎竴浼氬効浼氭兂璧峰摢鏉★紝涔熺湅寰楄鍒殑娌¤濉炶繘鍘汇€?*/
      async function tryRecall() {
        const text = recallQ.trim()
        if (!text) return
        try {
          const [rec, pv] = await Promise.all([
            call('GET', base + '/recall?text=' + enc(text)),
            call('GET', base + '/inject/preview?text=' + enc(text)),
          ])
          setRecallR({
            text,
            core: (rec && rec.core) || [],
            picked: (rec && rec.picked) || [],
            lines: (pv && pv.view && pv.view.lines) || [],
            tokens: pv && pv.view ? pv.view.tokens : 0,
          })
        } catch (e) { setMsg(e.message || String(e)) }
      }

      // ---- 鍙欎簨寮?----
      const chapters = belts('L', 'chapter')
      const arc = h('div', null,
        summaries.length ? h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8 } },
          h('div', { style: { flex: '1 1 200px' } }, h('div', { className: 'dshc-sub' }, '当时它这样讲'), h('div', null, h('b', null, summaries[0].chapter || ''), '　', summaries[0].at_the_time || '')),
          h('div', { style: { flex: '1 1 200px' } }, h('div', { className: 'dshc-sub' }, '现在回头看'), h('div', null, summaries[0].hindsight || '')))
          : null,
        chapters.length ? cap(chapters).map((c) => h(SgClaim, { key: c.id, c, tech, onOpen, onWithdraw })) : h('div', { className: 'dshc-sub' }, '还没有成章的经历。'))

      // ---- 棰勮涓庡洖娴?----
      const preds = (pr.data && pr.data.predictions) || []
      /* 一条预见要说清三件事：等到哪天、结局是什么、凭什么这么判。分三列，不挤成一句。 */
      const PRED_VOID = {
        no_records: '没留下能查的记录，判不了',
        no_evidence: '材料不够判，不算猜错',
        no_ref: '引的记录对不上号，这次不算',
        claim_retired: '依附的那句话已经收回，不是判错',
        claim_merged: '并进了别的说法，不是判错',
      }
      /* 老账没写 why 的，靠命题正文「我答应…」认回承诺类，别把「没做到」写成「没对」 */
      const isPledge = (p, promised) => promised || p.why === 'pledge_done' || p.why === 'pledge_miss'
      const predTag = (p, promised) => {
        if (p.outcome === 'hit') return isPledge(p, promised) ? '做到了' : '对了'
        if (p.outcome === 'miss') return isPledge(p, promised) ? '没做到' : '没对'
        if (p.outcome === 'void') return '作废'
        return p.overdue ? '到期了' : '等着看'
      }
      const predNote = (p, promised) => {
        if (p.outcome === 'void') return PRED_VOID[p.why] || '作废时没记原因'
        if (p.outcome === 'hit') return isPledge(p, promised) ? '到期那晚看到了正面证据' : '到期那晚按记录判对了'
        if (p.outcome === 'miss') return isPledge(p, promised) ? '到期那晚没看到做到的证据' : '到期那晚记录对不上'
        if (p.overdue) return sgDay(p.due_at) + ' 就到期了，等夜里那一趟判'
        return sgDay(p.due_at) + ' 那天夜里判'
      }
      const predRow = (p) => {
        const promised = /^我答应/.test(p.claim || '')
        const body = promised ? String(p.claim).replace(/^我答应[：:]?/, '') : p.expect
        return h('div', { key: p.id, className: 'dshc-row', style: { alignItems: 'flex-start' } },
          h('span', { className: 'dshc-sub', style: { flex: '0 0 auto', minWidth: 54 } }, predTag(p, promised)),
          h('div', { style: { flex: 1 } },
            h('div', null, (promised ? '答应过：' : '预计：') + body),
            h('div', { className: 'dshc-sub' }, predNote(p, promised) + (promised ? '' : ' · 把握 ' + Math.round(p.p * 10) + ' 成'))),
          p.outcome === 'pending' ? h('span', { style: { flex: '0 0 auto', whiteSpace: 'nowrap' } },
            h(Btn, { sm: true, ghost: true, onClick: () => judge({ target_type: 'nu', target_id: p.id, sign: 1 }, '记下了：这条留作证据，到期那晚一起判。') }, '对'),
            h(Btn, { sm: true, ghost: true, onClick: () => judge({ target_type: 'nu', target_id: p.id, sign: -1 }, '记下了：这条留作证据，到期那晚一起判。') }, '不对')) : null,
          tech ? h('span', { className: 'v dshc-mono' }, p.id + (p.why ? ' ' + p.why : '')) : null)
      }
      const predList = !preds.length ? h('div', { className: 'dshc-sub' }, '还没做过可以检验的预料。') : (() => {
        const live = preds.filter((p) => p.outcome === 'pending')
        const done = preds.filter((p) => p.outcome !== 'pending')
        // 判了对错的排前面，作废的堆后面：作废是「没判成」，不该盖住真的结果
        const settled = [...done.filter((p) => p.outcome !== 'void'), ...done.filter((p) => p.outcome === 'void')]
        const take = (arr) => (tech ? arr : arr.slice(0, 8))
        const head = (title, rows) => title + '（' + rows.length + '）' + (!tech && rows.length > 8 ? '，只列最近 8 条' : '')
        return h('div', null,
          live.length ? h('div', null,
            h('div', { className: 'dshc-sub', style: { marginBottom: 4 } }, head('还在等', live)),
            h('div', { className: 'dshc-list' }, take(live).map(predRow))) : null,
          settled.length ? h('div', { style: { marginTop: live.length ? 10 : 0 } },
            h('div', { className: 'dshc-sub', style: { marginBottom: 4 } }, head('已经判过', settled)),
            h('div', { className: 'dshc-list' }, take(settled).map(predRow))) : null,
          h('div', { className: 'dshc-note', style: { marginTop: 8 } },
            '「对 / 不对」只是留一条证据，不当场改结果；到期那晚再看记录判。作废不算猜错，不进准确率。'))
      })()

      // ---- 瀹冩渶杩戝湪鎯充粈涔?----
      const answered = new Set(allEv.filter((e) => e.type === 'INQUIRY' && e.payload && e.payload.answer_of).map((e) => e.payload.answer_of))
      const asks = allEv.filter((e) => e.type === 'INQUIRY' && e.payload && e.payload.mode === 'ask' && e.payload.question && !answered.has(e.id)).slice(0, 3)
      const thinking = allEv.filter((e) => ['INQUIRY', 'KAPPA_OPEN', 'DELIBERATE', 'NU_RESOLVE'].includes(e.type) && !(e.payload && e.payload.answer_of)).slice(0, 5)
      const L = lv.data || {}
      const liveBox = h('div', null,
        asks.map((e) => h(Card, { key: e.id, style: { marginBottom: 8 } },
          h('div', null, '它想问你：', h('b', null, e.payload.question)),
          e.payload.target_type === 'claim' ? h('div', { style: { marginTop: 6 } },
            h(Btn, { sm: true, onClick: () => judge({ target_type: 'claim', target_id: e.payload.target_id, sign: 1, inquiry_id: e.id }, '对') }, '是这样'),
            h(Btn, { sm: true, ghost: true, onClick: () => judge({ target_type: 'claim', target_id: e.payload.target_id, sign: -1, inquiry_id: e.id }, '它听到了。') }, '不是这样')) : null)),
        thinking.length ? h('div', { className: 'dshc-list' }, thinking.map((e) => h('div', { key: e.id, className: 'dshc-row' },
          h('span', { className: 'l' }, sgDay(e.at).slice(5)), h('span', { style: { flex: 1 } }, e.word + (e.about.length ? '：' + e.about.join('；') : ''))))) : h('div', { className: 'dshc-sub' }, '最近很安静。'),
        tech && L.qi ? h(Tech, null, 'Qi ' + L.qi.qi + '（flow ' + L.qi.flow + ' · open ' + L.qi.open + ' · learn ' + L.qi.learn + ' · bal ' + L.qi.bal + '）'
          + ' · 用户活跃 ' + (L.user_active ? '是' : '否') + ' · r_J ' + (L.r_J == null ? '—' : L.r_J) + ' · 降权命题 ' + (L.low_weight || 0)
          + '\n' + ['W', 'L', 'V'].map((l) => l + ' churn ' + ((L.layers && L.layers[l] && L.layers[l].churn.churn) == null ? '—' : Number(L.layers[l].churn.churn).toFixed(2)) + (L.layers && L.layers[l] && L.layers[l].dogmatic ? ' 教条' : '')).join(' · ')) : null)

      // ---- 鍙诧細杞姌鏃堕棿绾?----
      const turns = allEv.filter((e) => SG_TURN.includes(e.type) && (turnLayer === 'all' || e.layer === turnLayer))
      const history = h('div', null,
        h(Seg, { items: [['all', '全部'], ['W', '世界观'], ['L', '人生观'], ['V', '价值观']], value: turnLayer, onChange: setTurnLayer }),
        !turns.length ? h('div', { className: 'dshc-sub', style: { marginTop: 8 } }, '还没有转折。') : h('div', { className: 'dshc-list', style: { marginTop: 8 } },
          turns.slice(0, turnN).map((e) => h('div', { key: e.id, className: 'dshc-row', style: { alignItems: 'baseline' } },
            h('span', { className: 'l' }, sgDay(e.at)),
            h('span', { style: { flex: 1 } }, (e.layer ? SG_LAYER[e.layer] + ' · ' : '') + e.word + (e.about.length ? '：' + e.about.join('；') : '')),
            tech ? h('span', { className: 'v dshc-mono' }, e.type + ' #' + e.seq) : null))),
        turns.length > turnN ? h(Btn, { ghost: true, sm: true, onClick: () => setTurnN((n) => n + 30) }, '再往前') : null,
        summaries.length > 1 ? h('details', { className: 'dshc-fold', style: { marginTop: 8 } }, h('summary', null, '更早的自传（' + (summaries.length - 1) + ' 段）'),
          summaries.slice(1).map((s) => h('div', { key: s.id, className: 'dshc-row' }, h('span', { className: 'l' }, sgDay(s.at)), h('span', { style: { flex: 1 } }, h('b', null, s.chapter || ''), '　', s.at_the_time || '', s.hindsight ? '（回头看：' + s.hindsight + '）' : ''),
            tech ? h('span', { className: 'v dshc-mono' }, '#' + s.from_seq + '–' + s.to_seq) : null))) : null)

      // ---- 閫変腑鍛介锛氫负浠€涔?+ 閾?+ 瀵?/ 涓嶅 ----
      const C = chain.data
      const drawer = open ? h(Card, { style: { marginTop: 8, borderColor: 'var(--accent)' } },
        chain.loading && !C ? h(Empty, null, '读取…') : chain.error ? h(LoadErr, { error: chain.error }) : C ? h('div', null,
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, C.claim.text, SG_STATUS[C.claim.status] ? h(Pill, null, SG_STATUS[C.claim.status]) : null),
          h('div', { className: 'dshc-note' }, why.data ? why.data.sentence : '…'),
          !SG_TERMINAL_OF(C.claim.status) ? h('div', { style: { margin: '6px 0' } },
            h(Btn, { sm: true, onClick: () => judge({ target_type: 'claim', target_id: C.claim.id, sign: 1 }, '对') }, '对'),
            h(Btn, { sm: true, ghost: true, onClick: () => judge({ target_type: 'claim', target_id: C.claim.id, sign: -1 }, '记下了：你觉得这一条不对。') }, '不对')) : null,
          C.ancestors.length || C.successors.length ? h('div', { className: 'dshc-list' },
            (C.ancestors.length > 12 ? [...C.ancestors.slice(0, 6), null, ...C.ancestors.slice(-6)] : C.ancestors).slice().reverse().map((a, i) => a
              ? h('div', { key: a.id, className: 'dshc-row', style: { cursor: 'pointer' }, onClick: () => setOpen(a.id) }, h('span', { className: 'l' }, '之前'), h('span', { style: { flex: 1 } }, a.text), h(Pill, null, SG_STATUS[a.status] || '在用'))
              : h('div', { key: 'gap' + i, className: 'dshc-sub' }, '…')),
            C.successors.map((a) => h('div', { key: a.id, className: 'dshc-row', style: { cursor: 'pointer' }, onClick: () => setOpen(a.id) }, h('span', { className: 'l' }, '之后'), h('span', { style: { flex: 1 } }, a.text), h(Pill, null, SG_STATUS[a.status] || '在用'))))
            : null,
          tech ? h(Tech, null, C.claim.id + ' · ' + C.claim.layer + '/' + C.claim.kind + ' · π ' + C.claim.pi + ' · e ' + C.claim.e + ' · 纪元 ' + C.claim.epoch + '\n'
            + C.events.slice(-12).map((e) => '#' + e.seq + ' ' + sgDay(e.at) + ' ' + e.type + (e.precedent_ids && e.precedent_ids.length ? ' 先例 ' + e.precedent_ids.join(',') : '')).join('\n')) : null)
          : null,
        h('div', { style: { textAlign: 'right' } }, h('a', { href: '#', onClick: (e) => { e.preventDefault(); setOpen(null) } }, '收起'))) : null

      // ---- tech锛氭敞鍏ラ瑙?/ 浣撳緛 / 浜嬩欢璐?/ 鎹唬瀹℃壒 ----
      const props = (el.data && el.data.proposals) || []
      const evs = (ev.data && ev.data.events) || []
      const techBox = tech ? h('div', null,
        h(Sec, { title: '注入（' + (S.inject.mode === 'live' ? '已进入说话' : '影子期') + '）', desc: '影子期 ' + S.inject.shadow_days + ' / 7 天' + (S.inject.ready ? '，可以切到真注入' : '') },
          h(Card, null, h(Tech, null, pv.data ? (pv.data.view.text || '（无链头，不注入）') + '\n—— ' + pv.data.view.tokens + ' / ' + pv.data.view.budget + ' tokens · 变动 ' + pv.data.log.changes + ' 次' : '——'),
            h('div', { style: { marginTop: 6 } }, h(Btn, {
              sm: true, ghost: true,
              onClick: () => act(() => call('PUT', base + '/config', { inject: S.inject.mode === 'live' ? 'shadow' : 'live', force: !S.inject.ready }, true)).then(bump).catch((e) => setMsg(e.message || String(e))),
            }, S.inject.mode === 'live' ? '退回影子期' : (S.inject.ready ? '切到真注入' : '强制切到真注入'))))),
        h(Sec, { title: '切到新三观', desc: '人点了才切。条件写在按钮旁边。' },
          h(Card, null, ['W', 'L', 'V'].map((layer) => {
            const ready = (S.replace_ready && S.replace_ready[layer]) || { ok: false, reasons: [] }
            const cur = S.config && S.config.replace && S.config.replace[layer]
            const name = layer === 'W' ? '世界观' : layer === 'L' ? '人生观' : '价值观'
            return h('div', { key: layer, className: 'dshc-row' },
              h('span', { className: 'l' }, name),
              h('span', { style: { flex: 1 } }, cur === 'engine' ? '已经在用新的' : (ready.ok ? '可以切' : '还差：' + (ready.reasons || []).join('、'))),
              cur === 'engine'
                ? h(Btn, { sm: true, ghost: true, onClick: () => act(() => call('PUT', base + '/config', { replace: { ...S.config.replace, [layer]: 'meter' } }, true)).then(bump).catch((e) => setMsg(e.message || String(e))) }, '退回旧版')
                : h(Btn, { sm: true, disabled: !ready.ok, onClick: () => act(() => call('PUT', base + '/config', { replace: { ...S.config.replace, [layer]: 'engine' } }, true)).then(bump).catch((e) => setMsg(e.message || String(e))) }, '切过去'))
          }))),
        h(Sec, { title: '体征与预算' }, h(Card, null, h(Tech, null,
          '账本 seq ' + S.seq + ' · 判定 ' + S.judge.calls + ' 次 / 失败 ' + S.judge.fails + (S.judge.degraded ? '（降级中）' : '') + ' · 待放置候选 ' + S.pending.candidates
          + '\n' + Object.entries(S.budget.pools).map(([p, v]) => p + ' ' + v.used + '/' + v.cap).join(' · ') + ' · 月 tokens ' + S.budget.tokens.month + '/' + S.budget.tokens.cap
          + ((L.theta_changes || []).length ? '\n参数调整：' + L.theta_changes.map((t) => sgDay(t.at) + ' ' + t.key + '=' + t.value).join('；') : '')))),
        h(Sec, { title: '换代提案', desc: '旧核心持续受挫时提出；人生观 / 价值观必须你批。' },
          !props.length ? h(Empty, null, '没有待批的提案') : props.map((p) => h(Card, { key: p.id, style: { marginBottom: 8 } },
            h('div', null, SG_LAYER[p.layer], ' · 新核心：', h('b', null, p.new_core || '')),
            p.scope ? h('div', { className: 'dshc-note' }, '旧核心降为：仍适用于' + p.scope) : null,
            p.meta ? h('div', { className: 'dshc-sub' }, p.meta) : null,
            h('div', { className: 'dshc-sub' }, '截止 ' + sgDay(p.due) + ' · ' + p.id),
            h('div', null,
              h(Btn, { sm: true, primary: true, onClick: () => act(() => call('POST', base + '/elev/' + enc(p.id) + '/approve', {}, true)).then(bump).catch((e) => setMsg(e.message || String(e))) }, '批准'),
              h(Btn, { sm: true, ghost: true, onClick: () => act(() => call('POST', base + '/elev/' + enc(p.id) + '/reject', {}, true)).then(bump).catch((e) => setMsg(e.message || String(e))) }, '拒绝'))))),
        h(Sec, { title: '事件账', right: evBefore ? h(Btn, { sm: true, ghost: true, onClick: () => setEvBefore(0) }, '回到最新') : null },
          h(Card, null, ev.error ? h(LoadErr, { error: ev.error }) : h(Tech, null, evs.map((e) => '#' + e.seq + ' ' + e.at.slice(0, 16) + ' ' + e.type + (e.layer ? '(' + e.layer + ')' : '') + ' ' + e.actor + (e.about.length ? ' · ' + e.about.join('；') : '')).join('\n') || '（空）'),
            ev.data && ev.data.next_before ? h(Btn, { sm: true, ghost: true, onClick: () => setEvBefore(ev.data.next_before) }, '更早') : null))) : null

      // ---- 鑽夌绠?----
      const drafts = (dr.data && dr.data.drafts) || []
      const counts = (dr.data && dr.data.counts) || {}
      const job = (S.drafts && S.drafts.job) || (dr.data && dr.data.job) || null
      const draftBox = h('div', null,
        h('div', { className: 'dshc-inbox-h' },
          h('span', null, 'INBOX'),
          h('span', { style: { color: 'var(--ink)' } }, '待批 ' + (counts.draft || drafts.length || 0)),
          h('span', null, '入库 ' + (counts.committed || 0)),
          h('span', null, '丢掉 ' + (counts.discarded || 0)),
          h('span', { style: { marginLeft: 'auto' } }, jobRunning ? 'RUNNING' : 'IDLE')),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 } },
          h('div', { className: 'dshc-sub', style: { flex: '1 1 220px' } },
            jobRunning ? '正在翻最近的取舍…'
              : job && job.status === 'error' ? '上一轮没跑完：' + (job.error || '')
                : job && job.status === 'done' ? '上一轮：新进 ' + (job.created || 0) + ' 条草稿。'
                  : '还没起草过。可以先点一下，也可以自己写一条。'),
          h(Btn, { sm: true, disabled: jobRunning, onClick: () => act(() => call('POST', base + '/drafts/generate', {}, true)).then(() => { setMsg('开始翻最近的取舍了。'); bump() }).catch((e) => setMsg(e.message || String(e))) }, '现在起草'),
          h(Btn, { sm: true, ghost: true, onClick: () => setNewOpen((v) => !v) }, newOpen ? '收起手写' : '写一条')),
        newOpen ? h(SgDraftNew, { base, act, onDone: bump, setMsg }) : null,
        !drafts.length ? h(Empty, null, '这几天没有值得写成三观的事。') : drafts.map((d) => h(SgDraftCard, { key: d.id, d, base, act, tech, onDone: bump, setMsg })),
        (counts.committed || counts.discarded) ? h('div', { className: 'dshc-note', style: { marginTop: 8 } }, '已经入库 ' + (counts.committed || 0) + ' 条 · 丢掉 ' + (counts.discarded || 0) + ' 条') : null)

      // ---- 鎷夸竴鍙ヨ瘽璇曞彫鍥?----
      const recallBox = h('div', { style: { marginTop: 2 } },
        h('div', { className: 'dshc-radar' },
          h('i', { className: 'dshc-ping' }),
          h('span', { className: 'dshc-sub', style: { flex: '0 0 auto' } }, '拿一句话试试它会想起什么'),
          h('input', { className: 'dshc-in', style: { flex: '1 1 220px' }, value: recallQ, maxLength: 80, placeholder: '比如：这次要不要先说难听的那句', onChange: (e) => setRecallQ(e.target.value) }),
          h(Btn, { sm: true, disabled: !recallQ.trim(), onClick: tryRecall }, '试试')),
        recallR ? h('div', { style: { marginTop: 6 } },
          h('div', { className: 'dshc-sub' }, tech ? '这一刻会想起：' + (recallR.tokens || 0) + ' tokens）：' : '这一刻会想起：'),
          recallR.lines.length
            ? recallR.lines.map((l, i) => h('div', { key: i, className: 'dshc-recall-l' },
              h('span', { className: 'n' }, String(i + 1).padStart(2, '0')), h('span', null, l)))
            : h('div', { className: 'dshc-sub' }, '这一句没有勾到别的；常驻的三条会一直在。'),
          tech ? h(Tech, null, 'core ' + (recallR.core || []).length + ' · picked ' + (recallR.picked || []).length
            + ((recallR.picked || []).length ? '\n' + recallR.picked.map((x) => '  ' + x.id + ' score ' + x.score).join('\n') : '')) : null) : null)

      return h('div', null,
        msg ? h('div', { className: 'dshc-note', style: { marginBottom: 8 } }, msg) : null,
        h(Sec, { title: '三观', desc: S.inject.mode === 'live' ? '这些看法已经在影响它说话。' : '这些看法还在影子期：只记录，不影响它说话（' + S.inject.shadow_days + ' / 7 天）。' },
          h('div', { className: 'dshc-sgwrap' },
            h('div', { className: 'dshc-sgbar' },
              h('span', null, '◆'),
              h('b', null, 'SANGGUAN'),
              h('span', null, '三列判据'),
              h('i', { className: 'ln' }),
              h('span', { className: 'sig' }, ['W', 'L', 'V'].map((l) => h('i', {
                key: l,
                className: laneOnOf(l) ? 'on' : '',
                style: { height: laneOnOf(l) ? 8 : 4 },
              })))),
            h('div', { className: 'dshc-sg3' }, ['W', 'L', 'V'].map(col)),
            recallBox),
          drawer),
        h(Sec, { title: '草案筐', desc: dr.error ? '读取出错：' + dr.error : '只有你批过的，才会真的写进它的价值观；五问全过才能入库。' },
          h(Card, null, draftBox)),
        h(Sec, { title: '预见与回流', desc: '它用自己的看法做过的预料，以及后来怎样。对错在到期那晚按记录判；你点对 / 不对，是给它留一条证据。' }, h(Card, null, pr.error ? h(LoadErr, { error: pr.error }) : predList)),
        h(Sec, { title: '它最近在想什么' }, h(Card, null, liveBox)),
        h(Sec, { title: '史', desc: '它的看法在哪些时候转了弯。' }, h(Card, null, tl.error ? h(LoadErr, { error: tl.error }) : history)),
        techBox,
        side)
    }

