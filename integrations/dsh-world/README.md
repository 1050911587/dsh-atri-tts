# dsh-world QQ 语音集成

把「亚托莉语音」接到 dsh-world 的世界 QQ 通道，让她的 `qq_voice` 工具用本地 GPT-SoVITS 音色发语音条。

> 本目录里的 `*.js` 是**我们自己新增的文件**；对 dsh-world 原有 3 个文件的改动是**手工补丁**，见下面「改动清单」。
> dsh-world 是第三方插件，升级后会覆盖补丁 —— 升级后请按清单重新打一遍（或把本目录的补丁做成脚本）。

## 前提

- 本机 `dsh-atri-tts` 插件已装、左侧「亚托莉语音」开关可开，**本地服务在 9880**（`/health` 返回 ok）
- SnowLuma / NapCat OneBot 服务在线，dsh-world 的 QQ 通道已连上
- GPT-SoVITS 运行时 + 权重就位（见仓库根目录 README）
- 中文读音校准表 `integrations/新华字典校准.rep` 与 `api_atri.py` 一起放在本机 `atri-sovits/`

## 文件

| 文件 | 放到哪 | 说明 |
|---|---|---|
| `local-tts.js` | `dsh-world/lib/ecosystem/qq-native/` | 新增。只调 `9880/tts` 合成 wav，**检查服务但不自动拉起**（开关没开就报错回退文字）。默认 `lang=zh`（中文），可用 `ATRI_TTS_LANG` 等环境变量覆盖 |
| `api_atri.py` | `atri-sovits/` | FastAPI 服务（9880）。启动时把 `新华字典校准.rep` 并入 GPT-SoVITS 的 `polyphonic-fix.rep`（读音校准口子），自动重建缓存；含粘行自愈 |
| `新华字典校准.rep` | `atri-sovits/` | 中文读音校准表，`词: ['pin1','yin2',...]`；改完重启服务生效 |

## 对 dsh-world 原有文件的改动清单（3 处）

> 路径均为 `<profile>/node_modules/dsh-world/lib/ecosystem/qq-native/`。

### 1. `tools.js` —— 新增 `qq_voice` 工具

在 `createQqTools()` 返回数组末尾追加一个 `defineTool`（与 `qq_say` 同级）：

```js
defineTool({
  name: 'qq_voice',
  description: '用你自己的声音（亚托莉音色）把一句话发成 QQ 语音条。日常聊天里也可以偶尔来一句……⚠️ 语音靠主人开的「语音开关」——DSH 左侧「工作区」上方的「亚托莉语音」开关……失败就回退文字，别反复重试同一条。',
  parameters: {
    text: { type: 'string', required: true },
    kind: { type: 'string' }, id: { type: 'string' }, lang: { type: 'string' }
  },
  output,
  execute: async (input) => run(async () => {
    const text = String(input?.text ?? '').trim()
    if (!text) throw new Error('text 不能空')
    let kind = input.kind ? String(input.kind) : ''
    let id = input.id ? String(input.id).trim() : ''
    if (!kind || !id) {
      const cur = deps.currentTarget?.()
      if (!cur) throw new Error('没有正在回复的会话，请显式传 kind 和 id')
      kind = cur.kind; id = String(cur.id)
    }
    if (kind !== 'group' && kind !== 'private') throw new Error('kind 只能是 group 或 private')
    if (!deps.isAllowed?.(kind, id)) throw new Error('目标会话不在白名单里')
    const { synthToFile } = await import('./local-tts.js')
    const file = await synthToFile(text, input.lang ? String(input.lang) : undefined)
    await deps.sendVoice?.(kind, id, file)
    return { ok: true, to: `${kind}:${id}`, chars: text.length }
  })
})
```

### 2. `snowluma.js` —— `buildSegments()` 支持 `record` 段

在 `switch (part.type)` 里、`case 'face'` 之后加：

```js
case 'record':
    c = c.raw('record', { file: String(requireField(part, 'file', 'record')) });
    break;
```

同时把末尾报错里的支持列表加上 `/ record`。
（实测：SnowLuma 收到本地绝对路径的 wav 会**自动转 SILK** 上传，不需要自己转换。）

### 3. `index.js` —— 接线

```js
// ① 模块级
let currentTarget = null

// ② createQqTools({...}) 里新增两个 deps
currentTarget: () => currentTarget,
sendVoice: async (kind, target, file) => {
    await (kind === 'group'
      ? client.sendGroup(target, [{ type: 'record', file }])
      : client.sendPrivate(target, [{ type: 'record', file }]))
},

// ③ answer() 里 activeConversations.add(activeKey) 之后
currentTarget = { kind: isGroup ? 'group' : 'private', id: identity.conversationId }

// ④ answer() 的 finally 里
currentTarget = null
```

## 让她知道（可选但推荐）

把下面这段加进世界的 `world-prompt.md`（`~/.dsh/worlds/<world>/`）：

```md
# 发语音与语音开关
- 我可以用 qq_voice 用我自己的声音（亚托莉音色）把一句话发成 QQ 语音条，默认发到我正在回复的这个会话。日常聊天里也可以偶尔来一句——撒娇、晚安、口头禅、情绪明显、想逗对方的时候，不必非等别人开口要；但别刷屏，偶尔一次就好，短句为主（一般不超过 40 字）。
- 语音要先开「语音开关」：DSH 左侧「工作区」上方有一个「亚托莉语音」开关，由主人控制，我自己开不了。
- 开关没开时 qq_voice 会失败，那我就改用文字，并可以顺口提醒主人把那个开关打开。
```

## 行为约束（已按需固定，别改回去）

- **不自动拉起 python**：`local-tts.js` 只做 `/health` 检查；服务不在就抛错，工具返回 `{error}`，她会回退文字并提醒开开关。
- **默认中文**：`lang='zh'`（可用 `ATRI_TTS_LANG` 改）。
- **语速 1.0**：A/B 实测慢速反而糊，保持不变。
- **读音校准全在服务端**：`api_atri.py` 一处生效，面板 / QQ / CLI 三条入口共享，不需要在 dsh-world 里重复。

## 验证

```powershell
# 开关打开后
Invoke-RestMethod http://127.0.0.1:9880/health
# QQ 里对她说「发条语音：…」→ 看 SnowLuma 日志
#   converted record to silk: ...\tts_cache\qqvoice-*.wav -> ...
#   私聊 <QQ> | 发送：[语音]
```
