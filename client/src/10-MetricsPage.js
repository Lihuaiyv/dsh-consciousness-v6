    function MetricsPage({ aid, view, act, setTab }) {
      const [tick, setTick] = useState(0)
      const [cat] = useAsync(() => call('GET', '/v1/metrics/catalog'), [])
      const [vals] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/metrics'), [aid, tick])
      const [hist] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/metrics/history?days=30&keys=sys.inject_latency,sys.inject_tokens,self.rollback_rate,drive.proactive_answer,affect.label_kappa,persona.identity_blind'), [aid, tick])
      const [gates, reloadGates] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/eval/hard-gates'), [aid, tick])
      const [cal] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/eval/calibration'), [aid, tick])
      const [shadow] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/shadow?days=7'), [aid, tick])
      const [blind, setBlind] = useState(null)
      const [calMsg, setCalMsg] = useState('')
      const catalog = cat.data || []
      const values = vals.data || {}
      const sampled = Object.values(values).filter((v) => v && v.value != null).length
      const gateRows = (gates.data && gates.data.gates) || []
      const shadowData = shadow.data || null

      function spark(pts) {
        if (!pts || pts.length < 2) return h('span', { className: 'dshc-sub' }, pts && pts.length ? '样本不足（' + pts.length + '）' : '还没有采样')
        const w = 260, hgt = 38
        const vs = pts.map((p) => Number(p.value))
        const mn = Math.min(...vs), mx = Math.max(...vs)
        const span = mx - mn || 1
        const xy = pts.map((p, i) => [i / (pts.length - 1) * w, hgt - (Number(p.value) - mn) / span * (hgt - 4) - 2])
        return h('svg', { width: w, height: hgt, viewBox: '0 0 ' + w + ' ' + hgt },
          h('polyline', {
            points: xy.map((p) => p.join(',')).join(' '),
            fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, opacity: 0.85,
          }),
          xy.map((p, i) => h('circle', { key: i, cx: p[0], cy: p[1], r: 2, fill: 'currentColor' })))
      }

      return h('div', null,
        h(Sec, {
            title: '三观', desc: '三观引擎未启用：下面是旧的维度仪表。打开后它会从对话里慢慢长出自己的看法，先观察 7 天再真正进入说话。',
          right: h('div', { className: 'dshc-form' },
            h(Btn, {
              onClick: async () => { await act(() => call('POST', '/v1/agents/' + enc(aid) + '/metrics/sample', {}, true)); setTick((t) => t + 1) },
            }, '采样一次'),
            h(Btn, {
              primary: true,
              onClick: async () => {
                const r = await act(() => call('POST', '/v1/agents/' + enc(aid) + '/eval/identity-blind', {}, true))
                setBlind(r); setTick((t) => t + 1)
              },
              }, '应用全部 C4 建议')),
        },
          h('div', { className: 'dshc-grid2' },
            h(Card, null, h(KV, {
              label: '硬门槛',
              value: gates.data ? (gates.data.known < 8 ? String(gates.data.failed) + ' 未过 · ' + (8 - gates.data.known) + ' 未采集' : (gates.data.failed === 0 ? '过' : String(gates.data.failed) + ' 未过')) : '—',
              hint: gates.data ? (gates.data.known + '/8 有值') : '',
            }), h('div', { className: 'dshc-sub' }, '★ 任一不过不发版。')),
            h(Card, null, h(KV, { label: '已采样', value: String(sampled), hint: '条' }), h('div', { className: 'dshc-sub' }, '没值的显示 —，不编数。')),
            h(Card, null, h(KV, {
              label: '注入延迟 p95',
              value: values['sys.inject_latency'] && values['sys.inject_latency'].value != null ? values['sys.inject_latency'].value : '—',
              hint: 'ms',
            }), h('div', { className: 'dshc-sub' }, '目标 ≤ 80ms（SRE）')))),

        h(Sec, { title: '世界观', desc: '它认定世界是怎样的，以及围着它的辅助说法。' },
          h(Card, null,
            !shadowData ? h('div', { className: 'dshc-sub' }, shadow.loading ? '读取中…' : '没有观测数据')
              : h('div', null,
                h(Row, {
                    label: '得分',
                  value: '记录 ' + shadowData.residue.recorded + ' / 提示 ' + shadowData.residue.shown + ' / 结算 ' + shadowData.residue.settled
                    + '（冷 ' + shadowData.residue.by_dir.cold + ' 暖 ' + shadowData.residue.by_dir.warm + '）',
                }),
                h(Row, {
          label: '意识',
                  value: '记录 ' + (shadowData.residue.recording ? 'on' : 'off') + ' · 结算 ' + (shadowData.residue.settling ? 'on' : 'off'),
                }),
                h(Row, {
          label: '意识体',
                  value: '落账 ' + shadowData.mind.committed + ' / 丢弃 ' + shadowData.mind.dropped
                    + (shadowData.mind.dropped_rate == null ? '' : ' · 丢弃率 ' + shadowData.mind.dropped_rate),
                }),
                h(Row, {
                  label: '记忆',
                  value: shadowData.memory.total + ' 条 · 低置信 ' + shadowData.memory.low_confidence,
                })))),

        h(Sec, { title: view === 'user' ? '它这些地方还不行（' : '完整清单（' + ((cat.data && cat.data.items) || 0) + ' 条）', desc: '从当前代码自动提取的界面区块；加功能会自动变。' },
          h(Card, null,
            ((cat.data && cat.data.groups) || []).map((g) => h('details', { key: g.name, style: { marginBottom: 6 } },
              h('summary', { style: { cursor: 'pointer' } }, g.name + ' · ' + g.items.length + ' 条'),
              h('div', { className: 'dshc-list', style: { marginTop: 6 } },
                g.items.map((x, i) => h('div', { key: i, className: 'dshc-item' }, x))))))),

        h(Sec, { title: view === 'user' ? '不能踩的红线' : '发版硬门槛（8 条）', desc: '可见 + 可观测；unknown 表示样本不足。' },
          h(Card, null,
            gates.error ? h('div', { className: 'dshc-err' }, '门槛读取失败：' + gates.error, ' ', h('a', { href: '#', onClick: (e) => { e.preventDefault(); reloadGates() } }, '重试'))
              : gates.loading ? h('div', { className: 'dshc-sub' }, '读取中…')
              : gateRows.length === 0 ? h('div', { className: 'dshc-sub' }, '没有可显示的门槛')
              : gateRows.map((g) => h('div', { key: g.key, className: 'dshc-item' },
                h(Pill, { tone: g.status === 'fail' ? 'bad' : g.status === 'pass' ? undefined : 'warn', on: g.status === 'pass' },
                  g.status === 'pass' ? '过' : g.status === 'fail' ? '不过' : '?'),
                h('div', { className: 't' },
                  h('div', null, g.label),
                  h('div', { className: 'dshc-sub dshc-mono' }, g.key + ' · ' + (g.op === 'gte' ? '≥' : g.op === 'lte' ? '≤' : g.op) + ' ' + g.threshold + (g.value == null ? ' · 未采集' : ' · 当前 ' + g.value))),
                h('div', { className: 'm dshc-mono' }, g.value == null ? '—' : String(g.value)))))),

        h(Sec, {
            title: '其他',
            desc: '不归页头标签的东西：外观、自动行为、额度、维护和说明；参数里没归到上面四组的也在这里。',
          right: h(Btn, { ghost: true, onClick: () => setTab && setTab('persona') }, '去写鱼格卡'),
        },
          h(Card, null,
            blind
              ? (blind.insufficient
                ? h('div', null,
                  h('div', { className: 'dshc-note' }, blind.reason || '手写区还不够，测不出同一性。'),
                  h(Row, { label: '已配置', value: BLIND_SIGNAL(blind.signals) }),
                  h('div', { style: { marginTop: 8 } },
                    h(Btn, { primary: true, onClick: () => setTab && setTab('persona') }, '去写语气 / 称呼 / 鱼格卡')))
                : h('div', null,
                  h(Row, {
                    label: '得分',
                    value: Number(blind.value).toFixed(3) + ' · ' + (blind.pass ? '过' : '未过') + '（目标 ≥ ' + (blind.threshold || 0.8) + '）',
                  }),
                  h(Row, { label: '线索', value: BLIND_SIGNAL(blind.signals) }),
                  (blind.trials || []).slice(0, 5).map((t, i) => h('div', { key: i, className: 'dshc-item', style: { marginTop: 6 } },
                    h('div', { className: 't' }, t.text),
                    h('div', { className: 'm' }, (t.reply || '').slice(0, 60))))))
              : h('div', { className: 'dshc-sub' }, '点上面「跑盲测」；先在鱼格页写称呼 / 口头禅 / 语气，否则测出来没有意义。'))),

        h(Sec, { title: view === 'user' ? '这些数是怎么定出来的' : '数值标定（§9.2）', desc: '根据当前状态建议 C4 初值调整；应用会留痕可回滚。' },
          h(Card, null,
            ((cal.data && cal.data.suggestions) || []).length === 0
              ? h('div', { className: 'dshc-sub' }, '暂无建议（状态已贴近默认或样本不足）。')
              : (cal.data.suggestions || []).map((s) => h(Row, { key: s.key, label: s.key },
                h('span', { className: 'm dshc-mono' }, String(s.current) + ' →' + String(s.suggested)),
                h('span', { className: 'dshc-sub' }, s.reason))),
            h('div', { className: 'dshc-form', style: { marginTop: 8 } },
              h(Btn, {
                onClick: async () => {
                  setCalMsg('')
                  try {
                    const r = await act(() => call('POST', '/v1/agents/' + enc(aid) + '/eval/calibration', {}, true))
                    setCalMsg('已应用 ' + (r.applied || []).length + ' 项')
                    setTick((t) => t + 1)
                  } catch (e) { setCalMsg(e.message) }
                },
          }, '重铺接下来的底色')),
            calMsg ? h('div', { className: 'dshc-note' }, calMsg) : null)),

        h(Sec, { title: view === 'user' ? '最近 30 天的变化' : '指标历史（30 天）', desc: '按天平均；没有采样就空着，不补假点。' },
          h(Card, null,
            Object.entries((hist.data && hist.data.series) || {}).length === 0
              ? h('div', { className: 'dshc-sub' }, '还没有历史采样。点上面的「采样一次」。')
              : Object.entries((hist.data && hist.data.series) || {}).map(([k, pts]) => h('div', {
                key: k, className: 'dshc-row', style: { display: 'block', padding: '10px 0' },
              },
                h('div', { style: { display: 'flex', justifyContent: 'space-between' } },
                  h('span', { className: 'dshc-mono' }, k),
                  h('span', { className: 'dshc-sub' }, pts.length + ' 天 · 最新 ' + pts[pts.length - 1].value)),
                h('div', { style: { color: 'var(--accent)', marginTop: 4 } }, spark(pts)))))),

        METRIC_GROUPS.map(([prefix, label]) => {
          const rows = catalog.map((m, i) => ({ ...m, i })).filter((m) => m.key.startsWith(prefix + '.'))
          if (!rows.length) return null
          return h(Sec, { key: prefix, title: label + '（' + rows.length + ' 条）' },
            h(Card, null, h('div', { className: 'dshc-list' }, rows.map((m) => {
              const spec = SPEC[m.i] || ['—', '', false]
              const v = values[m.key] && values[m.key].value
              return h('div', { key: m.key, className: 'dshc-item' },
                h(Pill, { tone: spec[2] ? 'bad' : undefined }, spec[2] ? '★' : '·'),
                h('div', { className: 't' },
                  h('div', null, m.label),
                  h('div', { className: 'dshc-sub dshc-mono' }, m.key + (view === 'tech' ? ' · ' + spec[1] : ''))),
                h('div', { className: 'm dshc-mono', style: { minWidth: 78, textAlign: 'right' } }, v == null ? '—' : String(v)),
                h('div', { className: 'm', style: { minWidth: 84, textAlign: 'right' } }, spec[0]))
            }))))
        }),

        h(Sec, { title: view === 'user' ? '它还认得出自己吗' : '同一性盲测（5 轮）', desc: '它是不是「还是同一个人」，只能靠你盲选。' }, h(Card, null, h(BlindCard, { aid, act }))),

        view === 'tech' ? h(Tech, null, 'Recall@5 ≥ 0.70；nDCG@5 ≥ 0.75；误召回 ≤ 0.15\nκ ≥ 0.60；MAE ≤ 0.15；档位抖动 ≤ 1/天\n52 条指标见附录 E；★ = 发版硬门槛') : null,
        h(Sec, { title: view === 'user' ? '这些标准从哪学的' : '科研依据（只借测法，不借数值）' },
          h(Card, null, h('div', { className: 'dshc-sub' },
            'LoCoMo / LongMemEval、CharacterEval / PersonaChat、GoEmotions / MELD / EmpatheticDialogues。' +
            'BEIR / nDCG、RAGAS、Landis & Koch κ、DORA / SRE、自我决定论。论文分数是在固定数据集上测的，直接当产品目标会失真。'))))
    }

    /* =========================================================== settings */

    /* 鈥斺€?璁剧疆椤碉細鎸夐〉澶存爣绛惧垎缁勭殑銆岃兘鏀圭殑鍙傛暟銆嶁€斺€?       keys 涓?src/kernel.js 鐨?PARAMS 瀵归綈锛涙病褰掔粍鐨勪竴寰嬭惤鍒版渶鍚庣殑銆屽叾浠栥€嶏紝
       杩欐牱浠ュ悗鍔犲弬鏁颁篃涓嶄細鍦ㄧ晫闈笂鍑┖娑堝け銆?*/
    const PARAM_META = {
      'memory.decay.lambda': ['衰减速度', '旧事沉得多快；由记忆页那四个旋钮直管，这里只作兜底名。'],
      'memory.recall.floor': ['遗忘阈值', '沉到多低就不再提；由记忆页那四个旋钮直管。'],
      'memory.inject.budget': ['每轮注入预算', '每轮带多少 token 的记忆进对话；由记忆页那四个旋钮直管。'],
      'memory.auto': ['自动记忆', '聊完自动抽事实 / 偏好；由记忆页那四个旋钮直管。'],
      'memory.recall.weights.relation': ['关系权重', '记忆挂在熟人 / 主人名下时，召回多算多少；0 = 完全不看关系（默认 0.10）。'],
      'memory.inject.pool': ['候选池', '每轮先取多少条候选再打分（默认 50，10–200）；调小省算力。'],
      'memory.decay.formula': ['衰减公式', '旧事往抽屉里沉的速度用哪一版；一般不动。'],
      'memory.recall.formula': ['召回公式', '按当前这句话找记忆用哪一版；一般不动。'],
      'memory.retrieve.formula': ['检索公式', '关键词和语义怎么混合；一般不动。'],
      'persona.learn_rate': ['学习速率', '被夸、被刺痛、重复的事，一次最多让鱼格挪多少；和单次步幅上限取小（默认 0.05）。'],
      'persona.axes.mode': ['MBTI 效应', '关 = 完全不算；只算不用 = 只更新数字，不影响说话；开 = 影响情绪强度和语气。默认开。'],
      'persona.worldview.nightly': ['夜间重长世界观', '每天巩固时重算八维世界观（Primals/WAS/公理）；关 = 跳过。默认开。'],
      'persona.lifeview.nightly': ['夜间重长人生观', '每天巩固时重算七维人生观并凝练 telos；关 = 跳过。默认开。'],
      'affect.decay': ['情绪衰减', '说完一轮之后，情绪往平静回落多少；0 = 不回落。'],
      'affect.mapping': ['情绪映射', '情绪词表认哪一版；一般不动。'],
      'affect.dynamics.formula': ['情绪动力学', '情绪怎么升、怎么落用哪一版；一般不动。'],
      'drive.deficit.formula': ['缺口算法', '五个缺口怎么合成一个总缺口；一般不动。'],
      'condition.coef': ['工况系数', '累 / 忙 / 状态差时，情绪和记忆被放大多少；2.5 是中性刻度。'],
      'guard.budget.c3': ['C3 令牌上限', 'C3 最多能攒几枚令牌（每 30 天回 1 枚）；只读。'],
      'persona.step_cap': ['单次步幅上限', '鱼格一次最多变多少；和学习速率取小（只读）。'],
      'mind.meter.enable': ['水位提醒', '上下文快到上限时提一句「想留的现在记一下」；关 = 不提。'],
      'mind.meter.ratio': ['提醒水位', '用到窗口的这个比例开始提醒（0.3–0.8）。到 0.8 原生压缩自己会动手，所以不会等到最后。'],
      'mind.meter.window': ['上下文窗口', '宿主没告诉插件窗口大小时用这个数。「自动」= 只信宿主，拿不到就不提醒。'],
      'mind.review.enable': ['欠债提醒', '上次夜间整理没跑成、又攒了没归档的对话时，提一句。'],
      'mind.review.hours': ['多久算欠债', '距上次整理超过这么多小时才开始算（默认 20）。'],
      'mind.review.min_turns': ['欠多少条', '上次整理之后又攒够这么多条原始对话才值得提（默认 20）。'],
      'mind.review.cooldown_hours': ['提醒冷却', '同一句提醒最多隔这么多小时再说一次（默认 6）。'],
      'gate.guest.enable': ['认人硬闸', '客人的会话里不许翻主人的记忆（memory_search 直接拒，群聊一律拒）；关 = 不拦，排查用。'],
    }

    /** 璁板繂椤靛崱鐗囩殑鍥涗釜鏃嬮挳锛氱敱 MemorySettingsCard 鐩寸锛屽垎缁勯噷鍙敤鏉ャ€屽埆閲嶅鍒楄繘鍏朵粬銆?*/
    const MEMORY_CARD_KEYS = new Set(['memory.decay.lambda', 'memory.recall.floor', 'memory.inject.budget', 'memory.auto'])

    /** 椤靛ご鏍囩 →璁剧疆鍒嗙粍锛沰eys 涔嬪鐨勫弬鏁拌嚜鍔ㄨ繘銆屽叾浠栥€嶃€?*/
    const PARAM_TAB_GROUPS = [
      {
        key: 'memory', tab: '记忆', title: '记忆设置',
        keys: ['memory.decay.lambda', 'memory.recall.floor', 'memory.inject.budget', 'memory.auto', 'memory.recall.weights.relation', 'memory.inject.pool', 'memory.decay.formula', 'memory.recall.formula', 'memory.retrieve.formula'],
      },
      {
        key: 'mind', tab: '心里', title: '心里的话',
        desc: '上下文水位和复盘欠债：都只在「快来不及」时提一句，不触发就一个字都不占。',
        keys: ['mind.meter.enable', 'mind.meter.ratio', 'mind.meter.window', 'mind.review.enable', 'mind.review.hours', 'mind.review.min_turns', 'mind.review.cooldown_hours'],
      },
      {
        key: 'gate', tab: '认人', title: '认人硬闸',
        desc: '客人的会话（陌生人私聊 / 群聊）里，memory_search 直接拒。主人判定跟 QQ 桥接同一套；网页/本机一律算主人。',
        keys: ['gate.guest.enable'],
      },
      {
        key: 'affect', tab: '情绪', title: '情绪设置',
        keys: ['persona.learn_rate', 'persona.axes.mode', 'persona.worldview.nightly', 'persona.lifeview.nightly'],
      },
      {
        key: 'drive', tab: '驱力', title: '驱力设置',
        keys: ['affect.decay', 'affect.mapping', 'affect.dynamics.formula'],
      },
      {
        key: 'persona', tab: '鱼格', title: '鱼格设置',
        keys: ['drive.deficit.formula'],
      },
    ]

    /** 闀块〉闈㈤噷鐨勫垎缁勮烦杞細鐐逛竴涓嬭惤鍒板搴旈偅缁?*/
    function SettingJump({ items }) {
      const [on, setOn] = useState('')
      const go = (key) => {
        setOn(key)
        scrollToBlock('dshc-set-' + key)
      }
      return h('div', { className: 'dshc-set-nav' }, (items || []).map(([key, label]) =>
        h('button', { key, type: 'button', 'data-on': on === key ? '1' : '0', onClick: () => go(key) }, label)))
    }

    /** 涓€琛屽彲鏀瑰弬鏁帮細鍊?+ 淇敼/鎻愭 + 涓€鍙ヤ汉璇濓紱tech 瑙嗗浘棰濆鏄剧ず閿悕 */
    function ParamRow({ p, view, draft, onDraft, onSave }) {
      const meta = PARAM_META[p.key] || []
      const label = meta[0] || p.key
      const hint = meta[1] || ''
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState(null)
      const v = draft !== undefined ? draft : p.value
      const enumItems = p.key === 'persona.axes.mode'
        ? [['off', '关'], ['shadow', '只算不用'], ['on', '开']]
        : null
      async function save() {
        setBusy(true); setNote(null)
        try { setNote(await onSave()) } catch (e) { setNote({ ok: false, text: e.message || String(e) }) }
        finally { setBusy(false) }
      }
      return h('div', { className: 'dshc-param' },
        h(Row, { label },
          h(Pill, { on: p.level === 'C4', tone: p.level === 'C0' ? 'bad' : undefined }, p.level),
          p.level === 'C0'
            ? h('span', { className: 'm dshc-mono' }, '只读 ' + String(p.value))
            : enumItems
              ? h('select', {
                className: 'dshc-sel dshc-param-sel', value: String(v),
                onChange: (e) => onDraft(e.target.value),
              }, enumItems.map(([val, txt]) => h('option', { key: val, value: val }, txt)))
              : typeof p.value === 'boolean'
                ? h('input', {
                  type: 'checkbox', style: { marginLeft: 'auto' },
                  checked: !!v, onChange: (e) => onDraft(e.target.checked),
                })
                : h('input', {
                  className: 'dshc-in', style: { width: 92, marginLeft: 'auto' },
                  defaultValue: String(p.value),
                  onChange: (e) => onDraft(e.target.value),
                }),
          p.level === 'C0' ? null : h(Btn, { sm: true, disabled: busy, onClick: save },
            busy ? '保存中…' : (p.level === 'C4' ? '修改' : '发起提案'))),
        h('div', { className: 'dshc-param-d' },
          view === 'tech' ? h('span', { className: 'k' }, p.key) : null,
          hint,
          note ? h('span', { style: { marginLeft: 8, color: note.ok ? 'var(--ok)' : 'var(--bad)' } }, note.text) : null))
    }

    /** 銆岄〉澶?路 璁板繂銆嶈繖绉嶅皬鐗屽瓙锛岃鍒嗙粍鍜屼笂鏂归〉绛惧寰椾笂 */
    const TabMark = ({ tab }) => h(Pill, null, '页头 · ' + tab)

    /** 「其他」里的可收起区块：收起时只留一行摘要，点开才看控件 */
    function FoldBlock({ title, desc, children, open: initOpen }) {
      const [open, setOpen] = useState(!!initOpen)
      return h('div', { className: 'dshc-foldsec' },
        h('details', {
          className: 'dshc-fold',
          open,
          onToggle: (e) => setOpen(!!(e.currentTarget && e.currentTarget.open)),
        },
          h('summary', null,
            h('span', { className: 'dshc-fold-t' }, title),
            desc ? h('span', { className: 'dshc-fold-s' }, desc) : null),
          h('div', { className: 'dshc-fold-body' }, h(Card, null, children))))
    }

    /** 鍥涗釜璁剧疆缁勭粺涓€鐨勬棆閽鏍硷細婊戞潌 / 涓夋鎸夐挳锛涗腑鏂囧悕鍜岃鏄庝粠 PARAM_META 鍙?*/
    const SETTING_KNOBS = {
      persona: [
        { key: 'persona.learn_rate', kind: 'range', min: 0.01, max: 0.2, step: 0.01, digits: 3, def: 0.05 },
        { key: 'persona.axes.mode', kind: 'choice', def: 'on', choices: [['off', '关'], ['shadow', '只算不用'], ['on', '开']] },
      ],
      affect: [
        { key: 'affect.decay', kind: 'range', min: 0, max: 1, step: 0.05, digits: 2, def: 0.4 },
      ],
      // 心里的话：水位提醒 + 复盘欠债。全是 0/1 或区间量，一屏能放下。
      mind: [
        { key: 'mind.meter.enable', kind: 'choice', def: 'on', choices: [['off', '关'], ['on', '开']] },
        { key: 'mind.meter.ratio', kind: 'range', min: 0.3, max: 0.8, step: 0.05, digits: 2, def: 0.6 },
        { key: 'mind.meter.window', kind: 'choice', def: 0, choices: [[0, '自动'], [32000, '32k'], [64000, '64k'], [128000, '128k'], [200000, '200k']] },
        { key: 'mind.review.enable', kind: 'choice', def: 'on', choices: [['off', '关'], ['on', '开']] },
        { key: 'mind.review.hours', kind: 'range', min: 6, max: 72, step: 6, digits: 0, def: 20 },
        { key: 'mind.review.min_turns', kind: 'range', min: 5, max: 100, step: 5, digits: 0, def: 20 },
        { key: 'mind.review.cooldown_hours', kind: 'range', min: 0, max: 48, step: 1, digits: 0, def: 6 },
      ],
      // 认人硬闸：一个开关，默认开。关掉就退回「谁调都能翻」。
      gate: [
        { key: 'gate.guest.enable', kind: 'choice', def: 'on', choices: [['off', '关'], ['on', '开']] },
      ],
      // 椹卞姏娌℃湁鏃嬮挳锛氫簲鏉″熀绾跨敱 deficit@v2 浠庣粡鍘嗛噷鑷繁闀匡紙瑙?DriveBaselineCard锛?''
              }

    /** 鍜屻€岃蹇嗚缃€嶅悓涓€濂楁帓鐗堬細涓€琛屼竴涓棆閽紝涓嬮潰涓€鍙ヤ汉璇濓紝搴曢儴涓€涓繚瀛?*/
    function KnobCard({ aid, act, params, specs, onSaved }) {
      const [f, setF] = useState(null)
      const [msg, setMsg] = useState('')
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState(false)
      const list = specs || []
      const read = (k, d) => {
        const p = (params || []).find((x) => x.key === k)
        return p && p.value != null ? p.value : d
      }
      const v = f || list.reduce((o, it) => { o[it.key] = read(it.key, it.def); return o }, {})
      const meta = (it) => PARAM_META[it.key] || []
      const show = (it, val) => it.kind === 'choice'
        ? ((it.choices || []).find(([k]) => String(k) === String(val)) || ['', ''])[1]
        : Number(val).toFixed(it.digits == null ? 2 : it.digits)
      async function write(vals, word) {
        setBusy(true); setErr(''); setMsg('')
        try {
          for (const it of list) {
            const value = it.kind === 'choice' ? String(vals[it.key]) : Number(vals[it.key])
            await act(() => call('PUT', '/v1/agents/' + enc(aid) + '/params/' + enc(it.key), { value }, true))
          }
          setMsg(word); setF(null)
          if (onSaved) onSaved()
        } catch (e) { setErr(e.message || String(e)) } finally { setBusy(false) }
      }
      const save = () => write(v, '已保存')
      const reset = () => {
        if (!window.confirm('把这组旋钮恢复默认？')) return
        const d = list.reduce((o, it) => { o[it.key] = it.def; return o }, {})
        write(d, '已恢复默认')
      }
      // 璇存槑鍖猴細宸﹁竟鍥哄畾鐨勫皬鏍囬銆佸彸杈逛竴鍙ヤ汉璇濓紝鍜岃蹇嗚缃繚鎸佷竴鑷?''
              const hintRow = (k, t) => h('div', { style: { display: 'flex', gap: 10, alignItems: 'baseline' } },
        h('span', {
          style: { flex: 'none', width: 72, fontSize: 11.5, letterSpacing: .3, color: 'var(--muted)', textAlign: 'right' },
        }, k),
        h('span', { style: { flex: 1, fontSize: 12.5, lineHeight: 1.72, color: 'var(--ink)', opacity: .85 } }, t))
      return h(Card, null,
        list.map((it) => h(Row, { key: it.key, label: meta(it)[0] || it.key },
          it.kind === 'choice'
            ? h(Seg, { items: it.choices, value: String(v[it.key]), onChange: (x) => setF({ ...v, [it.key]: x }) })
            : h('input', {
              type: 'range', min: it.min, max: it.max, step: it.step, value: v[it.key],
              onChange: (e) => setF({ ...v, [it.key]: Number(e.target.value) }), style: { width: 150 },
            }),
          h('span', { className: 'dshc-mono', style: { width: 112, textAlign: 'right' } }, show(it, v[it.key])))),
        h('div', {
          style: { marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 7 },
        }, list.map((it) => h('div', { key: it.key }, hintRow(meta(it)[0] || it.key, meta(it)[1] || '')))),
        h('div', { style: { marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' } },
          h(Btn, { primary: true, disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
          h(Btn, { ghost: true, disabled: busy, onClick: reset }, '恢复默认')),
        err ? h('div', { className: 'dshc-err' }, err) : null,
        msg ? h('div', { className: 'dshc-note' }, msg) : null)
    }

    /**
     * 鎯呯华璁剧疆锛氭晱鎰熷害 + 鎯呯华琛板噺锛屼竴寮犲崱銆佷竴涓繚瀛樸€?     * 涓よ€呴兘鍦ㄨ皟銆屾儏缁湁澶氬搷銆佹暎澶氬揩銆嶏紝涔嬪墠鎷嗘垚涓ゅ紶鍗′袱涓繚瀛樻寜閽紝澶銆?     * 鏁忔劅搴﹀啓 persona.axis.sensitivity锛坢anual锛屼笉鍐嶈嚜宸辨紓锛夛紱琛板噺鍐?agent_params銆?     * 鏁板€奸鍛婄殑鏇茬嚎鐢卞涓?/persona/axes 缁欙紝鍓嶇鍙仛涓€娆＄嚎鎬ф崲绠楋紝閬垮厤涓よ竟鍏紡婕傘€?     */
    function AffectCard({ aid, act, params, onSaved }) {
      const [s, reloadAxis] = useAsync(async () => {
        const degradedFrom = (rows) => {
          const row = (rows || []).find((r) => r.path === 'axis.sensitivity') || {}
          return {
            degraded: true, default: 0.8, curve: null, effects: null,
            axes: [{ key: 'sensitivity', label: '敏感', value: Number(row.value), origin: row.origin || 'auto' }],
          }
        }
        let got = null
        try {
          got = await call('GET', '/v1/agents/' + enc(aid) + '/persona/axes')
        } catch (e) {
          if (e.code !== 'NOT_FOUND') throw e
          got = null
        }
        if (got && Array.isArray(got.axes) && got.curve) return got
        // 鑰佸涓伙細鏂版帴鍙ｅ彲鑳?404锛屼篃鍙兘琚綋鎴?/persona 杩斿洖鏁磋〃锛涗袱绉嶉兘閫€鍥炴棫璇绘硶锛?''
              // 滑杆和保存现在就能用，数值预告等热加载后再给
        const rows = Array.isArray(got) ? got : await call('GET', '/v1/agents/' + enc(aid) + '/persona')
        return degradedFrom(rows)
      }, [aid])
      const spec = (SETTING_KNOBS.affect || [])[0] || { key: 'affect.decay', min: 0, max: 1, step: 0.05, digits: 2, def: 0.4 }
      const DEF_D = Number(spec.def)
      const [f, setF] = useState(null)
      const [msg, setMsg] = useState('')
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState(false)
      const d = s.data || null
      const axis = d ? (d.axes || []).find((x) => x.key === 'sensitivity') : null
      const DEF_S = d && Number.isFinite(Number(d.default)) ? Number(d.default) : 0.8
      const curS = axis && Number.isFinite(Number(axis.value)) ? Number(axis.value) : DEF_S
      const pDecay = (params || []).find((x) => x.key === spec.key)
      const curD = pDecay && pDecay.value != null ? Number(pDecay.value) : DEF_D
      const v = f || { sens: curS, decay: curD }
      const fx = (x) => {
        const c = d && d.curve
        if (!c) return null
        const n = Math.max(0, Math.min(1, Number(x) || 0))
        return {
          swing: (c.base + c.span * n) * c.gain,
          threshold: c.thBase - c.thSlope * n,
          halfLife: c.halfBase + c.halfSlope * n,
        }
      }
      const wordOf = (x) => (x >= 0.7 ? '敏感' : x >= 0.55 ? '偏敏感' : x >= 0.45 ? '平衡' : x >= 0.25 ? '偏钝感' : '钝感')
      const now = fx(curS)
      const draft = fx(v.sens)
      const pct = (a, b) => (b ? Math.round((a / b - 1) * 100) : 0)
      const signed = (n) => (n > 0 ? '+' : '') + n + '%'
      const dirty = !!f && (Math.abs(v.sens - curS) > 1e-9 || Math.abs(v.decay - curD) > 1e-9)

      async function persist(sens, decay) {
        setBusy(true); setErr(''); setMsg('')
        const wrote = []
        try {
          if (Math.abs(sens - curS) > 1e-9) {
            await act(() => call('PUT', '/v1/agents/' + enc(aid) + '/persona/axis.sensitivity', { value: Number(sens) }, true))
            wrote.push('敏感度 ' + Number(sens).toFixed(2) + '（' + wordOf(sens) + '）')
          }
          if (Math.abs(decay - curD) > 1e-9) {
            await act(() => call('PUT', '/v1/agents/' + enc(aid) + '/params/' + enc(spec.key), { value: Number(decay) }, true))
            wrote.push('情绪衰减 ' + Number(decay).toFixed(2))
          }
          setMsg(wrote.length ? '已保存：' + wrote.join(' · ') : '没有改动')
          setF(null)
          reloadAxis()
          if (onSaved) onSaved()
        } catch (e) { setErr(e.message || String(e)) } finally { setBusy(false) }
      }
      const save = () => persist(Number(v.sens), Number(v.decay))
      const reset = () => {
        if (!window.confirm('两个旋钮都恢复默认？\n敏感度 ' + DEF_S.toFixed(2) + ' · 情绪衰减 ' + DEF_D.toFixed(2))) return
        persist(DEF_S, DEF_D)
      }
      async function release() {
        setBusy(true); setErr(''); setMsg('')
        try {
          await act(() => call('PUT', '/v1/agents/' + enc(aid) + '/persona/axis.sensitivity', { value: Number(curS), origin: 'auto' }, true))
          setMsg('已交回给经历：敏感度以后会自己慢慢漂')
          reloadAxis()
          if (onSaved) onSaved()
        } catch (e) { setErr(e.message || String(e)) } finally { setBusy(false) }
      }
      async function rebuild() {
        if (!window.confirm('按现在的敏感度，重铺「接下来」的情绪底色？\n\n· 已经过去的走势不改\n· 正在走的这一段，还没走完的尾巴会按新幅度重算\n· 之后的几天是全新的起伏')) return
        setBusy(true); setErr(''); setMsg('')
        try {
          await act(() => call('POST', '/v1/agents/' + enc(aid) + '/affect/rebuild-baseline', {}, true))
          setMsg('接下来的底色已按 ' + Number(curS).toFixed(2) + ' 重铺；明天的走势就会有新起伏')
        } catch (e) { setErr(e.message || String(e)) } finally { setBusy(false) }
      }

      // 璇存槑鍖猴細宸﹁竟鍥哄畾鐨勫皬鏍囬銆佸彸杈逛竴鍙ヤ汉璇濓紝鍜岃蹇嗚缃繚鎸佷竴鑷?''
              const hintRow = (k, t) => h('div', { style: { display: 'flex', gap: 10, alignItems: 'baseline' } },
        h('span', {
          style: { flex: 'none', width: 72, fontSize: 11.5, letterSpacing: .3, color: 'var(--muted)', textAlign: 'right' },
        }, k),
        h('span', { style: { flex: 1, fontSize: 12.5, lineHeight: 1.72, color: 'var(--ink)', opacity: .85 } }, t))

      return h(Card, null,
        d
          ? h('div', null,
            h(Row, { label: '敏感度' },
              h('input', {
                type: 'range', min: 0, max: 1, step: 0.01, value: v.sens,
                onChange: (e) => setF({ ...v, sens: Number(e.target.value) }), style: { width: 150 },
              }),
              h('span', { className: 'dshc-mono', style: { width: 92, textAlign: 'right' } },
                Number(v.sens).toFixed(2) + ' · ' + wordOf(v.sens)),
              axis ? h(Pill, { on: axis.origin === 'manual' }, axis.origin === 'manual' ? '你定的' : '自己长的') : null),
            h('div', { className: 'dshc-sub', style: { margin: '-2px 0 2px 0', paddingLeft: 2 } },
              '0 钝感 · 0.5 平衡 · 1 敏感'),
            draft
              ? h('div', { style: { marginTop: 4 } },
                h(Row, { label: '情绪摆幅' },
                  h('span', { className: 'dshc-mono' }, '卤' + draft.swing.toFixed(2)),
                  now && Math.abs(v.sens - curS) > 1e-9
                    ? h('span', { className: 'dshc-sub' }, ' 现在 ±' + now.swing.toFixed(2) + '（' + signed(pct(draft.swing, now.swing)) + '）')
                    : h('span', { className: 'dshc-sub' }, ' 底色每段摆多少')),
                h(Row, { label: '小事门槛' },
                  h('span', { className: 'dshc-mono' }, draft.threshold.toFixed(2)),
                  h('span', { className: 'dshc-sub' },
                    (now && Math.abs(v.sens - curS) > 1e-9 ? ' 现在 ' + now.threshold.toFixed(2) + '；' : ' ') + '越低越容易被小事戳到')),
                h(Row, { label: '恢复速度' },
                  h('span', { className: 'dshc-mono' }, '×' + draft.halfLife.toFixed(2)),
                  h('span', { className: 'dshc-sub' },
                    (now && Math.abs(v.sens - curS) > 1e-9 ? ' 现在 ×' + now.halfLife.toFixed(2) + '（' + signed(pct(draft.halfLife, now.halfLife)) + '）；' : ' ') + '越大越难散')))
              : null)
          : h('div', { className: 'dshc-sub' },
            s.loading ? '敏感度读取中…' : ('敏感度读取失败：' + s.error)),
        h(Row, { label: '情绪衰减' },
          h('input', {
            type: 'range', min: spec.min, max: spec.max, step: spec.step, value: v.decay,
            onChange: (e) => setF({ ...v, decay: Number(e.target.value) }), style: { width: 150 },
          }),
          h('span', { className: 'dshc-mono', style: { width: 92, textAlign: 'right' } },
            Number(v.decay).toFixed(spec.digits == null ? 2 : spec.digits))),
        h('div', {
          style: { marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 7 },
        },
          hintRow('衰减速度', '只管「长期 · 抽屉」：调大，旧事沉得更快；调小，记得更久。'),
          hintRow('注入预算', '越大，每轮带进对话的记忆越多；越小越省，先砍记忆。')),
        d && d.degraded
          ? h('div', { className: 'dshc-note' }, '宿主还是旧的：数值预告要等插件热加载后才出现。先把「意识」插件关再开（设置 → 插件），滑杆和保存现在就能用。')
          : null,
        h('div', { style: { marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          h(Btn, { primary: true, disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
          h(Btn, { ghost: true, disabled: busy, onClick: reset }, '恢复默认'),
          axis && axis.origin === 'manual' && !(d && d.degraded)
            ? h(Btn, { ghost: true, disabled: busy, onClick: release }, '交回经历')
            : null,
          h(Btn, {
            ghost: true, disabled: busy || !d || d.degraded || dirty,
            title: dirty ? '先保存，再按新幅度重铺' : '',
            onClick: rebuild,
            }, '跑盲测')),
        err ? h('div', { className: 'dshc-err' }, err) : null,
        msg ? h('div', { className: 'dshc-note' }, msg) : null,
        h('div', { className: 'dshc-note', style: { marginTop: 8 } },
          '敏感度出厂默认 ' + DEF_S.toFixed(2) + '：情绪摆幅比中性档大约三成。1.00 是顶格——最戏剧，也最不像人。'))
    }

    /**
     * 椹卞姏璁剧疆锛氭病鏈夋粦鏉嗐€?     * 浜旀潯鍩虹嚎鏄畠鑷繁浠庣粡鍘嗛噷闀垮嚭鏉ョ殑锛坉eficit@v2锛夛細涔犳儻 = 鏈€杩戣繃寰楁€庝箞鏍凤紝
     * 鍩虹嚎 = 涔犳儻 + 涓€鐐硅儍鍙ｏ紱琚€庝箞瀵瑰緟寰椾箙锛屽氨鎶婁粈涔堝綋鎴愭甯搞€?     * 杩欓噷鍙妸闀挎垚浠€涔堟牱缁欎綘鐪嬶紝鏀逛笉浜嗏€斺€旇繖姝ｆ槸銆屼笉鏄墜璋冪殑銆嶃€?     */
    function DriveBaselineCard({ aid, act }) {
      const [s] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/drive'), [aid])
      const d = s.data || {}
      const sp = d.setpoint || {}
      const habit = (d.learn && d.learn.habit) || {}
      const fmt = (v, dft) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : dft)
      const ready = !!sp.R
      return h(Card, null,
        h('div', { className: 'dshc-sub' },
          '这五条基线不是调出来的，是它自己长出来的：被怎么对待得久了，就把什么当成「正常」。'),
        h('div', { style: { marginTop: 10 } },
          DIMS.map(([k, label]) => h(Row, { key: k, label },
            h(Bar, { value: Number(sp[k]) || 0 }),
            h('span', { className: 'm dshc-mono', style: { width: 44, textAlign: 'right' } }, fmt(sp[k], '—')),
            h('span', { className: 'm dshc-sub', style: { width: 78, textAlign: 'right' } },
              habit[k] == null ? '' : '习惯 ' + fmt(habit[k], '—'))))),
        !ready ? h('div', { className: 'dshc-sub' }, s.loading ? '读取中…' : '还没有驱力数据；聊过一轮就会开始长。') : null,
        h('div', { className: 'dshc-note', style: { marginTop: 10 } },
          '基线总比习惯高一点点，所以它不会完全满足；第一次评估会先对齐到「现在的习惯 + 0.08」，之后每天最多挪 0.02，被冷落久了也会把期待往下调。'),
        CURRENT_VIEW === 'tech' && d.algo
          ? h('div', { className: 'dshc-sub dshc-mono' }, 'deficit@' + (d.algo.version || '?') + ' · 设定点写在 drive_state.setpoint')
          : null)
    }

    /**
     * QQ 閫氶亾锛氬ス銆屽湪涓嶅湪绾裤€嶃€?     * 妗ュ拰 NapCat 鍒嗕袱灞傛樉绀猴細妗ユ病璧?vs QQ 鎺変簡锛屽鐞嗗姙娉曚笉涓€鏍枫€?     * 椤哄甫鑳芥敼澶氳疆鍘嗗彶鍜屽彫鍥炴潯鏁扳€斺€旇繖涓や釜鍙奖鍝?QQ 杩欒竟璇磋瘽鐨勬墜鎰熴€?     */
    /**
     * QQ 接线：每段聊天现在挂在哪个会话上、断没断。
     * 数据来自只读接口 GET /v1/qq/watch；跟 QQ 通道同页展示，不另开页面。
     * 布局刻意不走 dshc-row：那一行是「左标签 + 右值」，塞多个元素在窄屏会挤。
     */
    function QQWatchBlock() {
      const [s, reload] = useAsync(() => call('GET', '/v1/qq/watch'), [])
      useLive(reload, 15000)
      const d = s.data || {}
      const b = d.bridge || {}
      const rows = Array.isArray(d.chatters) ? d.chatters : []
      const t = (x) => (x ? String(x).replace('T', ' ').slice(5, 16) : '—')
      const dot = (st) => (st === 'ok' ? 'var(--ok)' : st === 'idle' ? 'var(--warn)' : 'var(--bad)')
      const err = s.error ? '读不到接线：' + (s.error.message || String(s.error)) : ''
      // 桥可能是「进程内」的，也可能只是快照过期了：别把过期的在线当成在线。
      const bstate = b.online !== true
        ? ['桥没起', 'var(--bad)']
        : (b.fresh === false ? ['桥静了', 'var(--warn)'] : ['桥在线', 'var(--ok)'])
      return h('div', { style: { marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--line)' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 12.5, fontWeight: 600, color: 'var(--ink)' } }, '接线'),
          h('span', { style: { fontSize: 11.5, color: bstate[1] } },
            h('span', { style: { color: bstate[1], marginRight: 5 } }, '●'),
            bstate[0]),
          h('span', { className: 'dshc-sub', style: { flex: 1, minWidth: 80 } }, b.trace_at ? '最后活动 ' + t(b.trace_at) : ''),
          h(Btn, { ghost: true, sm: true, onClick: reload }, '刷新')),
        err ? h('div', { className: 'dshc-note', style: { color: 'var(--bad)' } }, err) : null,
        rows.length === 0 && !s.loading ? h('div', { className: 'dshc-sub', style: { marginTop: 8 } }, '还没有 QQ 聊天记录。') : null,
        rows.map((r) => h('div', { key: r.session_id || r.chat_key, style: { padding: '9px 0', borderBottom: '1px dashed var(--line)' } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', minWidth: 0 } },
            h('span', { style: { width: 7, height: 7, borderRadius: 99, background: dot(r.state), flex: '0 0 auto', transform: 'translateY(-1px)' } }),
            h('span', { style: { fontSize: 13, color: 'var(--ink)', fontWeight: 500 } }, r.label || r.chat_key || '聊天'),
            r.agent ? h('span', { className: 'dshc-sub', style: { fontSize: 11.5 } }, '· ' + r.agent) : null,
            h('span', { style: { flex: 1 } }),
            h('span', { className: 'dshc-sub', style: { fontSize: 11.5 } },
              t(r.last_at) + (r.age_hours == null ? '' : ' · ' + r.age_hours + ' 小时前'))),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline', marginTop: 3, paddingLeft: 15 } },
            h('span', { className: 'dshc-mono', style: { fontSize: 11, color: 'var(--muted)' } }, r.short || String(r.session_id || '').slice(-8)),
            r.source ? h('span', { className: 'dshc-sub', style: { fontSize: 11 } }, r.source) : null,
            r.note ? h('span', { style: { fontSize: 11, color: r.state === 'down' ? 'var(--bad)' : 'var(--muted)' } }, r.note) : null))),
        h('div', { className: 'dshc-note', style: { marginTop: 8 } },
          '绿=现在通着；黄=绑着但很静，或换下来的旧会话；红=这段没绑上、记忆链断了。'))
    }

    function QQChannelCard({ act }) {
      const [s, reload] = useAsync(() => call('GET', '/v1/qq/health'), [])
      const [cfg, setCfg] = useAsync(() => call('GET', '/v1/qq/settings'), [])
      const [convs, reloadConvs] = useAsync(() => call('GET', '/v1/conversations'), [])
      const [agents] = useAsync(() => call('GET', '/v1/agents'), [])
      const [draft, setDraft] = useState(null)
      const [note, setNote] = useState(null)
      const h0 = s.data || {}
      const bridge = h0.bridge || {}
      const qq = h0.napcat || {}
      const local = !!bridge.local
      const c = cfg.data || {}
      const agentList = Array.isArray(agents.data) ? agents.data : []
      // 只列还活着的会话：释放掉的那几条（联调时留下的）不该继续挂在页面上
      const convList = ((convs.data && convs.data.conversations) || []).filter((x) => x.state !== 'released')
      const nameOf = (id) => (agentList.find((a) => a.id === id) || {}).name || id
      const v = draft || { history_turns: c.history_turns == null ? 8 : c.history_turns, recall_items: c.recall_items == null ? 10 : c.recall_items }
      const t = (x) => (x ? String(x).replace('T', ' ').slice(5, 19) : '—')
      const warming = !!h0.warming
      const state = s.loading && !s.data
        ? ['…', '']
        : h0.ok ? ['在线', 'ok'] : warming ? ['启动中', ''] : bridge.reachable ? ['QQ 掉线', 'bad'] : ['桥没起', 'bad']
      // 桥掉线不会有人来通知这张卡片，只能自己探：15 秒一次，页面切后台就停。
      useLive(reload, 15000)
      async function save() {
        setNote(null)
        try {
          const r = await act(() => call('PUT', '/v1/qq/settings', { history_turns: Number(v.history_turns) || 0, recall_items: Number(v.recall_items) || 10 }, true))
          setNote('已保存：带 ' + r.history_turns + ' 轮历史 · 每轮召 ' + r.recall_items + ' 条')
          setDraft(null); reload()
        } catch (e) { setNote('保存失败：' + (e.message || String(e))) }
      }
      async function rebind(conv, agentId) {
        setNote(null)
        try {
          const r = await act(() => call('POST', '/v1/conversations/bind', { conversation_id: conv.conversation_id, agent_id: agentId, handle: conv.handle || '' }, true))
          setNote('已改：' + (conv.handle || conv.conversation_id) + ' 现在由「' + r.agent_name + '」接，下一句生效')
          reloadConvs()
        } catch (e) { setNote('改绑失败：' + (e.message || String(e))) }
      }
      async function release(conv) {
        setNote(null)
        try {
          await act(() => call('DELETE', '/v1/conversations/' + encodeURIComponent(conv.conversation_id), null, true))
          setNote('已释放：' + (conv.handle || conv.conversation_id) + ' 回到默认角色，下一句重绑')
          reloadConvs()
        } catch (e) { setNote('释放失败：' + (e.message || String(e))) }
      }
      return h(Card, null,
        h(Row, { label: '状态' },
          h(Pill, { on: !!h0.ok, tone: state[1] === 'bad' ? 'bad' : undefined }, state[0]),
          h('span', { className: 'm dshc-sub' },
            h0.ok
              ? (local ? '桥就在宿主进程里，QQ 也登着' : '桥和 QQ 都在')
              : warming
                ? '宿主刚重启，桥还在起来（第一份心跳要等一会儿）'
                : bridge.reachable
                  ? '桥活着，但 NapCat / QQ 没应答' + (bridge.last_error ? '：' + bridge.last_error : '')
                  : '桥没连上，先看网关有没有起来'),
          h(Btn, { ghost: true, sm: true, onClick: reload }, '重新检测')),
        h(Row, { label: '机器人号' }, h('span', { className: 'v' }, qq.nickname ? qq.nickname + '（' + (qq.user_id || '') + '）' : (qq.ok ? '在线（桥没上报号码）' : (qq.error || '—')))),
        h(Row, { label: '桥' }, h('span', { className: 'm dshc-mono' }, (bridge.url || '—') + (bridge.uptime_sec != null ? ' · 已运行 ' + Math.floor(bridge.uptime_sec / 60) + ' 分钟' : ''))),
        h(Row, { label: '最近收到' }, h('span', { className: 'v' }, t(bridge.last_inbound_at)
          + (bridge.inbound == null && bridge.sent == null ? '' : '（收 ' + (bridge.inbound == null ? '—' : bridge.inbound) + ' / 发 ' + (bridge.sent == null ? '—' : bridge.sent) + '）')
          + (bridge.sessions ? ' · 在线会话 ' + bridge.sessions : ''))),
        bridge.last_error ? h(Row, { label: '上次出错' }, h('span', { className: 'm' }, String(bridge.last_error).slice(0, 120))) : null,
        h('div', { className: 'dshc-sub', style: { marginTop: 12 } }, '谁在接：改一下，下一句生效；旧账留在原来那位名下。'),
        convList.length === 0 ? h('div', { className: 'dshc-sub' }, '还没有 QQ 会话。') : null,
        convList.map((conv) => h(Row, { key: conv.conversation_id, label: conv.handle || conv.conversation_id },
          conv.handle === (c.owner || '') ? h(Pill, { on: true }, '主人') : null,
          h('select', {
            className: 'dshc-sel', value: conv.agent_id,
            onChange: (e) => rebind(conv, e.target.value),
          }, agentList.map((a) => h('option', { key: a.id, value: a.id }, a.name))),
          h('span', { className: 'm dshc-sub' }, '现在：' + nameOf(conv.agent_id)),
          h(Btn, { ghost: true, sm: true, onClick: () => release(conv) }, '释放'))),
        h('div', { style: { marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { className: 'dshc-sub' }, '带几轮历史'),
          h(Input, { style: { width: 64 }, value: String(v.history_turns), onChange: (e) => setDraft({ ...v, history_turns: e.target.value }) }),
          h('span', { className: 'dshc-sub' }, '轮 · 每轮'),
          h(Input, { style: { width: 64 }, value: String(v.recall_items), onChange: (e) => setDraft({ ...v, recall_items: e.target.value }) }),
          h('span', { className: 'dshc-sub' }, '条记忆'),
          h(Btn, { sm: true, onClick: save }, '保存')),
        note ? h('div', { className: 'dshc-note', style: { marginTop: 6 } }, note) : null,
        h('div', { className: 'dshc-note', style: { marginTop: 6 } }, '历史越多越连贯，但也更慢；0 = 只靠记忆和日记接话。'),
        h(QQWatchBlock))
    }

    function ProactiveCard({ aid, act }) {
      const [s, reload] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/proactive/settings'), [aid])
      const [f, setF] = useState(null)
      const [msg, setMsg] = useState('')
      const v = f || s.data || { enabled: true, per_day: 1, idle_hours: 6, quiet: true, quiet_from: '23:30', quiet_to: '07:30', push: false }
      async function save() {
        const r = await act(() => call('PUT', '/v1/agents/' + enc(aid) + '/proactive/settings', v, true))
        setMsg('已保存：' + (r.enabled ? '允许' : '不允许') + ' · 每天 ' + r.per_day + ' 句 · 沉默 ' + r.idle_hours + ' 小时'
          + (r.quiet ? ' · 半夜不打扰' : ' · 半夜也可以说') + (r.push ? ' · 会主动发消息' : ' · 只存不发'))
        setF(null); reload()
      }
      return h(Card, null,
        h(Row, { label: '允许主动开口' }, h('input', { type: 'checkbox', checked: !!v.enabled, onChange: (e) => setF({ ...v, enabled: e.target.checked }) })),
        h(Row, { label: '每天最多' }, h(Input, { style: { width: 72 }, value: v.per_day, onChange: (e) => setF({ ...v, per_day: Number(e.target.value) || 0 }) }), h('span', { className: 'dshc-sub' }, ' 句')),
        h(Row, { label: '至少沉默' }, h(Input, { style: { width: 72 }, value: v.idle_hours, onChange: (e) => setF({ ...v, idle_hours: Number(e.target.value) || 0 }) }), h('span', { className: 'dshc-sub' }, ' 小时')),
        h(Row, { label: '半夜别打扰（' + (v.quiet_from || '23:30') + '–' + (v.quiet_to || '07:30') + '）' },
          h('input', { type: 'checkbox', checked: v.quiet !== false, onChange: (e) => setF({ ...v, quiet: e.target.checked }) })),
        h(Row, { label: '允许它主动发消息' },
          h('input', { type: 'checkbox', checked: !!v.push, onChange: (e) => setF({ ...v, push: e.target.checked }) })),
        h('div', { className: 'dshc-sub' }, v.push ? '开着：它判断该开口时，会直接往你最近的会话里发一条。' : '关着：它只把话存着，等你下次说话时自然提起。'),
        h('div', { style: { marginTop: 10 } }, h(Btn, { primary: true, onClick: save }, '保存')),
        msg ? h('div', { className: 'dshc-note' }, msg) : null,
        h('div', { className: 'dshc-note' }, '它还要算一笔账：想说话的劲头（缺口 + 手头真事 + 隔了多久）压过打扰你的成本（最近发得多不多、你上回接没接）才会开口。半夜只回话。技术视图里能看到上一次判断过了哪几道门、收益和成本各多少。'))
    }
    function LearningCard({ aid, act }) {
      const [s, reload] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/learning'), [aid])
      const [f, setF] = useState(null)
      const [msg, setMsg] = useState('')
      const v = f || s.data || { c4Auto: true, personaLearn: true, cooldownRounds: 6 }
      async function save() {
        const r = await act(() => call('PUT', '/v1/agents/' + enc(aid) + '/learning', v, true))
        setMsg('已保存：C4 ' + (r.c4Auto ? '自动执行' : '需批准') + ' · 鱼格 ' + (r.personaLearn ? '自动学习' : '冻结') + ' · 冷却 ' + r.cooldownRounds + ' 轮')
        setF(null); reload()
      }
      return h(Card, null,
        h(Row, { label: 'C4 变更自动执行' }, h('input', { type: 'checkbox', checked: !!v.c4Auto, onChange: (e) => setF({ ...v, c4Auto: e.target.checked }) })),
        h(Row, { label: '鱼格自动学习' }, h('input', { type: 'checkbox', checked: !!v.personaLearn, onChange: (e) => setF({ ...v, personaLearn: e.target.checked }) })),
        h(Row, { label: '冷却轮数' }, h(Input, { style: { width: 72 }, value: v.cooldownRounds, onChange: (e) => setF({ ...v, cooldownRounds: Number(e.target.value) || 0 }) }), h('span', { className: 'dshc-sub' }, ' 轮')),
        h('div', { style: { marginTop: 10 } }, h(Btn, { primary: true, onClick: save }, '保存')),
        msg ? h('div', { className: 'dshc-note' }, msg) : null,
        h('div', { className: 'dshc-note' }, '默认：C4 自动执行开、鱼格学习开、冷却 6 轮。长期不互动时鱼格会缓慢回到基线。'))
    }

    /** 璁板繂璁剧疆锛氳“鍑忛€熷害 / 閬楀繕闃堝€?/ 鑷姩璁板繂寮€鍏?/ 姣忚疆娉ㄥ叆棰勭畻锛堥兘钀?agent_params锛孋4 鐩存敼鐣欑棔锛?*/
