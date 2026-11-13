# dsh-atri-tts

**亚托莉（ATRI -My Dear Moments-）本地语音 · DeepSeek Harness 插件**

GPT-SoVITS **v2Pro** 本地语音合成，接入 DSH：

- 🖥️ DSH 左侧「工作区」上方有「**亚托莉语音**」开关入口（状态灯：灰=关 / 黄=启动中 / 绿=运行 / 红=错误；点小灯可直接开/关）
- 🔌 **默认关闭**：打开开关才拉起本地 Python 推理服务，关闭即停止
- 💬 世界 QQ 通道可发语音：`qq_voice` 工具用亚托莉音色把一句话发成 QQ 语音条（自动转 SILK）
- 🗣️ 中文发音按《新华字典》口径校准（`新华字典校准.rep` 读音覆盖表，热更新）
- 🌐 日语 / 中文 / 英语三语合成
- 🧩 附 HTTP 接口（`/api/atri-tts/*`）与合成试听面板

## 语音模型

本插件**不随附模型权重**。需要自行获取亚托莉 GPT-SoVITS 权重并放到固定目录，例如
[HuggingFace: VoidShine/atri-sovits](https://huggingface.co/VoidShine/atri-sovits)（`ATR_e8_s3952.pth` + `ref_audio.wav`，v2Pro）或
[2DIPW/ATRI_GPT-SoVITS](https://huggingface.co/2DIPW/ATRI_GPT-SoVITS)。

同时需要一份可运行的 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 推理环境（本插件按固定路径调用其中的 `api_atri.py`，路径可在插件配置里改）。

## 安装

```powershell
dsh plugin --profile <你的profile> add github:1050911587/dsh-atri-tts
```

> 国内网络若 `github:` 简写连不上 github.com，改用 codeload 直链（同一份源码）：
> ```powershell
> dsh plugin --profile <你的profile> add https://codeload.github.com/1050911587/dsh-atri-tts/tar.gz/refs/heads/main
> ```

装完重启 DSH，左侧「工作区」上方即可看到「亚托莉语音」入口。

## 环境要求

- Windows x64
- DeepSeek Harness ≥ 0.2.1-rc.2
- Node.js ≥ 22（DSH 自带）
- NVIDIA GPU（建议 ≥ 8GB 显存）+ Python 3.10+ 的 GPT-SoVITS 运行时
- QQ 语音需要 SnowLuma / NapCat 提供 OneBot 服务，且 world 的 QQ 通道已开启

## 目录约定（本机部署示例）

```
<工作区>/atri-sovits/
  runtime/            Python venv（torch cu128 + 依赖）
  api_atri.py         FastAPI 推理服务（默认端口 9880）
  GPT-SoVITS/         官方仓库（权重放 GPT_SoVITS/pretrained_models/）
  models/open_jtalk/  日语分词词典
  新华字典校准.rep     中文读音校准表（改完重启服务生效）
```

## ⚠️ 版权与使用限制

亚托莉角色形象/声音/台词版权归 **Frontwing / ANIPLEX.EXE** 所有；
语音模型由社区基于游戏原声训练，**禁止商用**。本插件仅作本地个人用途的技术封装。

## License

MIT（插件代码本身；不包含任何模型权重与游戏素材）
