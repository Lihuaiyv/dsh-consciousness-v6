    const SELF_NOTE = {
      shrink: '往中间收窄一点',
      praise: '被夸了一句',
      '被夸': '被夸了一句',
      '14 天没有共同活动': '很久没一起做事了',
    }
    const SELF_STATE = {
      draft: ['草稿', 'warn'],
      promoted: ['已提交', 'warn'],
      shadowed: ['跑影子', 'warn'],
      screened: ['等你批', 'warn'],
      pending_human: ['等你批', 'warn'],
      committed: ['已生效', 'ok'],
      settled: ['已定案', 'ok'],
      rolled_back: ['已回滚', 'bad'],
      rejected: ['被拒', 'bad'],
      aborted: ['已中止', 'bad'],
      expired: ['已过期', undefined],
    }
    const noteText = (s) => SELF_NOTE[s] || String(s || '')
    const isIsoTime = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s)

    function fieldHuman(f) {
      const k = String(f || '')
      if (SELF_FIELD[k]) return SELF_FIELD[k]
      if (k.startsWith('relations.')) return '对「' + k.slice(10) + '」的关系'
      if (k.startsWith('token.')) return k.slice(6).toUpperCase() + ' 令牌'
      if (k.startsWith('persona.big5.')) return '性格 · ' + k.slice(13)
      return k || '—'
    }

    function num3(v) {
      if (v == null || v === '') return '—'
      const n = Number(v)
      return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : String(v)
    }

    /** 值压成一行：去掉 JSON 引号，太长就截断 */
    function valText(v) {
      if (v == null) return '—'
      let s = String(v)
      s = s.replace(/^"|"$/g, '')
      if (s.length > 26) s = s.slice(0, 24) + '…'
      return s
    }

    function shortVal(v) {
      if (v == null) return '—'
      const s = String(v)
      return s.length > 46 ? s.slice(0, 44) + '…' : s
    }

    function agoText(iso) {
      if (!iso) return '—'
      const t = Date.parse(iso)
      if (!Number.isFinite(t)) return String(iso).slice(0, 16).replace('T', ' ')
      const m = Math.max(0, Math.round((Date.now() - t) / 60000))
      if (m < 1) return '刚刚'
      if (m < 60) return m + ' 分钟前'
      if (m < 1440) return Math.round(m / 60) + ' 小时前'
      return Math.round(m / 1440) + ' 天前'
    }

    function dayText(iso) {
      return iso ? String(iso).slice(0, 10) : '—'
    }

    function parseRelValue(raw) {
      try {
        const o = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (!o || typeof o !== 'object') return null
        return { closeness: o.closeness, trust: o.trust, why: o.why || '' }
      } catch { return null }
    }

    function changePreview(c) {
      const before = parseRelValue(c.before)
      if (String(c.field || '').startsWith('relations.') && before) {
        const after = parseRelValue(c.after) || {}
        const dc = Number(after.closeness) - Number(before.closeness)
        const dt = Number(after.trust) - Number(before.trust)
        return '亲近 ' + num3(before.closeness) + ' → ' + num3(after.closeness) +
          '（' + (dc >= 0 ? '+' : '') + num3(dc) + '）· 信任 ' +
          num3(before.trust) + ' →' + num3(after.trust) +
          '（' + (dt >= 0 ? '+' : '') + num3(dt) + '）'
      }
      return shortVal(c.before) + ' →' + shortVal(c.after)
    }

    /** 鑷姩鍙樻洿鎸夈€屾敼浜嗗悓涓€绫讳笢瑗裤€嶅綊鍫嗭細鍏崇郴銆佹€ф牸銆佹竻鐞嗐€佸叾瀹?*/
    function autoGroups(list) {
      const map = new Map()
      for (const c of list) {
        const f = String(c.field || '')
        let kind = 'other'
        let name = ''
        if (f.startsWith('relations.')) { kind = 'relation'; name = f.slice(10) }
        else if (f.startsWith('persona.')) kind = 'persona'
        else if (f.startsWith('memory.cleanup')) kind = 'cleanup'
        const key = kind + ':' + (name || f)
        const g = map.get(key) || { key, kind, name, field: f, items: [] }
        g.items.push(c)
        map.set(key, g)
      }
      const arr = [...map.values()]
      arr.forEach((g) => g.items.sort((a, b) => String(b.applied_at || '').localeCompare(String(a.applied_at || ''))))
      arr.sort((a, b) => String((b.items[0] || {}).applied_at || '').localeCompare(String((a.items[0] || {}).applied_at || '')))
      return arr
    }

    function autoGroupText(g) {
      const items = g.items || []
      if (!items.length) return ''
      const last = items[0]
      const firstItem = items[items.length - 1]
      if (g.kind === 'relation') {
        const a = parseRelValue(firstItem.before) || {}
        const b = parseRelValue(last.after) || {}
        const dc = Number(b.closeness) - Number(a.closeness)
        const dt = Number(b.trust) - Number(a.trust)
        const move = (dc > 0 || dt > 0) ? '往前挪' : '往后退'
        return '和「' + g.name + '」的关系' + move + '了 ' + items.length + ' 次'
      }
      if (g.kind === 'persona') {
        return '「' + fieldHuman(g.field) + '」挪了一点（' + items.length + ' 次）'
      }
      if (g.kind === 'cleanup') {
        return '清掉一批运行时噪声（' + items.length + ' 次）'
      }
      return fieldHuman(g.field) + ' 改了 ' + items.length + ' 次'
    }

    function selfClassNote(cls) {
      const c = SELF_CLASS[cls]
      return c ? c[0] + ' · ' + c[1] : '等级未知'
    }

    function stateMeta(p) {
      const m = SELF_STATE[p.state]
      return m || [String(p.state || '—'), undefined]
    }

    function proposalWhere(p) {
      const done = Number(p.shadow_done || 0)
      const total = Number(p.shadow_total || 0)
      if (p.state === 'draft') return '还只是草稿，没提交'
      if (p.state === 'shadowed') {
        if (!total) return '等你点头'
        return done >= total
          ? '影子跑满 ' + total + ' 轮了，现在就等你点头'
          : '影子跑了 ' + done + '/' + total + ' 轮 · 再跑 ' + (total - done) + ' 轮才给「批准」'
      }
      if (p.state === 'screened' || p.state === 'pending_human') return '七道闸都过了，等你点头'
      if (p.state === 'committed') return '已经生效' + (p.observing_until ? '，观察期到 ' + dayText(p.observing_until) : '')
      if (p.state === 'settled') return '观察期结束，定下来了'
      if (p.state === 'rolled_back') return '已经回滚'
      if (p.state === 'rejected') return '被拒绝了'
      if (p.state === 'aborted') return '影子中途停了（护栏指标变差）'
      if (p.state === 'expired') return '放着过期了'
      return String(p.state || '—')
    }

    /** 涓€鍙ヨ瘽璇存竻鏀逛粈涔堬細鎶?A 浠庢棫鍊兼崲鎴愭柊鍊?*/
    function proposalHeadline(p) {
      return '把「' + fieldHuman(p.field || p.target) + '」从 ' + valText(p.before) + ' 换成 ' + valText(p.after)
    }

    /** 涓€鍙ヨ瘽璇存竻涓轰粈涔?*/
    function proposalWhyLine(p) {
      const ev = proposalEvidence(p)
      if (ev && (ev.samples || ev.title)) {
        return '它攒到 ' + (ev.samples || 1) + ' 条不对劲的样本，觉得这一项该动一动了。'
      }
      if (p.change_class === 'C4') return '这一项够小，过了闸它就能自己动手。'
      return '缺口到了 ' + (p.deficit || '?') + '，它觉得这一项一直不太够用。'
    }

    /** 鑽夋鎶婅瘉鎹瓨鍦?gate_trace 閲岋紱姝ｅ紡鎻愭鐨?gate_trace 鏄椄缁撴灉锛屾病鏈夎瘉鎹鏂?*/
    function proposalEvidence(p) {
      let arr = []
      try { arr = JSON.parse(p.gate_trace || '[]') } catch { arr = [] }
      if (!Array.isArray(arr) || !arr.length) return null
      const ev = arr[0]
      if (!ev || ev.gate) return null
      if (!ev.samples && !(ev.texts && ev.texts.length) && !ev.title) return null
      return ev
    }

    function proposalRefPill(c) {
      return c.source === 'manual' ? '你改的'
        : c.source === 'system' || c.source === 'auto' ? '它自己改的'
          : String(c.source || '—')
    }

    function groupByDay(list) {
      const map = new Map()
      for (const c of list) {
        const day = dayText(c.applied_at)
        if (!map.has(day)) map.set(day, [])
        map.get(day).push(c)
      }
      return [...map.entries()]
    }

    function SelfProposalCard({ p, run, act, shadowAll, tick }) {
      const done = Number(p.shadow_done || 0)
      const total = Number(p.shadow_total || 0)
      const ready = p.state === 'shadowed' && total > 0 && done >= total
      const ev = proposalEvidence(p)
      const canReject = ['shadowed', 'screened', 'pending_human'].includes(p.state)
      const meta = stateMeta(p)
      const shortWhere = total
        ? '影子 ' + done + '/' + total + (ready ? ' · 跑满了' : ' · 再跑 ' + (total - done) + ' 轮')
        : meta[0]
      const buttons = []
      if (total && !ready) {
        buttons.push(h(Btn, { key: 'one', onClick: () => run(() => act(() => call('POST', '/v1/proposals/' + enc(p.id) + '/shadow', {}, true))) }, '跑一轮'))
        buttons.push(h(Btn, { key: 'all', onClick: () => shadowAll(p) }, '跑满'))
      }
      if (ready) {
        buttons.push(h(Btn, {
          key: 'ok', primary: true,
          onClick: () => run(() => act(() => call('POST', '/v1/proposals/' + enc(p.id) + '/approve', {}, true))),
        }, '批准'))
      }
      if (canReject) {
        buttons.push(h(Btn, {
          key: 'no', ghost: true, danger: true,
          onClick: () => {
            const reason = window.prompt('拒绝原因（必填）', '证据不足')
            if (reason) run(() => act(() => call('POST', '/v1/proposals/' + enc(p.id) + '/reject', { reason }, true)))
          },
        }, '拒绝'))
      }
      return h('div', { className: 'dshc-item dshc-prop', style: { flexDirection: 'column', alignItems: 'stretch', gap: 6 } },
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
          h(Pill, { tone: meta[1] }, meta[0]),
          h(Pill, { on: true, title: selfClassNote(p.change_class) }, (p.change_class || '?') + ' · ' + (SELF_CLASS[p.change_class] || ['?'])[0]),
          h('span', { className: 'dshc-spacer' }),
          h('span', { className: 'dshc-sub dshc-mono' }, agoText(p.created_at))),
        h('div', { style: { fontSize: 14.5, fontWeight: 600, lineHeight: 1.5 } }, proposalHeadline(p)),
        h('div', { className: 'dshc-sub dshc-mono' }, shortWhere),
        total ? h(Bar, { value: done / total }) : null,
        buttons.length ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } }, buttons) : null,
        h('details', null,
          h('summary', { style: { cursor: 'pointer', color: 'var(--muted)' } }, '依据、影响、回滚'),
          h('div', { style: { marginTop: 8 } },
            h('div', { className: 'dshc-sub' }, proposalWhyLine(p)),
            h(Row, { label: '进度' }, h('span', { className: 'm', style: { whiteSpace: 'normal' } }, proposalWhere(p))),
            h(Row, { label: '改前 → 改后' }, h('span', { className: 'm dshc-mono', style: { textAlign: 'right', whiteSpace: 'normal' } }, changePreview(p))),
            h(Row, { label: '改动等级' }, h('span', { className: 'm' }, (p.change_class || '?') + ' · 当时缺口 ' + (p.deficit || '—'))),
            h('div', { className: 'dshc-sub', style: { marginTop: 2 } }, selfClassNote(p.change_class)),
            ev ? h('div', { style: { marginTop: 8 } },
              h('div', { className: 'dshc-sub' }, '它的依据（' + (ev.samples || (ev.texts || []).length || 1) + ' 条' + (ev.source ? ' · ' + ev.source : '') + '）'),
              (ev.texts || []).slice(0, 5).map((t, i) => h('div', {
                key: i, className: 'dshc-item', style: { marginTop: 4, alignItems: 'flex-start' },
              }, h('span', { className: 'm' }, '「' + String(t).slice(0, 80) + '」')))) : null,
            h(Row, { label: '它自己怎么想的' }, h('span', { className: 'm', style: { textAlign: 'right', whiteSpace: 'normal' } },
              p.change_class === 'C4'
                ? '过闸就能自己做；做完留一条记录，改坏了能写回旧值。'
                : '它觉得这一项一直不太够用：证据不够闸会直接拦，不会硬来。')),
            h(Row, { label: '风险' }, h('span', { className: 'm', style: { whiteSpace: 'normal' } }, p.risk || '—')),
            h(Row, { label: '怎么回滚' }, h('span', { className: 'm', style: { whiteSpace: 'normal' } }, p.rollback_plan || '—')),
            done > 0 ? h(ShadowReport, { proposalId: p.id, tick }) : null)))
    }
    function SelfFinishedRow({ p }) {
      const meta = stateMeta(p)
      return h('div', { className: 'dshc-tl-item', 'data-tone': meta[1] === 'ok' ? 'ok' : meta[1] === 'bad' ? 'bad' : undefined },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
          h(Pill, { tone: meta[1] }, meta[0]),
          h('span', { className: 't' }, fieldHuman(p.field || p.target)),
          h('span', { className: 'dshc-spacer' }),
          h('span', { className: 'm dshc-mono' }, dayText(p.created_at))),
        h('div', { className: 'dshc-sub' }, proposalWhere(p) + ' · ' + changePreview(p)))
    }

    function SelfAutoGroup({ g }) {
      const items = g.items || []
      const last = items[0] || {}
      const rel = g.kind === 'relation' ? parseRelValue(last.before) : null
      const why = (rel && rel.why) || ''
      const a = g.kind === 'relation' ? (parseRelValue(items[items.length - 1] && items[items.length - 1].before) || {}) : {}
      const b = g.kind === 'relation' ? (parseRelValue(last.after) || {}) : {}
      const movedUp = g.kind === 'relation' ? (Number(b.trust) >= Number(a.trust)) : true
      const noted = last.note || (last.rolled_back_at && !isIsoTime(last.rolled_back_at) ? last.rolled_back_at : '')
      const reason = g.kind === 'relation'
        ? (movedUp
          ? '这句话里有「好 / 喜欢 / 谢谢」这类正面词，规则就往近处挪：亲近 +0.01、信任 +0.005（亲近封顶 0.99）。反过来是 −0.005 / −0.01。'
          : '这句话里有「烦 / 错 / 不好」这类负面词，规则就往后退：亲近 −0.005、信任 −0.01。')
        : g.kind === 'persona'
          ? '性格只从经历里慢慢漂：一次最多 0.05，同一根轴 6 轮内只动一次；这次是怎么挪的，下面逐条列着。'
          : '这类清理只动运行时留下的临时记录，不碰你的记忆正文。'
      return h('div', { className: 'dshc-item', style: { flexDirection: 'column', alignItems: 'stretch', gap: 3 } },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
          h('div', { className: 't', style: { flex: 1 } }, autoGroupText(g)),
          h('span', { className: 'dshc-sub dshc-mono' }, '×' + items.length)),
        h('details', null,
          h('summary', { style: { cursor: 'pointer', color: 'var(--muted)' } }, '依据和它是怎么算的'),
          h('div', { style: { marginTop: 6 } },
            h(Row, { label: '对象' }, h('span', { className: 'm' }, fieldHuman(g.field))),
            h(Row, { label: '最近一次' }, h('span', { className: 'm' }, agoText(last.applied_at) + ' · 等级 C4 自动执行')),
            why ? h(Row, { label: '因为这句话' }, h('span', { className: 'm', style: { textAlign: 'right', whiteSpace: 'normal' } }, '「' + why + '」')) : null,
            noted ? h(Row, { label: '它标的原因' }, h('span', { className: 'm' }, noteText(noted))) : null,
            g.kind === 'relation' && a && b && a.closeness != null
              ? h(Row, { label: '整体变化' }, h('span', { className: 'm dshc-mono', style: { textAlign: 'right', whiteSpace: 'normal' } },
                '亲近 ' + num3(a.closeness) + ' → ' + num3(b.closeness) + ' · 信任 ' + num3(a.trust) + ' → ' + num3(b.trust)))
              : null,
            h('div', { className: 'dshc-sub', style: { marginTop: 4 } }, reason),
            h('div', { className: 'dshc-sub', style: { marginTop: 6 } }, '最近几次：'),
            items.slice(0, 5).map((c) => h('div', {
              key: c.id, style: { display: 'flex', gap: 8, alignItems: 'baseline', marginTop: 3, flexWrap: 'wrap' },
            },
            h('span', { className: 'dshc-mono dshc-sub', style: { minWidth: 88 } }, dayText(c.applied_at) + ' ' + String(c.applied_at || '').slice(11, 16)),
            h('span', { className: 'm dshc-mono', style: { flex: 1, whiteSpace: 'normal' } }, changePreview(c)))))))
    }
    function SelfIdeaRow({ t, draftsList }) {
      const prog = Number(t.progress || 0)
      const th = Math.max(1, Number(t.threshold || 1))
      const draftFor = (draftsList || []).find((d) => d.target === t.id)
      let stage
      if (draftFor) stage = '已起草'
      else if (prog >= th) stage = '够了，等起草'
      else if (t.lastDraftAt) {
        const cool = Date.parse(t.lastDraftAt) + Number(t.cooldownDays || 30) * 86400000
        stage = cool > Date.now() ? '冷却到 ' + dayText(new Date(cool).toISOString()) : '冷却完了'
      } else stage = '还差 ' + (th - prog) + ' 条证据'
      return h('div', { className: 'dshc-item', style: { flexDirection: 'column', alignItems: 'stretch', gap: 4 } },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
          h('div', { className: 't', style: { flex: 1 } }, t.label),
          h('span', { className: 'dshc-sub dshc-mono' }, Math.min(prog, th) + '/' + th)),
        h(Bar, { value: prog / th }),
        h('div', { className: 'dshc-sub' }, stage + ' · ' + t.windowDays + ' 天'),
        h('details', null,
          h('summary', { style: { cursor: 'pointer', color: 'var(--muted)' } }, '门槛和等级'),
          h('div', { style: { marginTop: 6 } },
            h(Row, { label: '门槛' }, h('span', { className: 'm' }, Number(prog) + ' / ' + Number(th) + ' 条（近 ' + t.windowDays + ' 天）')),
            h(Row, { label: '改动等级' }, h('span', { className: 'm' }, t.class + ' · ' + (SELF_CLASS[t.class] || ['?'])[0])),
            t.lastDraftAt ? h(Row, { label: '上次起草' }, h('span', { className: 'm' }, agoText(t.lastDraftAt))) : null,
            h('div', { className: 'dshc-sub', style: { marginTop: 4 } }, stage + '；到线后它自己起草，草案要先提交进影子。'))))
    }
    function SelfChangeRow({ c, run, act }) {
      const rolled = c.rolled_back_at && isIsoTime(c.rolled_back_at)
      return h('div', { className: 'dshc-tl-item' },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
          h('span', { className: 't' }, fieldHuman(c.field)),
          h('span', { className: 'dshc-spacer' }),
          rolled
            ? h(Pill, { tone: 'bad' }, '已回滚')
            : h(Btn, { sm: true, onClick: () => run(() => act(() => call('POST', '/v1/changes/' + enc(c.id) + '/rollback', {}, true))) }, '回滚')),
        h('div', { className: 'dshc-sub dshc-mono', style: { whiteSpace: 'normal' } }, changePreview(c)))
    }

    function authorFieldName(f) {
      const k = String(f || '').replace(/^persona\./, '')
      if (k === 'style.tone') return '语气'
      if (k === 'style.catchphrase') return '口头禅'
      if (k.startsWith('interest.')) return '兴趣 · ' + k.slice(9)
      return fieldHuman(k)
    }
    function authorVal(v) {
      try { const x = JSON.parse(v); return x == null ? '—' : String(x) } catch { return shortVal(v) }
    }
    function AuthorRow({ c, aid, run, act }) {
      const rolled = c.rolled_back_at && isIsoTime(c.rolled_back_at)
      return h('div', { className: 'dshc-tl-item' },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
          h('span', { className: 't' }, authorFieldName(c.field)),
          h('span', { className: 'dshc-spacer' }),
          rolled
            ? h(Pill, { tone: 'bad' }, '已回滚')
            : h(Btn, {
              sm: true,
              onClick: () => run(() => act(() => call('POST', '/v1/agents/' + enc(aid) + '/author/rollback', { change_id: c.id }, true))),
            }, '回滚')),
        h('div', { className: 'dshc-sub dshc-mono', style: { whiteSpace: 'normal' } },
          authorVal(c.before) + ' →' + authorVal(c.after)
          + (c.observing_until && !rolled ? ' · 观察到 ' + String(c.observing_until).slice(5, 10) : '')),
        h('div', { className: 'dshc-sub', style: { opacity: .72 } }, agoText(c.applied_at)))
    }

    /* ---------------- 零件盒：零件册在界面上的落点（自修改页最上面） ---------------- */

    /** 一个零件现在能不能换：在册 + 考卷 + 回退点，缺一就标黄；独立性界桩另由全仓检查 */
    function partState(p) {
      if (p && p.status === '已退役') return ['已退役', undefined]
      const hasExam = !!(p && p.exam && p.exam.file)
      const hasRollback = !!(p && p.rollback && p.rollback.pointer)
      if (!hasExam) return ['在用 · 没考卷', 'warn']
      if (!hasRollback) return ['有考卷 · 没回退点', 'warn']
      const score = p.exam.score
      return ['可换' + (score != null ? ' · 最近 ' + score : ''), 'ok']
    }

    function partsSearch(p, kw) {
      if (!kw) return true
      const hay = [p.id, p.name, p.owner, p.role, p.chain, p.judge]
        .concat(p.files || []).join(' ').toLowerCase()
      return hay.indexOf(kw) >= 0
    }

    function PartRow({ p, open, onToggle }) {
      const [state, tone] = partState(p)
      const tags = [p.role ? '角色 · ' + p.role : null, p.chain || null, p.judge ? '判准 · ' + p.judge : null]
        .filter(Boolean).join(' ｜ ')
      // 窄屏也别冲破：长文本一律允许换行，flex 子项允许收缩
      const wrap = { minWidth: 0, whiteSpace: 'normal', wordBreak: 'break-word', overflowWrap: 'anywhere' }
      // 扁：归属和三个标签并成一行，上下留白、行高都收窄。
      // 这些只写在这一行上（不走 .dshc-item 公共样式），别的列表还是原来的高度。
      const meta = { ...wrap, color: 'var(--muted)', fontSize: 11, lineHeight: 1.4, opacity: 0.85 }
      const metaLine = [p.owner, tags].filter(Boolean).join(' ｜ ') || '—'
      return h('div', {
        className: 'dshc-item dshc-part', 'data-open': open ? '1' : '0',
        style: { flexDirection: 'column', alignItems: 'stretch', gap: 3, padding: '5px 9px', minWidth: 0 },
      },
        h('div', {
          style: { display: 'flex', gap: '2px 10px', alignItems: 'baseline', flexWrap: 'wrap', cursor: 'pointer', lineHeight: 1.35, minWidth: 0 },
          role: 'button', tabIndex: 0, title: open ? '收起' : '点开看考卷和回退点',
          onClick: onToggle,
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } },
        },
          h('span', { className: 't', style: { flex: '1 1 140px', ...wrap } }, p.name || p.id),
          h(Pill, { tone }, state),
          h('span', { className: 'm dshc-mono', style: { flex: '0 0 auto' } }, p.version || '—')),
        h('div', { style: meta }, metaLine),
        open ? h('div', { style: { borderTop: '1px dashed var(--line)', paddingTop: 6, minWidth: 0 } },
          h(Row, { label: '文件' }, h('span', { className: 'm dshc-mono', style: wrap }, (p.files || []).join(' · ') || '—')),
          h(Row, { label: '入口' }, h('span', { className: 'm', style: wrap }, p.entry || '—')),
          h(Row, { label: '考卷' }, h('span', { className: 'm', style: wrap },
            p.exam && p.exam.file
              ? (p.exam.file + (p.exam.score != null ? ' · 最近 ' + p.exam.score : ''))
              : (p.exam && p.exam.note) || '没写考卷')),
          h(Row, { label: '迁移断言' }, h('span', { className: 'm', style: wrap }, p.assert || '还没写')),
          h(Row, { label: '换的记录' }, h('span', { className: 'm', style: wrap },
            (p.swaps && p.swaps.length)
              ? p.swaps.map((s) => [s.who || '?', s.at || '', s.from && s.to ? s.from + ' → ' + s.to : ''].filter(Boolean).join(' · ')).join('；')
              : '还没换过')),
          h(Row, { label: '回退点' }, h('span', { className: 'm', style: wrap },
            (p.rollback && p.rollback.pointer) || (p.rollback && p.rollback.note) || '还没建')))
        : null)
    }

    function PartsBox({ view }) {
      const [kw, setKw] = useState('')
      const [open, setOpen] = useState({})
      const [parts] = useAsync(() => call('GET', '/v1/parts'), [])
      const list = Array.isArray(parts.data) ? parts.data : []
      const k = kw.trim().toLowerCase()
      const shown = list.filter((p) => partsSearch(p, k))
      const rows = shown.map((p) => h(PartRow, {
        key: p.id, p, open: !!open[p.id],
        onToggle: () => setOpen((o) => ({ ...o, [p.id]: !o[p.id] })),
      }))
      return h(Sec, {
        title: '零件盒',
        desc: view === 'user'
          ? '它身上能单独拎出来换的东西。没考卷的先标黄——先考，再换。'
          : '零件册在界面上就这一块。默认一行一个零件；点开看考卷、迁移断言、换的记录、回退点。登记、考卷、回退点、独立性界桩四样齐了才叫可换。',
        right: h(Pill, null, list.length + ' 个'),
      }, h(Card, null,
        h('div', { className: 'dshc-form' },
          h(Input, {
            className: 'grow', placeholder: '搜零件：名字 / 归属 / 文件',
            value: kw, onChange: (e) => setKw(e.target.value),
          })),
        parts.error
          ? h(LoadErr, { error: '零件册读取失败：' + parts.error })
          : list.length === 0 ? h(Empty, null, '零件册里还没有登记的零件。')
            : shown.length === 0 ? h(Empty, null, '没有匹配的零件。')
              : h('div', { className: 'dshc-list', style: { marginTop: 8 } }, rows)))
    }

    function SelfPage({ aid, view, act, setTab }) {
      const [tick, setTick] = useState(0)
      const [err, setErr] = useState('')
      const [form, setForm] = useState({ cls: 'C3', field: '', before: '', after: '', evidence: '' })
      const [props] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/proposals'), [aid, tick])
      const [drafts, reloadDrafts] = useAsync(() => call('POST', '/v1/agents/' + enc(aid) + '/drafts', {}, true), [aid, tick])
      const [chs] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/changes'), [aid, tick])
      const [auth] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/author'), [aid, tick])
      const [tg] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/targets'), [aid, tick])
      const metricSlice = useMetricSlice(aid, 33, 42)
      const list = Array.isArray(props.data) ? props.data : []
      const visible = list.filter((p) => p.state !== 'draft' && p.state !== 'promoted')
      const pending = visible.filter((p) => ['shadowed', 'screened', 'pending_human'].includes(p.state))
      const finished = visible.filter((p) => !['shadowed', 'screened', 'pending_human'].includes(p.state))
      const changes = Array.isArray(chs.data) ? chs.data : []
      const authored = auth.data && Array.isArray(auth.data.rows) ? auth.data.rows : []
      const auto = changes.filter((c) => c.source === 'auto' || c.source === 'calibration')
      const manual = changes.filter((c) => c.source !== 'auto' && c.source !== 'calibration')
      const draftsList = Array.isArray(drafts.data) ? drafts.data : []
      const targets = Array.isArray(tg.data) ? tg.data : []
      const groups = autoGroups(auto)
      const nearest = targets.slice().sort((a, b) =>
        (Number(b.progress || 0) / Math.max(1, Number(b.threshold || 1))) -
        (Number(a.progress || 0) / Math.max(1, Number(a.threshold || 1))))[0] || null
      const committed = list.filter((p) => p.state === 'committed' || p.state === 'settled').length
      const readyOne = pending.find((p) => p.state === 'shadowed' && Number(p.shadow_done || 0) >= Number(p.shadow_total || 0) && Number(p.shadow_total || 0) > 0)

      const run = async (fn) => {
        setErr('')
        try { await fn(); setTick((t) => t + 1) } catch (e) { setErr(e.message) }
      }
      const create = () => run(() => act(() => call('POST', '/v1/agents/' + enc(aid) + '/proposals', {
        change_class: form.cls, target: form.field, field: form.field,
        before: form.before, after: form.after,
        evidence: form.evidence ? form.evidence.split(/[,，\s]+/).filter(Boolean) : [],
      }, true)))
      const shadowAll = (p) => run(async () => {
        for (let i = 0; i < Number(p.shadow_total || 20); i++) await act(() => call('POST', '/v1/proposals/' + enc(p.id) + '/shadow', {}, true))
      })

      const heroLine = pending.length
        ? (readyOne ? '「' + fieldHuman(readyOne.field || readyOne.target) + '」影子跑满，点「批准」就生效。' : '还在跑影子。')
        : (nearest
          ? '最近：「' + nearest.label + '」' + Number(nearest.progress || 0) + '/' + Number(nearest.threshold || 0) + ' 条。'
          : '还没开始观察。')

      const kpi = (k, n) => h('div', { key: k, className: 'dshc-sum-kpi' },
        h('b', null, String(n)),
        h('span', null, k))

      const inboxHead = h('div', { className: 'dshc-sum dshc-sum--plain', 'data-wait': pending.length ? '1' : '0' },
        h('div', { className: 'dshc-sum-main' },
          h('div', { className: 'dshc-sum-k' }, pending.length ? '有 ' + pending.length + ' 件等你点头' : '现在没有要你点头的事'),
          h('div', { className: 'dshc-sum-s' }, heroLine)),
        h('div', { className: 'dshc-sum-kpis' },
          kpi('等你批', pending.length),
          kpi('影子中', pending.filter((p) => p.state === 'shadowed').length),
          kpi('已生效', committed)))

      const pendingNodes = pending.map((p) => h(SelfProposalCard, { key: p.id, p, run, act, shadowAll, tick }))
      const finishedNodes = finished.slice(0, 8).map((p) => h(SelfFinishedRow, { key: p.id, p }))
      const groupNodes = groups.slice(0, 6).map((g) => h(SelfAutoGroup, { key: g.key, g }))
      const ideaNodes = targets.map((t) => h(SelfIdeaRow, { key: t.id, t, draftsList }))
      const draftNodes = draftsList.map((d) => h(DraftRow, { key: d.id, d, aid, act, onDone: () => setTick((t) => t + 1) }))

      const inboxIntro = h('div', { className: 'dshc-sub', style: { textAlign: 'center', padding: '10px 0' } }, '收件箱是空的。')

      const pendingBody = props.error
        ? h(LoadErr, { error: '提案读取失败：' + props.error, retry: () => setTick((t) => t + 1) })
        : pending.length === 0
          ? inboxIntro
          : h('div', { className: 'dshc-list' }, pendingNodes)

      const finishedBlock = finished.length
        ? h('details', { style: { marginTop: 10 } },
          h('summary', { style: { cursor: 'pointer', color: 'var(--muted)' } }, '已经走完的提案 ' + finished.length + ' 条'),
          h('div', { className: 'dshc-tl', style: { marginTop: 6 } }, finishedNodes))
        : null

      const proposalSection = h(Sec, {
        title: '收件箱',
        desc: view === 'user'
          ? 'C4 自动调值，留痕可回滚。'
          : '来源 auto / calibration；不进收件区，不占每天 1 次的变更名额。',
      }, h(Card, null, inboxHead, h('div', { className: 'dshc-inbox-box' }, pendingBody), finishedBlock))

      const autoSection = h(Sec, {
        title: view === 'user' ? '它攒了多少想法' : '想法与门槛（targets / drafts）',
        desc: view === 'user'
          ? '攒够证据才会起草。'
          : 'progress = 目标信号在窗口内的条数；threshold 到线才由 maybeDraft 起草；冷却内不重复。',
        right: h(Pill, null, auto.length + ' 次'),
      }, h(Card, null,
        chs.error ? h(LoadErr, { error: '变更读取失败：' + chs.error, retry: () => setTick((t) => t + 1) })
          : groups.length === 0 ? h(Empty, null, '它还没顺手改过什么。')
            : h('div', { className: 'dshc-list' }, groupNodes)))

      const ideaList = tg.error
        ? h(LoadErr, { error: '想法读取失败：' + tg.error, retry: () => setTick((t) => t + 1) })
        : targets.length === 0 ? h('div', { className: 'dshc-sub' }, '还没有可以改自己的方向。')
          : h('div', { className: 'dshc-list' }, ideaNodes)

      const draftsBlock = h('div', { style: { marginTop: 6 } },
        drafts.error ? h(LoadErr, { error: '草案读取失败：' + drafts.error, retry: () => reloadDrafts() })
          : draftsList.length === 0 ? h(Empty, null, '现在还没有草案。')
            : h('div', { className: 'dshc-list' }, draftNodes))

      const ideasSection = h(Sec, {
        title: view === 'user' ? '它现在用的是哪个版本' : '算法版本与灰度',
        desc: view === 'user'
              ? '这是它读完你刚才那句话，觉得你此刻的情绪。猜错了就点「不对」：它会把你说的事实记下来，下一次先按这个读。'
              : '模型 user_scores 的读数（按你的反馈校准后）。点「不对」写下实际情绪，会进 8×8 混淆矩阵，下一轮共情直接用。',
        right: h(Pill, null, '观察中 ' + targets.length),
      }, h(Card, null,
        ideaList,
        draftsBlock,
        h('details', { style: { marginTop: 8 } },
          h('summary', { style: { cursor: 'pointer', color: 'var(--muted)' } }, '等级怎么分'),
          h('div', { className: 'dshc-sub', style: { marginTop: 4 } },
            'C1 结构（影子 40 轮）· C2 分类 / C3 规则（影子 20 轮）· C4 数值（它自己能做）。草案要先提交进影子，才会出现在「等你点头」。'))))

      const manualDays = groupByDay(manual.slice(0, 12)).map(([day, items]) => h('div', { key: day },
        h('div', { className: 'dshc-day' }, day + ' · ' + items.length + ' 条'),
        h('div', { className: 'dshc-tl' }, items.map((c) => h(SelfChangeRow, { key: c.id, c, run, act })))))

      const manualMore = manual.length > 12
        ? h('details', { style: { marginTop: 8 } },
          h('summary', { style: { cursor: 'pointer', color: 'var(--muted)' } }, '看全部 ' + manual.length + ' 条'),
          h('div', { className: 'dshc-list', style: { marginTop: 6 } },
            manual.slice(12).map((c) => h('div', { key: c.id, className: 'dshc-item' },
              h('span', { className: 'm dshc-mono' }, dayText(c.applied_at)),
              h('span', { className: 't' }, fieldHuman(c.field)),
              h('span', { className: 'm dshc-mono' }, shortVal(c.before) + ' →' + shortVal(c.after))))))
        : null

      const autoMore = auto.length
        ? h('details', { style: { marginTop: 8 } },
          h('summary', { style: { cursor: 'pointer', color: 'var(--muted)' } }, '它自己改的 ' + auto.length + ' 条原始记录'),
          h('div', { className: 'dshc-list', style: { marginTop: 6 } },
            auto.slice(0, 20).map((c) => h('div', { key: c.id, className: 'dshc-item' },
              h('span', { className: 'm dshc-mono' }, dayText(c.applied_at)),
              h('span', { className: 't' }, fieldHuman(c.field)),
              h('span', { className: 'm dshc-mono', style: { maxWidth: 220, whiteSpace: 'normal', textAlign: 'right' } }, changePreview(c))))))
        : null

      const changesBody = chs.error
        ? h(LoadErr, { error: '变更读取失败：' + chs.error, retry: () => setTick((t) => t + 1) })
        : [
          h('div', { key: 'sum', className: 'dshc-sub', style: { marginBottom: 8 } },
            '你亲手改过 ' + manual.length + ' 次 · 它自己顺手改过 ' + auto.length + ' 次（在上面「顺手改的小事」里按类归堆）。'),
          manual.length === 0
            ? h(Empty, { key: 'empty' }, '你还没亲手改过什么。')
            : h('div', { key: 'list' }, manualDays),
          h('div', { key: 'more' }, manualMore, autoMore),
          h('div', { key: 'note', className: 'dshc-sub', style: { marginTop: 8 } }, '回滚 = 把这一条字段写回改前的值；回滚后再改要等冷却。'),
        ]

      const changesSection = h(Sec, {
        title: '变更记录',
        desc: view === 'user'
          ? '改前改后都留着，可单字段回滚。'
          : 'changes 表按 applied_at 倒序；manual 走人工，auto 由系统写。',
        right: h(Pill, null, '共 ' + changes.length + ' 条'),
      }, h(Card, null, changesBody))

      const authorSection = h(Sec, {
        title: '她自己改的',
        desc: view === 'user'
          ? '她只改语气、口头禅、兴趣；每天最多一条，7 天观察，随时可回滚。'
          : 'P 通道：白名单 persona.style.tone / style.catchphrase / interest.*；source=self-authorship；不进 C1–C3 影子。',
        right: h(Pill, null, '近 30 天 ' + authored.length + ' 条'),
      }, h(Card, null,
        auth.error ? h(LoadErr, { error: '读取失败：' + auth.error, retry: () => setTick((t) => t + 1) })
          : authored.length === 0 ? h(Empty, null, '最近 30 天她没有改过自己的样子。')
            : h('div', { className: 'dshc-tl' }, authored.map((c) => h(AuthorRow, { key: c.id, c, aid, run, act })))))

      const gatesSection = h(Sec, { techOnly: true, title: '七道闸（G1–G7）', desc: '顺序固定；第一个 block 之后其余记 skipped。' },
        h(Card, null, GATES.map(([g, name, code]) => h(Row, { key: g, label: g + ' ' + name }, h(Pill, null, code)))))

      const metricsSection = h(Sec, { techOnly: true, title: '验收指标（9 条 · 地基附录 E）' },
        h(Card, null, h(MetricList, {
          from: 33, to: 42, view, setTab,
          catalog: metricSlice.catalog, values: metricSlice.values,
        })))

      const manualSection = h(Sec, { techOnly: true, title: '手动发起（一般不用）', desc: '正常流程是它自己从缺口起草、你只负责批；这里留给你手写特殊变更。C0 连提案都不收。' },
        h(Card, null,
          h('div', { className: 'dshc-form' },
            h('select', {
              className: 'dshc-sel', style: { width: 76 }, value: form.cls,
              onChange: (e) => setForm({ ...form, cls: e.target.value }),
            }, ['C2', 'C3'].map((k) => h('option', { key: k, value: k }, k))),
            h(Input, {
              className: 'grow', placeholder: '改什么（field）', value: form.field,
              onChange: (e) => setForm({ ...form, field: e.target.value }),
            })),
          h('div', { className: 'dshc-form', style: { marginTop: 8 } },
            h(Input, { className: 'grow', placeholder: '改前（before）', value: form.before, onChange: (e) => setForm({ ...form, before: e.target.value }) }),
            h(Input, { className: 'grow', placeholder: '改后（after）', value: form.after, onChange: (e) => setForm({ ...form, after: e.target.value }) })),
          h('div', { className: 'dshc-form', style: { marginTop: 8 } },
            h(Input, {
              className: 'grow', placeholder: '证据（逗号分隔；G5 没有证据直接退）', value: form.evidence,
              onChange: (e) => setForm({ ...form, evidence: e.target.value }),
            }),
            h(Btn, { primary: true, onClick: create }, '提交提案')),
          err ? h('div', { className: 'dshc-err' }, err) : null,
          h('div', { className: 'dshc-note' }, 'C3 进影子（20 轮），C2 直接 screened；G7 永远 pending，只能由你点。')))

      return h('div', null,
        h(PartsBox, { view }),
        proposalSection,
        autoSection,
        authorSection,
        ideasSection,
        changesSection,
        gatesSection,
        metricsSection,
        h(AlgoBindingsPanel, { aid, act, view }),
        view === 'tech' ? h(AlgoStrip, { aid, slots: ALGO_BY_TAB.self, setTab }) : null,
        manualSection)
    }

    function ShadowReport({ proposalId, tick }) {
      const [det] = useAsync(() => call('GET', '/v1/proposals/' + enc(proposalId)), [proposalId, tick])
      let log = []
      try { log = JSON.parse((det.data && det.data.shadow_log) || '[]') } catch { log = [] }
      if (!log.length) return h('div', { className: 'dshc-sub' }, '影子日志为空。')
      const last = log.slice(-5).reverse()
      return h('div', { style: { width: '100%', marginTop: 4 } },
        h('div', { className: 'dshc-sub', style: { marginBottom: 6 } }, '影子报告（最近 ' + last.length + ' / 共 ' + log.length + ' 轮 · 新旧并排）'),
        last.map((r) => h('div', {
          key: r.round, style: {
            borderTop: '1px solid rgba(255,255,255,0.08)', padding: '8px 0', display: 'grid',
            gridTemplateColumns: '1fr 1fr', gap: 10,
          },
        },
          h('div', null,
            h('div', { className: 'dshc-sub dshc-mono' },
              '旧 · r' + r.round + (r.algo && r.algo.old ? ' · ' + r.algo.old : '')),
            h('div', { className: 'm', style: { whiteSpace: 'pre-wrap', opacity: 0.9 } }, r.old_reply || '—')),
          h('div', null,
            h('div', { className: 'dshc-sub dshc-mono' },
              '新' + (r.algo && r.algo.new ? ' · ' + r.algo.new : '')
              + (r.reply_diff ? ' · 有差' : ' · 同')
              + (r.behavior_diff ? ' · pack差' : '')),
            h('div', { className: 'm', style: { whiteSpace: 'pre-wrap', opacity: 0.9 } }, r.new_reply || '—'))),
        ))
    }

    function AlgoBindingsPanel({ aid, act, view, bare }) {
      const [tick, setTick] = useState(0)
      const [algos] = useAsync(() => call('GET', '/v1/algos'), [tick])
      const [binds] = useAsync(() => call('GET', '/v1/agents/' + enc(aid) + '/algo-bindings'), [aid, tick])
      const [slot, setSlot] = useState('recall')
      const [ratio, setRatio] = useState('0')
      const [canary, setCanary] = useState('')
      const [msg, setMsg] = useState('')
      const [err, setErr] = useState('')
      const slots = ['recall', 'decay', 'deficit', 'appraise', 'affect_dyn']
      const bind = (binds.data || []).find((b) => b.name === slot) || { active: slot === 'recall' ? 'v2' : 'v1', canary: null, ratio: 0 }
      const registered = (algos.data || []).filter((a) => a.name === slot)
      async function saveGray() {
        setErr(''); setMsg('')
        try {
          await act(() => call('PUT', '/v1/agents/' + enc(aid) + '/algo-bindings/' + slot, {
            canary: canary || null, ratio: Number(ratio) || 0,
          }, true))
          setMsg(slot + ' 灰度已保存（algo_bindings）')
          setTick((t) => t + 1)
        } catch (e) { setErr(e.message) }
      }
      const body = h(Card, null,
        h('div', { className: 'dshc-form', style: { marginBottom: 8 } },
          slots.map((s) => h(Btn, {
            key: s, primary: slot === s, onClick: () => { setSlot(s); setCanary(''); setRatio('0') },
          }, s))),
        (binds.data || []).map((b) => h(Row, { key: b.name, label: b.name + ' · active' },
          h(Pill, { on: b.name === slot }, b.active + (b.canary ? ' / canary ' + b.canary + '@' + (b.ratio || 0) : '')))),
        h(Row, { label: slot + ' · 当前' }, h(Pill, { on: true }, bind.active)),
        h('div', { className: 'dshc-sub', style: { margin: '8px 0' } }, '已登记实现：'),
        h('div', { className: 'dshc-list' },
          registered.length === 0 ? h('div', { className: 'dshc-sub' }, '没有已登记的 ' + slot + ' 实现。')
            : registered.map((a) => h('div', { key: a.name + '@' + a.version, className: 'dshc-item' },
              h(Pill, { on: a.version === bind.active }, a.version === bind.active ? 'active' : '并存'),
              h('div', { className: 't' }, a.name + '@' + a.version),
              h('div', { className: 'm dshc-mono' }, (a.metrics || []).slice(0, 3).join(' · '))))),
        h('div', { className: 'dshc-form', style: { marginTop: 10 } },
          h('span', { className: 'dshc-sub' }, 'canary'),
          h('select', { className: 'dshc-in', value: canary, onChange: (e) => setCanary(e.target.value) },
            h('option', { value: '' }, '关闭'),
            registered.map((a) => h('option', { key: a.version, value: a.version }, a.version))),
          h('span', { className: 'dshc-sub' }, 'ratio'),
          h(Input, { style: { width: 70 }, value: ratio, onChange: (e) => setRatio(e.target.value), placeholder: '0—' }),
          h(Btn, { onClick: saveGray }, '保存灰度')),
        err ? h('div', { className: 'dshc-err' }, err) : null,
        msg ? h('div', { className: 'dshc-note' }, msg) : null)
      return bare ? body : h(Sec, {
        techOnly: true,
          title: view === 'user' ? '情绪' : '主情绪（label / intensity / PAD）',
          desc: '只记过闸的那些：每一条记着触发它的那句话、它当时读到的你、它自己的情绪。哪条读错了，当场就能改。',
      }, body)
    }

    /* ============================================================ metrics */

    function BlindCard({ aid, act }) {
      const [test, setTest] = useState(null)
      const [picks, setPicks] = useState({})
      const [result, setResult] = useState(null)
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState(false)
      const [growing, setGrowing] = useState(false)

      async function start() {
        setErr(''); setResult(null); setPicks({})
        try { setTest(await act(() => call('GET', '/v1/agents/' + enc(aid) + '/blind'))) }
        catch (e) { setErr(e.message) }
      }
      async function submit() {
        setBusy(true); setErr('')
        try {
          const answers = (test.rounds || []).map((r) => ({ i: r.i, choice: picks[r.i] })).filter((x) => x.choice)
          if (answers.length < 5) throw new Error('还有 ' + (5 - answers.length) + ' 轮没选')
          const r = await act(() => call('POST', '/v1/agents/' + enc(aid) + '/blind/' + enc(test.test_id), { answers }, true))
          setResult(r); setTest(null)
        } catch (e) { setErr(e.message) } finally { setBusy(false) }
      }

      return h('div', null,
        h('div', { className: 'dshc-sub', style: { marginBottom: 8 } },
          '五轮里，每轮两个回答：一个是它本人的语气，一个是中性回复。你只凭感觉选「更像它」的那边，选完自动记进「同一性盲测」指标（目标 ≥ 0.80）。'),
        !test && !result ? h(Btn, { primary: true, onClick: start }, '开始 5 轮盲测') : null,
        test ? h('div', { className: 'dshc-list' }, (test.rounds || []).map((r, idx) => h('div', { key: r.i, className: 'dshc-item', style: { display: 'block' } },
          h('div', { style: { marginBottom: 6 } }, (idx + 1) + '. ' + r.prompt),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            ['a', 'b'].map((side) => h(Btn, {
              key: side, primary: picks[r.i] === side,
              onClick: () => setPicks({ ...picks, [r.i]: side }),
            }, side.toUpperCase() + '：' + r[side])))))) : null,
        test ? h('div', { style: { marginTop: 8 } }, h(Btn, { primary: true, disabled: busy, onClick: submit }, busy ? '提交中…' : '提交盲测')) : null,
        result ? h('div', { className: 'dshc-note' },
          '结果：' + result.hit + ' / ' + result.total + '，得分 ' + result.score + (result.pass ? '（达标）' : '（未达 0.80）')) : null,
        err ? h('div', { className: 'dshc-err' }, err) : null)
    }

