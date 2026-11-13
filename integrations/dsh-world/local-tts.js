// 本地亚托莉 GPT-SoVITS TTS —— 给 QQ 世界通道发语音条用。
// ⚠️ 不再自动拉起服务：是否可用完全以「亚托莉语音」开关（DSH 左侧工作区上方）为准。
// 开关开着=本地 python 服务在跑，这里只负责合成；开关关着=服务不在，直接报错回退文字。
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = 'C:\\Users\\10509\\Documents\\deepseek-harness\\default-workspace\\atri-sovits'
const CFG = {
  baseUrl: process.env.ATRI_TTS_BASE || 'http://127.0.0.1:9880',
  lang: process.env.ATRI_TTS_LANG || 'zh',
  maxChars: Number(process.env.ATRI_TTS_MAXCHARS || 200),
  timeoutMs: Number(process.env.ATRI_TTS_TIMEOUT || 180000),
  cacheDir: process.env.ATRI_TTS_CACHE || join(BASE, 'tts_cache')
}

async function health() {
  try { const r = await fetch(CFG.baseUrl + '/health', { signal: AbortSignal.timeout(1500) }); return r.ok } catch { return false }
}

/** 只检查，不拉起。服务不在（语音开关没开）就抛错，让上层回退文字。 */
export async function assertServer() {
  if (await health()) return
  throw new Error('语音开关没开：本地亚托莉语音服务没在运行。请主人先在 DSH 左侧「工作区」上方的「亚托莉语音」把开关打开（它会启动本地 python），再让我发语音；这次先用文字吧。')
}

export function getMaxChars() { return CFG.maxChars }

/** 合成一句话 → 返回 wav 绝对路径。服务没开则抛错。 */
export async function synthToFile(text, lang) {
  const clean = String(text ?? '').trim()
  if (!clean) throw new Error('语音文本为空')
  if (clean.length > CFG.maxChars) throw new Error(`语音太长（${clean.length}/${CFG.maxChars} 字），请改用文字`)
  await assertServer()
  let r
  try {
    r = await fetch(CFG.baseUrl + '/tts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: clean, text_lang: lang || CFG.lang }),
      signal: AbortSignal.timeout(CFG.timeoutMs)
    })
  } catch (e) {
    throw new Error('本地亚托莉 TTS 不可用：' + (e?.message ?? e))
  }
  if (!r.ok) {
    let t = ''
    try { t = await r.text() } catch { /* ignore */ }
    throw new Error(`本地 TTS 合成失败 HTTP ${r.status} ${String(t).slice(0, 160)}`)
  }
  const buf = Buffer.from(await r.arrayBuffer())
  if (!buf.length) throw new Error('本地 TTS 返回空音频')
  mkdirSync(CFG.cacheDir, { recursive: true })
  const file = join(CFG.cacheDir, `qqvoice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`)
  writeFileSync(file, buf)
  return file
}

export default { assertServer, synthToFile, getMaxChars }
