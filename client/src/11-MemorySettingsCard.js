    function MemorySettingsCard({ aid, act, params, onSaved }) {
      const [f, setF] = useState(null)
      const [msg, setMsg] = useState('')
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState(false)
      const list = params || []
      const pick = (k, d) => {
        const p = list.find((x) => x.key === k)
        return p && p.value != null ? p.value : d
      }
      const v = f || {
        lambda: Number(pick('memory.decay.lambda', 0.02)),
        floor: Number(pick('memory.recall.floor', 0)),
        auto: pick('memory.auto', true) !== false,
        budget: Number(pick('memory.inject.budget', 800)),
      }
      const speedWord = (x) => (x <= 0.0125 ? '慢' : x <= 0.03 ? '标准' : x <= 0.05 ? '快' : '很快')
      // 璺?decay 鍚屼竴濂楀叕寮忥細R(t) = 1/(1 + t/(9路S路k))锛宬 = 0.02/位銆?''
      // 鎸?S=1 鐨勬櫘閫氭潯鐩綍鍙嶈В銆岄潤姝㈠灏戝ぉ鍚庡彲鎻愬彇鎬ц穼鐮撮槇鍊笺€嶁€斺€斾袱涓棆閽悎璧锋潵灏辨槸杩欎釜鏁堟灉銆?''
              const daysToForget = (lambda, floor) => {
        const l = Number(lambda), f = Number(floor)
        if (!(f > 0) || !(l > 0)) return null
        return Math.max(1, Math.round(9 * (0.02 / l) * (1 / f - 1)))
      }
      // 鍑哄巶榛樿锛氳“鍑?0.02 · 涓嶈閬楀繕闂ㄦ · 鑷姩璁板繂寮€ · 姣忚疆娉ㄥ叆 800 token
      const DEFAULTS = { lambda: 0.02, floor: 0, auto: true, budget: 800 }
      async function writeSettings(vals, word) {
        setBusy(true); setErr(''); setMsg('')
        const put = (k, value) => act(() => call('PUT', '/v1/agents/' + enc(aid) + '/params/' + enc(k), { value }, true))
        try {
          await put('memory.decay.lambda', Number(vals.lambda))
          await put('memory.recall.floor', Number(vals.floor))
          await put('memory.inject.budget', Math.round(Number(vals.budget)))
          await put('memory.auto', !!vals.auto)
          setMsg(word + '：衰减 ' + Number(vals.lambda).toFixed(3) + '（' + speedWord(Number(vals.lambda)) + '）'
            + ' · 遗忘阈值 ' + (Number(vals.floor) > 0 ? Number(vals.floor).toFixed(2) : '不设门槛')
            + ' · 自动记忆 ' + (vals.auto ? '开' : '关')
            + ' · 每轮注入 ' + Math.round(Number(vals.budget)) + ' token')
          setF(null)
          if (onSaved) onSaved()
        } catch (e) { setErr(e.message || String(e)) } finally { setBusy(false) }
      }
      const save = () => writeSettings(v, '已保存')
      const reset = () => {
        if (!window.confirm('四个旋钮都恢复默认？\n衰减 0.02 · 不设遗忘门槛 · 自动记忆开 · 每轮注入 800 token')) return
        writeSettings(DEFAULTS, '已恢复默认')
      }
      const days = daysToForget(v.lambda, v.floor)
      // 说明行：左边固定的键名、右边一句人话，分开排比三行灰字清楚
      const hintRow = (k, t) => h('div', { style: { display: 'flex', gap: 10, alignItems: 'baseline' } },
        h('span', {
          style: { flex: 'none', width: 72, fontSize: 11.5, letterSpacing: .3, color: 'var(--muted)', textAlign: 'right' },
        }, k),
        h('span', { style: { flex: 1, fontSize: 12.5, lineHeight: 1.72, color: 'var(--ink)', opacity: .85 } }, t))
      return h(Card, null,
        h(Row, { label: '衰减速度' },
          h('input', {
            type: 'range', min: 0.005, max: 0.08, step: 0.005, value: v.lambda,
            onChange: (e) => setF({ ...v, lambda: Number(e.target.value) }), style: { width: 150 },
          }),
          h('span', { className: 'dshc-mono', style: { width: 112, textAlign: 'right' } },
            Number(v.lambda).toFixed(3) + ' · ' + speedWord(Number(v.lambda)))),
        h(Row, { label: '遗忘阈值' },
          h('input', {
            type: 'range', min: 0, max: 0.6, step: 0.05, value: v.floor,
            onChange: (e) => setF({ ...v, floor: Number(e.target.value) }), style: { width: 150 },
          }),
          h('span', { className: 'dshc-mono', style: { width: 112, textAlign: 'right' } },
            Number(v.floor) > 0 ? Number(v.floor).toFixed(2) + (days ? ' · 约 ' + days + ' 天' : '') : '不设门槛')),
        h(Row, { label: '自动记忆' },
          h('input', { type: 'checkbox', checked: !!v.auto, onChange: (e) => setF({ ...v, auto: e.target.checked }) }),
          h('span', { className: 'dshc-sub' }, v.auto ? '每轮自动抽事实 / 偏好' : '只记你手动塞的')),
        h(Row, { label: '每轮注入预算' },
          h('input', {
            type: 'range', min: 200, max: 2000, step: 50, value: v.budget,
            onChange: (e) => setF({ ...v, budget: Number(e.target.value) }), style: { width: 150 },
          }),
          h('span', { className: 'dshc-mono', style: { width: 96, textAlign: 'right' } }, Math.round(Number(v.budget)) + ' token')),
        // 璇存槑鍖猴細鍥涗釜鏃嬮挳鍚勪竴鍙ヤ汉璇濓紝鐭竴鐐癸紝鍒嗗紑绔?''
              h('div', {
          style: {
            marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--line)',
            display: 'flex', flexDirection: 'column', gap: 7,
          },
        },
          hintRow('敏感度', '同一件事在它心里有多响、多小的才算事、坏情绪多久散，都由这一个数决定；你挑的值不会再自己漂。'),
          hintRow('遗忘阈值', Number(v.floor) > 0
            ? ('也管「长期 · 抽屉」：沉到 ' + Number(v.floor).toFixed(2) + ' 以下的，聊天里就不提了' + (days ? '（约 ' + days + ' 天到）' : '') + '。不删，列表里还在，调回来又能想起。')
            : '0 = 现在这样，旧事都还翻得出来。调高只会让旧事聊天里不提，不会删。'),
          hintRow('自动记忆', v.auto ? '开 = 聊完它自己记。' : '关 = 只记你手动塞的，聊天内容不自动变记忆。'),
          hintRow('情绪衰减', '说完一轮之后，情绪往平静回落多少；拖到 0 就是不回落。')),
        h('div', { style: { marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' } },
          h(Btn, { primary: true, disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
          h(Btn, { ghost: true, disabled: busy, onClick: reset }, '恢复默认')),
        err ? h('div', { className: 'dshc-err' }, err) : null,
        msg ? h('div', { className: 'dshc-note' }, msg) : null)
    }

    function SettingsPage({ aid, view, act, agent, reloadAgents }) {
      const [tick, setTick] = useState(0)
      const [err, setErr] = useState('')
      const [msg, setMsg] = useState('')
      const [avatarSrc, setAvatarSrc] = useState((agent && agent.avatar) || null)
      const [avatarMsg, setAvatarMsg] = useState('')
      const [params] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/params'), [aid, tick])
      const [budget, reloadBudget] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/budget'), [aid, tick])
      const [cools] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/cooldowns'), [aid, tick])
      const [rules] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/rules'), [aid, tick])
      const [acts] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/actions'), [aid, tick])
      const [drill, setDrill] = useState(null)
      const [actText, setActText] = useState('')
      const [actUrl, setActUrl] = useState('')
      const [actMsg, setActMsg] = useState('')
      const [drafts, setDrafts] = useState({})
      const [note, setNote] = useState('')

      // 鍙傛暟琛屽唴淇濆瓨锛氬竷灏?/ 瀛楃涓诧紙鏋氫妇銆佸叕寮忕増鏈級/ 鏁板瓧鍒嗗埆閫佸绫诲瀷
      async function applyParam(p) {
        const key = p.key
        const raw = drafts[key] !== undefined ? drafts[key] : p.value
        const value = typeof p.value === 'boolean'
          ? (raw === true || String(raw) === 'true')
          : typeof p.value === 'string'
            ? String(raw)
            : Number(raw)
        if (typeof value === 'number' && !Number.isFinite(value)) return { ok: false, text: '要填一个数字' }
        try {
          const r = await act(() => call('PUT', '/v1/agents/' + enc(aid) + '/params/' + enc(key), { value }, true))
          setTick((t) => t + 1)
          setDrafts((d) => { const n = { ...d }; delete n[key]; return n })
          return p.level === 'C4'
            ? { ok: true, text: '已写入 ' + (r && r.value !== undefined ? String(r.value) : String(value)) }
            : { ok: true, text: '已发起提案，等你在「自修改」里批' }
        } catch (e) {
          if (e.code === 'PROPOSAL_REQUIRED') return { ok: false, text: '这属于 ' + p.level + '，请到「自修改」发起提案' }
          return { ok: false, text: e.message || String(e) }
        }
      }
      async function togglePause(paused) {
        await act(() => call('POST', '/v1/agents/' + enc(aid) + (paused ? '/pause' : '/resume'), {}, true))
        setTick((t) => t + 1)
        PRESENCE.bump()
      }
      async function saveBudget() {
        setErr('')
        try {
          await act(() => call('PUT', '/v1/agents/' + enc(aid) + '/budget', {
            // 閲戦娌℃帴璁′环鏉ユ簮锛屽厛涓嶅啓锛涗繚鐣欐暟鎹簱瀛楁绛変互鍚庢湁 token 鍗曚环鍐嶅惎鐢?''
              token_limit: Number(drafts.token_limit ?? (budget.data || {}).token_limit) || 0,
            disturb_limit: Number(drafts.disturb_limit ?? (budget.data || {}).disturb_limit) || 0,
          }, true))
          setMsg('预算已保存'); reloadBudget(); setTick((t) => t + 1)
        } catch (e) { setErr(e.message) }
      }
      async function saveRule() {
        await act(() => call('POST', '/v1/agents/' + enc(aid) + '/rules', { note: note || '手动快照' }, true))
        setNote(''); setTick((t) => t + 1)
      }
      async function runDrill() {
        try { setDrill(await call('GET', '/v1/maintenance/backup-drill')) } catch (x) { setErr(x.message) }
      }
      async function activateRule(id) {
        await act(() => call('POST', '/v1/rules/' + enc(id) + '/activate', {}, true))
        setMsg('规则版本已启用（重启后仍生效）'); setTick((t) => t + 1)
      }
      async function runAction(port, payload) {
        setActMsg('')
        try {
          const r = await act(() => call('POST', '/v1/agents/' + enc(aid) + '/actions', { port, payload }, true))
          setActMsg(port + ' →' + r.status + (r.note ? ' · ' + r.note : ''))
          setTick((t) => t + 1)
        } catch (e) { setActMsg(e.message) }
      }

      async function pickAvatarFile(file) {
        if (!file) return
        setAvatarMsg('')
        try {
          const data = await compressAvatar(file)
          await act(() => call('PUT', '/v1/agents/' + enc(aid) + '/avatar', { data }, true))
          setAvatarSrc(data)
          setAvatarMsg('头像已更新')
          if (reloadAgents) await reloadAgents()
        } catch (e) { setAvatarMsg('换头像失败：' + (e.message || String(e))) }
      }

      async function clearAvatar() {
        setAvatarMsg('')
        try {
          await act(() => call('PUT', '/v1/agents/' + enc(aid) + '/avatar', { data: '' }, true))
          setAvatarSrc(null)
          setAvatarMsg('已恢复默认头像')
          if (reloadAgents) await reloadAgents()
        } catch (e) { setAvatarMsg('恢复失败：' + (e.message || String(e))) }
      }

      const b = budget.data || {}
      const byKey = new Map(((params.data) || []).map((p) => [p.key, p]))
      const visible = (p) => !!p && (view === 'tech' || p.level === 'C4')
      const grouped = new Set()
      PARAM_TAB_GROUPS.forEach((g) => g.keys.forEach((k) => grouped.add(k)))
      // 娌″綊鍒颁换浣曢〉澶存爣绛剧殑鍙傛暟锛屼互鍙婂彧璇婚」锛岄兘杩涖€屽叾浠栥€?''
              const otherParams = ((params.data) || []).filter((p) => !grouped.has(p.key) && visible(p))
      const paramRows = (list) => list.map((p) => h(ParamRow, {
        key: p.key, p, view,
        draft: drafts[p.key],
        onDraft: (v) => setDrafts((d) => ({ ...d, [p.key]: v })),
        onSave: () => applyParam(p),
      }))
      const tabGroups = PARAM_TAB_GROUPS.map((g) => {
        const rows = g.keys.map((k) => byKey.get(k)).filter(visible)
          .filter((p) => !(g.key === 'memory' && MEMORY_CARD_KEYS.has(p.key)))
        const knobs = SETTING_KNOBS[g.key] || []
        const knobKeys = new Set(knobs.map((it) => it.key))
        const extra = rows.filter((p) => !knobKeys.has(p.key))
        const onSaved = () => setTick((t) => t + 1)
        return h('div', { key: g.key, id: 'dshc-set-' + g.key },
          h(Sec, { title: g.title, desc: g.desc, right: h(TabMark, { tab: g.tab }) },
            g.key === 'memory'
              ? h('div', null,
                h(MemorySettingsCard, { aid, act, params: params.data || [], onSaved }),
                view === 'tech' && extra.length
                  ? h(FoldBlock, { title: '更细的召回与公式', desc: '召回权重 / 候选池 / 公式版本' }, h(Card, null, paramRows(extra)))
                  : null)
              : g.key === 'drive'
                ? h('div', null,
                  h(DriveBaselineCard, { aid, act }),
                  view === 'tech' && extra.length
                    ? h(FoldBlock, { title: '缺口算法版本', desc: '一般不动' }, h(Card, null, paramRows(extra)))
                    : null)
                : h('div', null,
                  g.key === 'affect'
                    ? h(AffectCard, { aid, act, params: params.data || [], onSaved })
                    : h(KnobCard, { aid, act, params: params.data || [], specs: knobs, onSaved }),
                  view === 'tech' && extra.length
                    ? (g.key === 'affect'
                      ? h(FoldBlock, { title: '公式版本', desc: '一般不动' }, h(Card, null, paramRows(extra)))
                      : h(FoldBlock, { title: '缺口算法版本', desc: '一般不动' }, h(Card, null, paramRows(extra))))
                    : null)))
      })
      return h('div', null,
        h(LoadErr, {
          error: params.error || budget.error || cools.error || (rules && rules.error),
          retry: () => { setTick((t) => t + 1); reloadBudget() },
        }),

        h('div', { className: 'dshc-set-lead' },
          h('div', { className: 'dshc-set-lead-t' }, '设置按页头标签走'),
          h('div', { className: 'dshc-set-lead-d' },
            '记忆、鱼格、情绪、驱力各自一组：能改的参数就收在对应的那一组里。不归标签的（头像、自动行为、额度、维护、说明）统一放到最后「其他」。'),
          h(SettingJump, {
            items: [['memory', '记忆'], ['mind', '心里'], ['gate', '认人'], ['persona', '鱼格'], ['affect', '情绪'], ['drive', '驱力'], ['other', '其他']],
          })),

        tabGroups,

        h('div', { id: 'dshc-set-other' },
          h(Sec, {
            title: '其他',
        desc: '六槽位并存；切 active 走 C3 提案；canary + ratio 可直改落库。各模块页也有「当前算法」摘要。',
            right: h(TabMark, { tab: '其他' }),
          },
            h(Card, { style: { padding: '2px 0 0' } },
              h('div', { className: 'dshc-sub' }, '下面按「外观 → 自动行为 → 额度 → 维护 → 说明」排成可收起的一行；点标题展开，越往下越少动。'),
              err ? h('div', { className: 'dshc-err' }, err) : null,
              msg ? h('div', { className: 'dshc-note' }, msg) : null))),

        h(FoldBlock, { title: '它长什么样', desc: '头像 · 换一张 / 恢复默认' },
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'center' } },
            h(Avatar, { src: avatarSrc, size: 44 }),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 } },
              h('label', { className: 'dshc-btn dshc-btn--sm', style: { cursor: 'pointer' } },
                '选图片',
                h('input', {
                  type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif',
                  style: { display: 'none' },
                  onChange: (e) => {
                    const f = e.target.files && e.target.files[0]
                    e.target.value = ''
                    if (f) pickAvatarFile(f)
                  },
                })),
              h(Btn, { ghost: true, sm: true, onClick: clearAvatar }, '恢复默认头像'),
              avatarMsg ? h('span', { className: 'dshc-sub', style: { color: avatarMsg.indexOf('失败') >= 0 ? 'var(--bad)' : 'var(--ok)' } }, avatarMsg) : null))),

        h(FoldBlock, { title: '学习与自动执行', desc: 'C4 自动执行 / 鱼格学习 / 冷却轮数' },
          h(LearningCard, { aid, act })),

        h(FoldBlock, { title: '主动开口', desc: '每天几句 / 沉默多久 / 半夜安静 / 要不要主动发' },
          h(ProactiveCard, { aid, act })),

        h(FoldBlock, { title: 'QQ 通道', desc: '在不在线 / 最近收发 / 带几轮历史' },
          h(QQChannelCard, { act })),

        h(FoldBlock, { title: '安全边界', desc: '暂停全部 / 恢复运行' },
          h('div', null,
            h('div', { style: { display: 'flex', gap: 8 } },
              h(Btn, { danger: true, onClick: () => togglePause(true) }, '暂停全部'),
              h(Btn, { onClick: () => togglePause(false) }, '恢复运行')),
            h('div', { className: 'dshc-note' }, '暂停后写命令返回 409 READ_ONLY，读取仍可用。'))),

        view === 'tech' ? h(FoldBlock, { title: '其他参数', desc: '条件系数 / 只读上限' },
          h('div', null,
            otherParams.length ? paramRows(otherParams) : h('div', { className: 'dshc-sub' }, '没有额外的参数。'))) : null,

        view === 'tech' ? h(FoldBlock, { title: '预算', desc: 'token / 每天打扰次数' },
          h('div', null,
            h(Row, { label: '本月', value: b.month || '—' }),
            h(Row, { label: 'token', value: Number(b.token_used || 0) + ' / ' + Number(b.token_limit || 0) }),
            h(Row, { label: '打扰', value: Number(b.disturb_used || 0) + ' / ' + Number(b.disturb_limit || 0) }),
            h('div', { className: 'dshc-form', style: { marginTop: 8 } },
              h('span', { className: 'dshc-sub' }, 'token'), h(Input, { style: { width: 90 }, defaultValue: String(b.token_limit || 0), onChange: (e) => setDrafts({ ...drafts, token_limit: e.target.value }) }),
              h('span', { className: 'dshc-sub' }, '打扰/天'), h(Input, { style: { width: 70 }, defaultValue: String(b.disturb_limit || 0), onChange: (e) => setDrafts({ ...drafts, disturb_limit: e.target.value }) }),
              h(Btn, { onClick: saveBudget }, '保存')),
            h('div', { className: 'dshc-note' }, '金额预算先关掉了：现在没有按钱计价的来源，留着只会是个永远 0 的摆设。'))) : null,

        view === 'tech' ? h(FoldBlock, { title: '冷却', desc: '同字段 7 天 / 同维度 6 小时' },
          h('div', null,
            (cools.data || []).length === 0 ? h('div', { className: 'dshc-sub' }, '当前没有生效中的冷却。')
              : (cools.data || []).map((r, i) => h(Row, { key: i, label: r.scope },
                h('span', { className: 'm' }, r.key), h('span', { className: 'v dshc-mono' }, String(r.until || '').slice(5, 16)))))) : null,

        h(Sec, { techOnly: true, title: view === 'user' ? '刚改完要等多久' : '冷却', desc: '同字段 7 天、同维度 6 小时；冷却期内提案会被 G4 拦下。' },
          h(Card, null,
            (cools.data || []).length === 0 ? h('div', { className: 'dshc-sub' }, '当前没有生效中的冷却。')
              : (cools.data || []).map((r, i) => h(Row, { key: i, label: r.scope },
                h('span', { className: 'm' }, r.key), h('span', { className: 'v dshc-mono' }, String(r.until || '').slice(5, 16)))))),

        view === 'tech' ? h(FoldBlock, { title: '规则版本', desc: '存快照 / 启用旧版' },
          h('div', null,
            (rules.data || []).length === 0 ? h('div', { className: 'dshc-sub' }, '还没有规则版本。')
              : (rules.data || []).map((r) => h(Row, { key: r.id, label: 'v' + r.version },
                h('span', { className: 'm' }, r.note || ''),
                h(Pill, { on: !!r.active }, r.active ? '生效中' : '历史'),
                r.active ? null : h(Btn, { onClick: () => activateRule(r.id) }, '启用')))),
            h('div', { className: 'dshc-form', style: { marginTop: 8 } },
              h(Input, { className: 'grow', placeholder: '这个版本的说明', value: note, onChange: (e) => setNote(e.target.value) }),
              h(Btn, { onClick: saveRule }, '存一个版本'))) : null,

        view === 'tech' ? h(FoldBlock, { title: '算法版本与灰度', desc: '六槽位 / canary / ratio' },
          h(AlgoBindingsPanel, { aid, act, view, bare: true })) : null,

        view === 'tech' ? h(FoldBlock, { title: '备份恢复演练', desc: '打开最近一份备份并数表' },
          h('div', null,
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, h(Btn, { onClick: runDrill }, '演练最近备份')),
            drill ? h('div', { className: 'dshc-note' }, (drill.ok ? '通过' : '失败') + ' · ' + (drill.file || drill.reason || '') + ' · 表 ' + (drill.tables ?? '—') + ' · 记忆 ' + (drill.memories ?? '—')) : null)) : null,

        h(FoldBlock, { title: '真实行动', desc: '发消息 / 浏览 / 提醒' },
          h(Card, null,
            h('div', { className: 'dshc-form' },
              h(Input, { className: 'grow', placeholder: '要发出去的一句话', value: actText, onChange: (e) => setActText(e.target.value) }),
              h(Btn, { onClick: () => runAction('send_message', { text: actText }) }, '发消息')),
            h('div', { className: 'dshc-form', style: { marginTop: 8 } },
              h(Input, { className: 'grow', placeholder: 'https://… 要浏览的页面', value: actUrl, onChange: (e) => setActUrl(e.target.value) }),
              h(Btn, { onClick: () => runAction('browse', { url: actUrl }) }, '浏览')),
            h('div', { className: 'dshc-form', style: { marginTop: 8 } },
              h(Input, { className: 'grow', placeholder: '提醒内容', value: actText, onChange: (e) => setActText(e.target.value) }),
              h(Btn, { onClick: () => runAction('remind', { text: actText }) }, '提醒')),
            actMsg ? h('div', { className: 'dshc-note' }, actMsg) : null)),

        h(FoldBlock, { title: '行动日志', desc: '最近 10 条真实行动' },
          h(Card, null,
            (acts.data || []).length === 0 ? h('div', { className: 'dshc-sub' }, '还没有行动记录。')
              : (acts.data || []).slice(0, 10).map((a) => h(Row, { key: a.id, label: a.port },
                h(Pill, { tone: a.status === 'sent' || a.status === 'fetched' ? 'ok' : undefined }, a.status),
                h('span', { className: 'm dshc-mono' }, String(a.created_at || '').slice(5, 16)))))),

        h(FoldBlock, { title: '测试标准', desc: '契约 22 / 硬门槛 8 / 指标 51' },
          h(Card, null,
            h(Row, { label: '契约测试', value: '22 条' }),
            h(Row, { label: '硬门槛', value: '8 条' }),
            h(Row, { label: '指标总数', value: '52 条' }))),

        h(FoldBlock, { title: '人文社科依据', desc: '这些设计从哪来' },
          h(Card, null, h('div', { className: 'dshc-sub' },
            '儒家（关系自我）、道家（阴阳与无为）、佛家（无常与三毒）、依恋理论、客体关系、社会交换、符号互动、' +
            '戈夫曼（面子）、涂尔干（集体仪式）、韦伯（合法性）、布迪厄（惯习）、卢曼（系统沟通）、布伯（我-你）、神学（修复仪式）。'))),

        h(FoldBlock, { title: '模型接入', desc: '换模型不在用户前端' },
          h(Card, null, h('div', { className: 'dshc-sub' },
            '这是已接受的边界：换模型只换适配器，业务代码不出现模型名；用户界面不提供模型选择。'))),

        view === 'tech' ? h(FoldBlock, { title: '技术视图说明', desc: '用户视图和技术视图的分界' },
          h(Card, null, h('div', { className: 'dshc-sub' },
            '用户视图只回答「我能做什么」；技术视图才给数字、键名、采样方式。判据：用户看到它，能不能做一个动作。'))) : null)
    }

    /* =============================================================== page */

    function Page(props) {
      const close = props && props.close
      const [agents, setAgents] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [aid, setAid] = useState(() => {
        try { return window.localStorage.getItem('dshc.agent') || null } catch { return null }
      })

      const reload = useCallback(async () => {
        setLoading(true)
        try {
          const list = await call('GET', '/v1/agents?include_deleted=1')
          setAgents(Array.isArray(list) ? list : [])
          setError('')
        } catch (e) {
          setError(e.message || String(e)); setAgents([])
        } finally { setLoading(false) }
      }, [])

      useEffect(() => { reload() }, [reload])
      useEffect(() => {
        try {
          if (aid) window.localStorage.setItem('dshc.agent', aid)
          else window.localStorage.removeItem('dshc.agent')
        } catch { /* 隐私模式 */ }
      }, [aid])

      const act = useCallback(async (fn) => fn(), [])
      const agent = (agents || []).find((a) => a.id === aid && a.status !== 'soft_deleted')

      useEffect(() => { if (aid && agents && !agent) setAid(null) }, [aid, agents, agent])

      if (!agent) return h(Roster, { agents, loading, error, reload, setAid, act })
      return h(Detail, { key: agent.id, agent, setAid, act, close, reloadAgents: reload })
    }

    /* ====================================================== chat presence */

    // 本页任何地方改了「谁在运行」，立刻通知标题旁的牌子，不用等轮询
    const PRESENCE = {
      listeners: new Set(),
      bump() { for (const fn of [...this.listeners]) { try { fn() } catch { /* ignore */ } } },
    }

    /** 瀵硅瘽鏍囬鏃佺殑韬唤鐗岋細鎸?*杩欐瀵硅瘽**缁戝畾鐨勬剰璇嗕綋鏄剧ず锛岀粦涓嶄笂灏辨槸鏅€?DSH锛堜笉鏄剧ず锛夈€?*/
    function ChatPresence(props) {
      const sid = props && props.sessionId ? String(props.sessionId) : ''
      const [who, setWho] = useState(null)
      useEffect(() => {
        let alive = true
        const load = () => {
          if (!sid) { setWho(null); return }
          call('GET', '/v1/sessions/' + enc(sid) + '/agent')
            .then((r) => {
              if (!alive) return
              const a = r && r.agent
              setWho(a ? { name: a.name, avatar: a.avatar || DEFAULT_AVATAR, state: r.state } : null)
            })
            .catch(() => { if (alive) setWho(null) })
        }
        load()
        PRESENCE.listeners.add(load)
        // 涓嶈疆璇細鍙湪绐楀彛閲嶆柊鑾峰緱鐒︾偣 / 鏍囩椤靛垏鍥炴潵鏃惰ˉ涓€娆?''
              const onFocus = () => load()
        const onVisible = () => { if (document.visibilityState === 'visible') load() }
        window.addEventListener('focus', onFocus)
        document.addEventListener('visibilitychange', onVisible)
        // 归档 / 换绑发生在 DSH 那边，这里收不到事件：页面露着时每 15 秒补看一眼，
        // 免得主人归档完，标题旁边那块牌子还挂着。
        const timer = setInterval(() => { if (document.visibilityState === 'visible') load() }, 15000)
        return () => {
          alive = false
          clearInterval(timer)
          PRESENCE.listeners.delete(load)
          window.removeEventListener('focus', onFocus)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [sid])
      if (!who) return null
      return h('span', {
        title: who.state === 'paused' ? who.name + ' 被暂停了，这段对话暂时是普通 DSH' : who.name + ' 正在这段对话里',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 6,
          padding: '2px 9px 2px 2px', borderRadius: 999,
          background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.10)',
        },
      },
        h('img', {
          src: who.avatar, alt: '',
          style: { width: 20, height: 20, borderRadius: '50%', objectFit: 'cover', display: 'block' },
        }),
        h('span', {
          style: { fontSize: 12, opacity: .85, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, who.name))
    }

    /* ============================================================== guard */

    /**
     * 杩欎竴椤典互鍓嶅穿涓€娆″氨鏁翠釜浠庤缃鑸噷娑堝け锛欴SH 鐨?slot 娓叉煋鍣ㄥ鍑洪敊鐨?entry
     * 浼氱洿鎺ュ仠鐢紙abdicate锛夛紝椤电灏?娌′簡"銆傚湪杩欓噷鍏滀綇锛屾崲鎴愪竴寮犺兘鐪嬫噦鐨勫崱鐗囷紝
     * 椤电涓€鐩寸暀鍦ㄥ鑸噷锛屽嚭閿欎篃鑳介噸璇曘€?     */
    function rememberCrash(err, extra) {
      try {
        const text = String((err && (err.stack || err.message)) || err)
        console.error('[dsh-consciousness] 页面渲染出错：', err)
        window.localStorage.setItem('dshc.crash', JSON.stringify({
          at: new Date().toISOString(), text: text.slice(0, 4000), extra: String(extra || '').slice(0, 4000),
        }))
      } catch { /* 记录失败不影响重试 */ }
    }

    function CrashCard({ error, reset }) {
      const text = String((error && (error.stack || error.message)) || error)
      return h('div', { className: 'dshc' },
        h(Style),
        h('div', { className: 'dshc-hero' },
          h('div', { className: 'dshc-hero-row' },
            h('div', { className: 'dshc-id' }, h(Orb, { size: 42 }),
              h('div', null,
                h('h1', null, '意识'),
                h('div', { className: 'dshc-sub' }, '这一页刚才出错了。它还在，重试一下；还不行就把下面的错误发我。'))))),
        h('div', { style: { marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', {
            className: 'dshc-err',
            style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--mono, monospace)', fontSize: 12 },
          }, text.slice(0, 1500)),
          h('div', { style: { display: 'flex', gap: 8 } },
            h(Btn, { primary: true, onClick: reset }, '重试'),
            h(Btn, { ghost: true, onClick: () => { try { navigator.clipboard.writeText(text) } catch { /* 剪贴板不可用 */ } } }, '复制错误'))))
    }

    /* 娌℃湁 React.Component 鐨勭幆澧冿紙娴嬭瘯閲岀殑鍋?React锛夊彧鍋氶€忎紶锛岀湡娴忚鍣ㄩ噷鎵嶆嫤 */
    const BoundaryBase = (React.Component) || class { constructor(props) { this.props = props } }
    class SectionBoundary extends BoundaryBase {
      constructor(props) { super(props); this.state = { err: null } }
      static getDerivedStateFromError(err) { return { err: err || new Error('未知错误') } }
      componentDidCatch(err, info) { rememberCrash(err, info && info.componentStack) }
      render() {
        if (this.state.err) return h(CrashCard, { error: this.state.err, reset: () => this.setState({ err: null }) })
        return this.props.children
      }
    }

    /* =========================================================== register */

    /**
     * 鍓嶇鐑洿鏂帮細姣忛殧 12 绉掗棶涓€娆″涓荤殑 client.js 鎸囩汗銆?     * 鍙樹簡灏辫嚜宸卞埛鏂伴〉闈⑩€斺€旀敼瀹屾彃浠朵笉鐢ㄥ啀鎸?Ctrl+F5銆?     * 鍔??_r= 鏄负浜嗚繛 HTML 涓€璧烽噸鍙栵紝鍚﹀垯鎷垮埌鐨勮繕鏄紦瀛橀噷鐨勬棫鍖呫€?     */
    function watchHotReload() {
      let seen = null
      let timer = 0
      const tick = () => {
        fetch('/dsh-consciousness/version', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => {
            const v = j && j.client
            if (!v) return
            if (seen === null) { seen = v; return }
            if (v !== seen) {
              const u = new URL(location.href)
              u.searchParams.set('_r', String(Date.now()))
              location.replace(u.toString())
            }
          })
          .catch(() => { /* 宿主没起好就先不管 */ })
      }
      tick()
      timer = setInterval(tick, 12000)
      return () => clearInterval(timer)
    }
