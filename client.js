/**
 * dsh-atri-tts —— 浏览器半端（自注册 bundle）
 * 左侧「工作区上方」那排(global panel rows / sidebar.panellist)里加一个「亚托莉语音」入口：
 *   - 入口小灯实时反映服务状态（灰=关 / 黄=启动中 / 绿=运行 / 红=错误）；点小灯可直接开/关。
 *   - 点这一行打开主面板：总开关 + 状态 + 合成试听。
 * 开关打开 → 宿主拉起本地 Python(GPT-SoVITS) 服务；关闭 → 杀掉。默认关闭。
 */
window.__ModuleLoader__.load({
  id: 'dsh-atri-tts',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React
    const API = '/api/atri-tts'

    const asJson = async (res) => {
      if (res.ok) return res.json()
      let t = ''
      try { t = await res.text() } catch { /* ignore */ }
      throw new Error('HTTP ' + res.status + (t ? ' ' + t.slice(0, 160) : ''))
    }
    const jget = (p) => fetch(API + p, { credentials: 'same-origin' }).then(asJson)
    const jpost = (p, body) => fetch(API + p, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    }).then(asJson)

    function useStatus(intervalMs) {
      const [st, setSt] = useState({ state: 'off' })
      useEffect(() => {
        let alive = true
        let timer
        const tick = async () => { try { const s = await jget('/status'); if (alive) setSt(s) } catch { /* ignore */ } }
        tick()
        timer = setInterval(tick, intervalMs || 2500)
        return () => { alive = false; clearInterval(timer) }
      }, [])
      return [st, setSt]
    }

    const 灯色 = (s) => s === 'on' ? '#35d07f' : s === 'starting' ? '#e0a83a' : s === 'error' ? '#e5534b' : '#6b7280'
    function 小灯({ state }) {
      return h('span', {
        style: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block', background: 灯色(state), boxShadow: state === 'on' ? '0 0 6px #35d07f' : 'none' },
      })
    }

    // sidebar.panellist 的图标：小灯 + 可点击直接开/关
    function 图标(props) {
      const [st, setSt] = useStatus(3000)
      const on = st.state === 'on' || st.state === 'starting'
      const click = async (e) => {
        try { e.stopPropagation(); e.preventDefault() } catch { /* ignore */ }
        try { await jpost(on ? '/stop' : '/start'); const s = await jget('/status'); setSt(s) } catch { /* ignore */ }
      }
      const tip = '亚托莉语音 · ' + (st.state === 'on' ? '运行中' : st.state === 'starting' ? '启动中' : st.state === 'error' ? '错误' : '已关闭') + '（点击开/关）'
      return h('span', {
        role: 'button', title: tip, onClick: click,
        style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: (props && props.size) || 16, height: (props && props.size) || 16, cursor: 'pointer' },
      }, h(小灯, { state: st.state }))
    }

    function Switch({ on, busy, onChange }) {
      return h('button', {
        onClick: onChange, disabled: busy, role: 'switch', 'aria-checked': on ? 'true' : 'false', title: on ? '点击关闭' : '点击开启',
        style: { flex: 'none', width: 46, height: 26, borderRadius: 13, border: '0', cursor: busy ? 'default' : 'pointer', position: 'relative', transition: 'background .18s', background: on ? '#2ea86a' : '#3a3f4b', opacity: busy ? 0.6 : 1, padding: 0 },
      }, h('span', { style: { position: 'absolute', top: 3, left: on ? 23 : 3, width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'left .18s' } }))
    }

    const S = {
      wrap: { padding: '20px 22px', maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 16 },
      title: { fontSize: 16, fontWeight: 600 },
      sub: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #9aa0a6)', lineHeight: 1.6 },
      row: { display: 'flex', alignItems: 'center', gap: 12 },
      card: { border: '1px solid rgba(150,170,210,0.16)', borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12, background: 'rgba(255,255,255,0.02)' },
      ta: { width: '100%', minHeight: 78, resize: 'vertical', borderRadius: 8, border: '1px solid rgba(150,170,210,0.2)', background: 'rgba(0,0,0,0.18)', color: 'inherit', padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' },
      btn: { border: '1px solid rgba(150,170,210,0.28)', borderRadius: 8, padding: '7px 16px', cursor: 'pointer', background: 'rgba(90,140,220,0.18)', color: 'inherit', fontSize: 13 },
      err: { color: '#ff8f8a', fontSize: 12, whiteSpace: 'pre-wrap' },
    }

    function 面板() {
      const [st, setSt] = useStatus(2000)
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')
      const [text, setText] = useState('こんにちは、夏生さん。わたしはアトリです。')
      const [lang, setLang] = useState('ja')
      const [synthing, setSynthing] = useState(false)
      const [audioUrl, setAudioUrl] = useState('')
      const audioRef = useRef(null)
      const running = st.state === 'on'
      const starting = st.state === 'starting'

      const toggle = async () => {
        setBusy(true); setErr('')
        try { await jpost(running || starting ? '/stop' : '/start'); const s = await jget('/status'); setSt(s) }
        catch (e) { setErr(String((e && e.message) || e)) } finally { setBusy(false) }
      }
      const synth = async () => {
        if (!running) { setErr('请先打开开关，等服务变为「运行中」'); return }
        setSynthing(true); setErr('')
        try {
          const r = await fetch(API + '/synth', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, lang }),
          })
          if (!r.ok) { let t = ''; try { t = await r.text() } catch { /* ignore */ }; throw new Error('合成失败 HTTP ' + r.status + ' ' + t.slice(0, 160)) }
          const blob = await r.blob()
          const u = URL.createObjectURL(blob)
          if (audioUrl) { try { URL.revokeObjectURL(audioUrl) } catch { /* ignore */ } }
          setAudioUrl(u)
          setTimeout(() => { try { audioRef.current && audioRef.current.play() } catch { /* ignore */ } }, 60)
        } catch (e) { setErr(String((e && e.message) || e)) } finally { setSynthing(false) }
      }

      const stateLabel = running ? '运行中' : starting ? '启动中…（首次加载模型约 10–40 秒）' : st.state === 'error' ? '出错' : '已关闭'

      return h('div', { style: S.wrap },
        h('div', { style: S.title }, '亚托莉语音 · GPT-SoVITS v2Pro'),
        h('div', { style: S.sub }, '本地语音合成（日中英）。打开开关即启动本地 Python 服务，关闭即停止；插件默认关闭。'),
        h('div', { style: S.card },
          h('div', { style: S.row },
            h('div', { style: { flex: 1 } },
              h('div', { style: { fontSize: 14, fontWeight: 600 } }, '语音服务'),
              h('div', { style: S.sub }, stateLabel + (st.port ? (' · 端口 ' + st.port) : '') + (st.pid ? (' · PID ' + st.pid) : ''))),
            h(Switch, { on: running || starting, busy, onChange: toggle })),
          (st.state === 'error' && st.error) ? h('div', { style: S.err }, '错误：' + st.error) : null,
          (st.state === 'error' && st.log) ? h('pre', { style: { ...S.err, color: '#c7a9a9', fontSize: 11, maxHeight: 120, overflow: 'auto', margin: 0 } }, String(st.log).slice(-1200)) : null,
        ),
        h('div', { style: S.card },
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, '合成试听'),
          h('textarea', { style: S.ta, value: text, onChange: (e) => setText(e.target.value) }),
          h('div', { style: S.row },
            h('select', { value: lang, onChange: (e) => setLang(e.target.value), style: { ...S.ta, minHeight: 0, width: 110, padding: '7px 8px' } },
              h('option', { value: 'ja' }, '日语'),
              h('option', { value: 'zh' }, '中文'),
              h('option', { value: 'en' }, '英语')),
            h('button', { style: S.btn, onClick: synth, disabled: synthing || !running }, synthing ? '合成中…' : '合成试听')),
        ),
        err ? h('div', { style: S.err }, err) : null,
        audioUrl ? h('audio', { ref: audioRef, src: audioUrl, controls: true, style: { width: '100%' } }) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 工作区正上方那排「全局面板行」里的入口
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'atri-tts', order: 15, label: () => '亚托莉语音' },
          图标,
        ))
        // 点入口后打开的主面板
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'atri-tts' }, 面板))
      },
    }
  },
})
