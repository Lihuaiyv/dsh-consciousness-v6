    /* ============================================================ voice talk
     * 挂在对话标题栏（和名字牌一起），不挂输入框旁那个经常不出现的槽。
     * 按住空格录音，松开转写，再写进输入框发送。
     * 回完念不念，只看设置里的「回完自动念」。
     */

    const VOICE = {
      sid: '',
      aid: '',
      actions: null,
      mic: 'ptt',
      reply: 'auto',
    }

    function voiceSessionId(props) {
      if (!props) return ''
      if (props.sessionId) return String(props.sessionId)
      if (props.session && props.session.id) return String(props.session.id)
      return ''
    }

    /** 输入框右边的槽：交出「发送」接口，顺手挂一颗小光点（就贴在输入框旁边）。 */
    function VoiceMicBridge(props) {
      const sid = voiceSessionId(props)
      if (sid) VOICE.sid = sid
      if (props && props.inputActions) VOICE.actions = props.inputActions
      const glowRef = useRef(null)
      const breathRef = useRef(null)
      useEffect(() => {
        const el = glowRef.current
        if (!el) return
        let last = 0
        let alive = true
        const poll = async () => {
          if (!alive) return
          try {
            const j = await fetch('/dsh-consciousness/voice-flash', { cache: 'no-store' }).then((r) => r.json())
            const at = Number(j && j.at) || 0
            const until = Number(j && j.until) || 0
            if (at > last) {
              last = at
              el.style.opacity = '1'
              // 先轻轻呼吸两下，告诉眼睛「我要开口了」
              for (let i = 0; i < 2; i++) {
                setTimeout(() => {
                  if (!alive) return
                  try {
                    // 跟后面的持续呼吸用同一套节奏，这样两下预告和之后的呼吸是同一个频率
                    el.animate(
                      [
                        { boxShadow: '0 0 0 3px rgba(255,255,255,.12)', transform: 'scale(1.2)' },
                        { boxShadow: '0 0 0 11px rgba(255,255,255,0)', transform: 'scale(1.9)' },
                        { boxShadow: '0 0 0 3px rgba(255,255,255,.12)', transform: 'scale(1.2)' },
                      ],
                      { duration: 1400, easing: 'ease-in-out' },
                    )
                  } catch { /* 老浏览器不支持 animate 就算了 */ }
                }, i * 1400)
              }
              // 然后一直「呼吸」着，等这句话说完才停
              const holdMs = Math.max(900, until - Date.now())
              try {
                if (breathRef.current) breathRef.current.cancel()
              } catch { /* ignore */ }
              try {
                breathRef.current = el.animate(
                  [
                    { boxShadow: '0 0 0 3px rgba(255,255,255,.12)', transform: 'scale(1.2)' },
                    { boxShadow: '0 0 0 11px rgba(255,255,255,0)', transform: 'scale(1.9)' },
                    { boxShadow: '0 0 0 3px rgba(255,255,255,.12)', transform: 'scale(1.2)' },
                  ],
                  { duration: 1400, iterations: Infinity, easing: 'ease-in-out' },
                )
              } catch { /* ignore */ }
              setTimeout(() => {
                if (!alive) return
                try { if (breathRef.current) breathRef.current.cancel() } catch { /* ignore */ }
                breathRef.current = null
                el.style.opacity = '.6'
              }, holdMs)
            }
          } catch { /* 接口还没起来就静静待着 */ }
        }
        const timer = setInterval(poll, 700)
        poll()
        return () => { alive = false; clearInterval(timer) }
      }, [])
      return h('span', {
        ref: glowRef,
        id: 'dshc-voice-glow',
        title: '我说话的时候，这里会亮',
        style: {
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: '#fff',
          opacity: 0.6,
          display: 'inline-block',
          marginRight: 8,
          flex: '0 0 auto',
          boxShadow: '0 0 0 0 rgba(255,255,255,.5)',
          transition: 'opacity .4s ease',
        },
      })
    }

    function blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => {
          const s = String(r.result || '')
          const i = s.indexOf(',')
          resolve(i >= 0 ? s.slice(i + 1) : s)
        }
        r.onerror = () => reject(new Error('读录音失败'))
        r.readAsDataURL(blob)
      })
    }

    function downsampleTo16k(input, inRate) {
      if (inRate === 16000) return new Float32Array(input)
      const ratio = inRate / 16000
      const len = Math.max(0, Math.floor(input.length / ratio))
      const out = new Float32Array(len)
      let offset = 0
      for (let i = 0; i < len; i++) {
        const next = Math.min(input.length, Math.floor((i + 1) * ratio))
        let sum = 0
        let n = 0
        for (let j = offset; j < next; j++) { sum += input[j]; n++ }
        out[i] = n ? sum / n : 0
        offset = next
      }
      return out
    }

    function pcmToWavBlob(chunks) {
      let total = 0
      for (const c of chunks) total += c.length
      const pcm = new Int16Array(total)
      let o = 0
      for (const c of chunks) {
        for (let i = 0; i < c.length; i++) {
          const s = Math.max(-1, Math.min(1, c[i]))
          pcm[o++] = s < 0 ? s * 0x8000 : s * 0x7fff
        }
      }
      const buf = new ArrayBuffer(44 + pcm.length * 2)
      const v = new DataView(buf)
      const writeStr = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)) }
      writeStr(0, 'RIFF')
      v.setUint32(4, 36 + pcm.length * 2, true)
      writeStr(8, 'WAVE')
      writeStr(12, 'fmt ')
      v.setUint32(16, 16, true)
      v.setUint16(20, 1, true)
      v.setUint16(22, 1, true)
      v.setUint32(24, 16000, true)
      v.setUint32(28, 32000, true)
      v.setUint16(32, 2, true)
      v.setUint16(34, 16, true)
      writeStr(36, 'data')
      v.setUint32(40, pcm.length * 2, true)
      new Uint8Array(buf).set(new Uint8Array(pcm.buffer), 44)
      return new Blob([buf], { type: 'audio/wav' })
    }

    function startPcmRecorder(stream) {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) throw new Error('开不了录音')
      const ctx = new Ctx()
      const source = ctx.createMediaStreamSource(stream)
      const proc = ctx.createScriptProcessor(4096, 1, 1)
      const mute = ctx.createGain()
      mute.gain.value = 0
      const chunks = []
      const rate = ctx.sampleRate || 48000
      let stopped = false
      proc.onaudioprocess = (e) => {
        if (stopped) return
        chunks.push(downsampleTo16k(e.inputBuffer.getChannelData(0), rate))
      }
      source.connect(proc)
      proc.connect(mute)
      mute.connect(ctx.destination)
      return {
        state: 'recording',
        mimeType: 'audio/wav',
        onstop: null,
        _blob: null,
        stop() {
          if (stopped) return
          stopped = true
          this.state = 'inactive'
          try { source.disconnect() } catch { /* 已断 */ }
          try { proc.disconnect() } catch { /* 已断 */ }
          try { mute.disconnect() } catch { /* 已断 */ }
          this._blob = pcmToWavBlob(chunks)
          ctx.close().catch(() => {})
          if (this.onstop) this.onstop()
        },
      }
    }

    function spaceShouldType(el) {
      if (!el || el === document.body || el === document.documentElement) return false
      const tag = String(el.tagName || '').toLowerCase()
      const editable = el.isContentEditable || tag === 'textarea' || (tag === 'input' && !/^(button|checkbox|radio|submit|file|range|color)$/i.test(el.type || 'text'))
      if (!editable) return false
      const val = String(el.value != null ? el.value : (el.textContent || ''))
      return val.trim().length > 0
    }

    function VoiceMicButton(props) {
      const sid = voiceSessionId(props)
      if (props && props.inputActions) VOICE.actions = props.inputActions
      if (sid) VOICE.sid = sid
      const [aid, setAid] = useState('')
      const [phase, setPhase] = useState('idle')
      const [hint, setHint] = useState('空格')
      const [micMode, setMicMode] = useState('ptt')
      const phaseRef = useRef('idle')
      const aidRef = useRef('')
      const micRef = useRef('ptt')
      const holdingRef = useRef(false)
      const recRef = useRef(null)
      const streamRef = useRef(null)
      const openRef = useRef(false)
      const toggleRef = useRef(null)

      useEffect(() => { phaseRef.current = phase }, [phase])
      useEffect(() => { aidRef.current = aid; VOICE.aid = aid }, [aid])
      useEffect(() => { micRef.current = micMode; VOICE.mic = micMode }, [micMode])

      // 标题栏经常被裁掉，所以再在页面底部钉一颗，保证看得见。
      useEffect(() => {
        const el = document.createElement('button')
        el.type = 'button'
        el.id = 'dshc-voice-pill'
        el.style.cssText = 'position:fixed;right:24px;bottom:96px;z-index:2147483646;border:1px solid rgba(255,255,255,.28);background:rgba(20,20,20,.92);color:#fff;border-radius:999px;padding:6px 14px;font-size:13px;cursor:pointer;display:none;'
        el.onclick = (e) => {
          e.preventDefault()
          if (micRef.current === 'open' && toggleRef.current) toggleRef.current()
        }
        document.body.appendChild(el)
        return () => { try { el.remove() } catch { /* gone */ } }
      }, [])
      useEffect(() => {
        const el = document.getElementById('dshc-voice-pill')
        if (!el) return
        el.textContent = hint || '空格'
        el.style.background = (phase === 'hold' || phase === 'open') ? '#c45c26' : 'rgba(20,20,20,.92)'
        // 这颗常驻的时候正好压在输入框上方，挡对话框。平时收起，只在正在录 / 在听 / 出错时露头。
        el.style.display = (phase === 'hold' || phase === 'open' || phase === 'busy' || phase === 'err') ? 'block' : 'none'
      }, [hint, phase])

      useEffect(() => {
        let alive = true
        if (!sid) { setHint('没挂上'); setAid(''); return }
        setHint('…')
        ;(async () => {
          try {
            const r = await call('GET', '/v1/sessions/' + enc(sid) + '/agent')
            let id = r && r.agent && r.agent.id ? String(r.agent.id) : ''
            if (!id) {
              const ping = await fetch('/dsh-consciousness/ping', { cache: 'no-store' }).then((x) => x.json()).catch(() => null)
              id = ping && ping.active_agent ? String(ping.active_agent) : ''
            }
            if (!alive) return
            if (!id) { setAid(''); setHint('没人在跑'); return }
            setAid(id)
            const cfg = await call('GET', '/v1/agents/' + enc(id) + '/action-config').catch(() => null)
            if (!alive) return
            const mode = cfg && cfg['voice.mic.mode'] === 'open' ? 'open' : 'ptt'
            setMicMode(mode)
            VOICE.reply = cfg && (cfg['voice.reply.mode'] === 'off' || cfg['voice.reply.mode'] === 'click') ? 'off' : 'auto'
            setHint(mode === 'open' ? '开麦' : '空格')
          } catch (e) {
            if (alive) { setAid(''); setHint(String(e && e.message || e).slice(0, 18) || '失败') }
          }
        })()
        return () => { alive = false }
      }, [sid])

      useEffect(() => () => { stopTracks() }, [])

      function stopTracks() {
        try {
          const rec = recRef.current
          if (rec && rec.state !== 'inactive') rec.stop()
        } catch { /* 已停 */ }
        recRef.current = null
        try {
          const s = streamRef.current
          if (s) s.getTracks().forEach((t) => { try { t.stop() } catch { /* ignore */ } })
        } catch { /* ignore */ }
        streamRef.current = null
      }

      async function ensureStream() {
        if (streamRef.current) return streamRef.current
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('开不了麦')
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
        })
        streamRef.current = stream
        return stream
      }

      function startRecorder(stream) {
        const rec = startPcmRecorder(stream)
        recRef.current = rec
        return rec
      }

      async function shipBlob(blob, mime) {
        const agentId = aidRef.current
        const sessionId = sid || VOICE.sid
        if (!agentId) throw new Error('没人在跑')
        if (!blob || blob.size < 400) throw new Error('太短')
        const b64 = await blobToBase64(blob)
        const format = /wav/i.test(mime) ? 'wav' : (/ogg/i.test(mime) ? 'ogg' : (/mp4|m4a/i.test(mime) ? 'm4a' : 'webm'))
        setPhase('busy')
        setHint('在听')
        const out = await call('POST', '/v1/agents/' + enc(agentId) + '/voice/hear', {
          audio_base64: b64, format, session_id: sessionId,
        }, true)
        const text = String(out && out.text || '').trim()
        if (!text) throw new Error('没听出')
        const actions = (props && props.inputActions) || VOICE.actions
        if (!actions || typeof actions.setDraft !== 'function' || typeof actions.submit !== 'function') {
          throw new Error('听出了：' + text.slice(0, 12) + '…发不进框')
        }
        actions.setDraft(text)
        actions.submit()
        setHint(VOICE.reply === 'auto' ? '已送' : '已送')
        return text
      }

      async function finishHold() {
        if (!holdingRef.current) return
        holdingRef.current = false
        const rec = recRef.current
        if (!rec || rec.state === 'inactive') { setPhase('idle'); setHint(micRef.current === 'open' ? '开麦' : '空格'); return }
        await new Promise((resolve) => {
          const done = async (blob, mime) => {
            let failed = false
            try { await shipBlob(blob, mime) }
            catch (e) {
              failed = true
              setHint(String(e && e.message || e).slice(0, 18))
              setPhase('err')
            }
            stopTracks()
            if (!failed) setPhase('idle')
            resolve()
          }
          rec.onstop = () => done(rec._blob, rec.mimeType || 'audio/wav')
          try { rec.stop() } catch { resolve() }
        })
      }

      async function beginHold() {
        if (!aidRef.current || holdingRef.current) return
        if (phaseRef.current === 'busy') return
        if (micRef.current !== 'ptt') return
        holdingRef.current = true
        setPhase('hold')
        setHint('松开')
        try {
          const stream = await ensureStream()
          startRecorder(stream)
        } catch (e) {
          holdingRef.current = false
          setPhase('err')
          setHint(String(e && e.message || e).slice(0, 18))
          stopTracks()
        }
      }

      useEffect(() => {
        if (!aid || micMode !== 'ptt') return
        const onDown = (e) => {
          if (e.code !== 'Space' && e.key !== ' ') return
          if (e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
          if (spaceShouldType(e.target)) return
          e.preventDefault()
          e.stopPropagation()
          beginHold()
        }
        const onUp = (e) => {
          if (e.code !== 'Space' && e.key !== ' ') return
          if (!holdingRef.current) return
          e.preventDefault()
          e.stopPropagation()
          finishHold()
        }
        const onBlur = () => { if (holdingRef.current) finishHold() }
        window.addEventListener('keydown', onDown, true)
        window.addEventListener('keyup', onUp, true)
        window.addEventListener('blur', onBlur)
        return () => {
          window.removeEventListener('keydown', onDown, true)
          window.removeEventListener('keyup', onUp, true)
          window.removeEventListener('blur', onBlur)
        }
      }, [aid, sid, micMode])

      async function toggleOpen() {
        if (!aid) return
        if (openRef.current) {
          openRef.current = false
          stopTracks()
          setPhase('idle')
          setHint('开麦')
          return
        }
        openRef.current = true
        setPhase('open')
        setHint('听着')
        try {
          const stream = await ensureStream()
          startRecorder(stream)
        } catch (e) {
          openRef.current = false
          setPhase('err')
          setHint(String(e && e.message || e).slice(0, 18))
          stopTracks()
        }
      }
      toggleRef.current = toggleOpen

      const hot = phase === 'hold' || phase === 'open'
      const bad = phase === 'err'
      const label = hint || '空格'
      return h('button', {
        type: 'button',
        title: micMode === 'open' ? '点一下开麦或关掉' : '按住空格说话，松开就送。输入框里已经有字时，空格照常打字。',
        onMouseDown: (e) => e.preventDefault(),
        onClick: (e) => {
          e.preventDefault()
          e.stopPropagation()
          if (micMode === 'open') toggleOpen()
        },
        style: {
          appearance: 'none',
          marginLeft: 6,
          border: '1px solid ' + (bad ? '#c45c26' : 'rgba(255,255,255,.22)'),
          background: hot ? '#c45c26' : 'rgba(255,255,255,.08)',
          color: 'inherit',
          borderRadius: 999,
          padding: '2px 10px',
          fontSize: 12,
          lineHeight: '18px',
          cursor: micMode === 'open' ? 'pointer' : 'default',
          userSelect: 'none',
        },
      }, label)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => watchHotReload(), 'dsh-consciousness: 热更新')
        const Section = (props) => h(SectionBoundary, null, h(Page, props))
        const Presence = (props) => h(SectionBoundary, null, h(ChatPresence, props))
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'consciousness',
          order: 26,
          label: '意识',
        }, Section)), 'dsh-consciousness: settings section')
        ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'consciousness-presence',
          order: 20,
          label: '意识体',
        }, Presence)), 'dsh-consciousness: chat presence')
        const Mic = (props) => h(SectionBoundary, null, h(VoiceMicButton, props))
        ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'consciousness-voice-mic',
          order: 30,
          label: '空格说话',
        }, Mic)), 'dsh-consciousness: voice mic')
        const MicBridge = (props) => h(VoiceMicBridge, props)
        ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'consciousness-voice-bridge',
          order: 40,
          label: '空格说话',
        }, MicBridge)), 'dsh-consciousness: voice bridge')
      },
    }
