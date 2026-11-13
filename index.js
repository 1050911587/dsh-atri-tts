// dsh-atri-tts —— 宿主半端
// 负责：注册 /api/atri-tts/* 路由，管理本地 GPT-SoVITS Python 服务的启停。
// 默认关闭（服务在插件加载时不启动）。开关在前端「亚托莉语音」入口里。
import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'

export const inject = ['webServer']

const DEFAULTS = {
  port: 9880,
  device: 'cuda',
  pythonPath: 'C:\\Users\\10509\\Documents\\deepseek-harness\\default-workspace\\atri-sovits\\runtime\\Scripts\\python.exe',
  apiScript: 'C:\\Users\\10509\\Documents\\deepseek-harness\\default-workspace\\atri-sovits\\api_atri.py',
  cwd: 'C:\\Users\\10509\\Documents\\deepseek-harness\\default-workspace\\atri-sovits\\GPT-SoVITS',
  openJtalkDictDir: 'C:\\Users\\10509\\Documents\\deepseek-harness\\default-workspace\\atri-sovits\\models\\open_jtalk\\open_jtalk_dic_utf_8-1.11',
  nltkData: 'C:\\Users\\10509\\Documents\\deepseek-harness\\default-workspace\\atri-sovits\\models\\nltk_data_dir',
  mplConfigDir: 'C:\\Users\\10509\\Documents\\deepseek-harness\\default-workspace\\atri-sovits\\.mplcache',
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  const state = { state: 'off', pid: null, since: null, lastError: null, logTail: [] }
  let child = null
  let pollTimer = null

  const log = (...a) => { try { console.log('[atri-tts]', ...a) } catch { /* ignore */ } }
  const pushTail = (s) => { state.logTail.push(s); if (state.logTail.length > 40) state.logTail.shift() }

  function sendJson(res, code, obj) {
    try {
      const b = Buffer.from(JSON.stringify(obj))
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(b)
    } catch { /* ignore */ }
  }

  // 简易同源校验：带 Origin 时必须与 Host 匹配，挡住别的网页跨站调用（会启动进程！）
  function sameOriginOk(req) {
    const o = req.headers.origin
    if (!o) return true
    try { const u = new URL(o); return u.host === req.headers.host } catch { return false }
  }

  async function health() {
    try { const r = await fetch(`http://127.0.0.1:${cfg.port}/health`, { signal: AbortSignal.timeout(1500) }); return r.ok } catch { return false }
  }

  function statusObj() {
    return { state: state.state, pid: state.pid, port: cfg.port, since: state.since, error: state.lastError, log: state.logTail.slice(-10).join('') }
  }

  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null } }
  function startPoll() {
    stopPoll()
    pollTimer = setInterval(async () => {
      if (state.state !== 'starting' && state.state !== 'on') return
      const ok = await health()
      if (ok && state.state !== 'on') { state.state = 'on'; log('服务已就绪 (port ' + cfg.port + ')') }
    }, 2000)
  }

  async function start() {
    if (state.state === 'on' || state.state === 'starting') return statusObj()
    if (await health()) { state.state = 'on'; log('检测到已有本地 TTS 服务在跑，直接复用'); return statusObj() }
    if (!existsSync(cfg.pythonPath)) { state.state = 'error'; state.lastError = 'python 不存在: ' + cfg.pythonPath; return statusObj() }
    state.state = 'starting'; state.lastError = null; state.logTail = []; state.since = Date.now()
    try { mkdirSync(cfg.mplConfigDir, { recursive: true }) } catch { /* ignore */ }
    const env = {
      ...process.env,
      OPEN_JTALK_DICT_DIR: cfg.openJtalkDictDir,
      NLTK_DATA: cfg.nltkData,
      MPLCONFIGDIR: cfg.mplConfigDir,
      HF_ENDPOINT: 'https://hf-mirror.com',
      TTS_DEVICE: cfg.device,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
    }
    try {
      child = spawn(cfg.pythonPath, [cfg.apiScript, '-p', String(cfg.port)], {
        cwd: cfg.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      state.pid = child.pid
      child.stdout.on('data', (d) => { const s = d.toString(); pushTail(s); })
      child.stderr.on('data', (d) => { const s = d.toString(); pushTail(s); })
      child.on('exit', (code, sig) => {
        pushTail(`[进程退出 code=${code} sig=${sig}]`)
        if (state.state !== 'off') { state.state = 'error'; state.lastError = `Python 进程退出 (code=${code})` }
        state.pid = null; child = null; stopPoll()
      })
      startPoll()
      log('已拉起 Python 服务 pid=' + state.pid + ' port=' + cfg.port)
    } catch (e) {
      state.state = 'error'; state.lastError = String(e?.message || e)
    }
    return statusObj()
  }

  function stop() {
    stopPoll()
    const c = child
    state.state = 'off'; state.lastError = null
    if (c && c.pid) {
      try { execFile('taskkill', ['/PID', String(c.pid), '/T', '/F'], () => {}) } catch { /* ignore */ }
      try { c.kill() } catch { /* ignore */ }
    }
    child = null; state.pid = null
    return statusObj()
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let b = ''
      req.on('data', (c) => { b += c; if (b.length > 2e6) req.destroy() })
      req.on('end', () => resolve(b))
      req.on('error', () => resolve(''))
    })
  }

  async function handle(req, res, url) {
    if (!sameOriginOk(req)) return sendJson(res, 403, { ok: false, error: '跨源请求被拒绝' })
    const p = url.pathname.replace(/^\/api\/atri-tts/, '') || '/'
    try {
      if (req.method === 'GET' && (p === '/status' || p === '/')) {
        return sendJson(res, 200, { ok: true, ...statusObj() })
      }
      if (req.method === 'POST' && p === '/start') {
        return sendJson(res, 200, { ok: true, ...(await start()) })
      }
      if (req.method === 'POST' && p === '/stop') {
        return sendJson(res, 200, { ok: true, ...stop() })
      }
      if (req.method === 'POST' && p === '/synth') {
        if (state.state !== 'on') return sendJson(res, 409, { ok: false, error: '服务未启动（当前 ' + state.state + '）' })
        let body = {}
        try { body = JSON.parse((await readBody(req)) || '{}') } catch { body = {} }
        const text = String(body.text || '').trim()
        const lang = String(body.lang || 'zh')
        if (!text) return sendJson(res, 400, { ok: false, error: 'text 不能为空' })
        const r = await fetch(`http://127.0.0.1:${cfg.port}/tts`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, text_lang: lang }), signal: AbortSignal.timeout(180000),
        })
        if (!r.ok) {
          let t = ''; try { t = await r.text() } catch { /* ignore */ }
          return sendJson(res, 502, { ok: false, error: 'TTS ' + r.status, detail: t.slice(0, 300) })
        }
        const ab = Buffer.from(await r.arrayBuffer())
        res.statusCode = 200
        res.setHeader('content-type', 'audio/wav')
        res.setHeader('cache-control', 'no-store')
        res.end(ab)
        return
      }
      return sendJson(res, 404, { ok: false, error: 'not found: ' + p })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e?.message || e) })
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/atri-tts',
    handler: (req, res) => { handle(req, res, new URL(req.url, 'http://127.0.0.1')).catch(() => {}) },
  }), 'atri-tts: /api/atri-tts 路由')

  ctx.effect(() => () => { try { stop() } catch { /* ignore */ } }, 'atri-tts: 卸载时停止 python')

  log('已挂载（默认关闭，端口 ' + cfg.port + '）')
}
