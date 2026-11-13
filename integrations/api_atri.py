"""
ATR TTS API Server

启动: python api_atri.py [-a 127.0.0.1] [-p 9880]

接口文档: http://127.0.0.1:9880/docs
"""

import os
import sys
import signal
import argparse
import subprocess
import threading
import wave
from io import BytesIO
from typing import Generator, Optional, Union

import numpy as np
import soundfile as sf
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
import uvicorn

now_dir = os.getcwd()
sys.path.append(now_dir)
sys.path.append(os.path.join(now_dir, "GPT_SoVITS"))

from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

# ── Config ──────────────────────────────────────────────
_BASE = r"C:\Users\10509\Documents\deepseek-harness\default-workspace\atri-sovits"
GPT_MODEL = _BASE + r"\GPT-SoVITS\GPT_SoVITS\pretrained_models\s1v3.ckpt"
SOVITS_MODEL = _BASE + r"\ATR_e8_s3952.pth"
REF_AUDIO = _BASE + r"\ref_audio.wav"
REF_TEXT = "わたしはマスターの所有物ですので。 勝手に売買するのは違法です"
REF_LANG = "ja"
VERSION = "v2Pro"

# ── 发音校准（新华字典口径）────────────────────────────
# 校准表：atri-sovits/新华字典校准.rep
#   词级 `词: ['pin1','yin2',...]` 整词覆盖；字级 `字: ['pin1',...]` 恒取第一读音。
# 启动时并入 GPT-SoVITS 官方校准口子 text/g2pw/polyphonic-fix.rep（优先级最高），
# 文件 md5 变化会自动重建读音缓存。改表后重启服务生效。
def _apply_pron_fix():
    import ast
    src = os.path.join(_BASE, "新华字典校准.rep")
    dst = os.path.join(_BASE, "GPT-SoVITS", "GPT_SoVITS", "text", "g2pw", "polyphonic-fix.rep")
    if not os.path.exists(src):
        return
    try:
        # 1) 解析校准表（后出现的词条覆盖先出现的）
        ours, order = {}, []
        with open(src, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or ":" not in line:
                    continue
                key, val = line.split(":", 1)
                key = key.strip()
                try:
                    parsed = ast.literal_eval(val.strip())
                except Exception:
                    print(f"[pron-fix] 跳过非法行: {line}")
                    continue
                if not isinstance(parsed, list) or not parsed or not all(isinstance(x, str) for x in parsed):
                    print(f"[pron-fix] 跳过非法行（值必须是拼音字符串列表）: {line}")
                    continue
                ours[key] = f"{key}: {parsed!r}"
                if key not in order:
                    order.append(key)
        if not ours:
            return
        # 2) 重写官方 fix 表：同名词条以校准表为准，校准行放最后（read_dict 后写覆盖）
        import re
        old_lines = []
        if os.path.exists(dst):
            with open(dst, "r", encoding="utf-8") as f:
                old_lines = f.read().splitlines()
        kept, replaced, repaired = [], 0, 0
        for raw in old_lines:
            line = raw.strip()
            if not line:
                continue
            # 自愈历史粘行（一行粘多条 "字: [...]" 会让 read_dict 崩溃）
            segs = re.findall(r"[^:\n]+:\s*\[[^\]]*\]", line)
            if len(segs) > 1:
                repaired += 1
                now_lines = segs
            elif ":" in line:
                now_lines = [line]
            else:
                continue
            for line2 in now_lines:
                key = line2.split(":", 1)[0].strip()
                if key in ours:
                    replaced += 1
                    continue
                kept.append(line2)
        new_lines = kept + [ours[k] for k in order]
        if new_lines != old_lines:
            with open(dst, "w", encoding="utf-8") as f:
                f.write("\n".join(new_lines) + "\n")
            msg = f"[pron-fix] 校准表生效：{len(ours)} 条（新华字典口径），覆盖官方同名词条 {replaced} 条"
            if repaired:
                msg += f"，修复粘行 {repaired} 行"
            print(msg)
    except Exception as e:
        print("[pron-fix] 读音校准合并失败:", e)

_apply_pron_fix()


# ── Request / Response Models ───────────────────────────
class TTSRequest(BaseModel):
    text: str = Field(..., description="要合成的文本", examples=["こんにちは、お元気ですか？"])
    text_lang: str = Field("zh", description="文本语言: zh, en, ja, ko, yue（默认中文）")
    ref_audio_path: Optional[str] = Field(None, description="参考音频路径 (留空使用默认)")
    prompt_text: Optional[str] = Field(None, description="参考音频的文本 (留空使用默认)")
    prompt_lang: Optional[str] = Field(None, description="参考音频的语言 (留空使用默认)")
    speed_factor: float = Field(1.0, ge=0.5, le=2.0, description="语速倍率")
    top_k: int = Field(15, ge=1, description="Top-K 采样")
    top_p: float = Field(1.0, ge=0.0, le=1.0, description="Top-P 采样")
    temperature: float = Field(1.0, ge=0.0, le=2.0, description="采样温度")
    seed: int = Field(-1, description="随机种子 (-1 为随机)")
    media_type: str = Field("wav", description="输出格式: wav, ogg, aac, raw")
    text_split_method: str = Field("cut5", description="文本切分方式: cut0-cut5")
    batch_size: int = Field(1, ge=1, description="推理批大小")
    sample_steps: int = Field(32, ge=1, description="采样步数")

    model_config = {"json_schema_extra": {
        "examples": [
            {"text": "こんにちは、お元気ですか？", "text_lang": "ja"},
            {"text": "你好，很高兴认识你。", "text_lang": "zh"},
        ]
    }}


class TTSStreamRequest(TTSRequest):
    streaming_mode: int = Field(1, ge=1, le=3,
        description="流式模式: 1=分段(最高质量), 2=真流式(中等质量), 3=定长流式(最快响应)")


class HealthResponse(BaseModel):
    status: str
    gpt_model: str
    sovits_model: str
    ref_audio: str
    version: str


# ── Audio packing helpers ───────────────────────────────
def pack_wav(data: np.ndarray, rate: int) -> bytes:
    buf = BytesIO()
    sf.write(buf, data, rate, format="wav")
    buf.seek(0)
    return buf.read()


def pack_ogg(data: np.ndarray, rate: int) -> bytes:
    buf = BytesIO()
    def _write():
        with sf.SoundFile(buf, mode="w", samplerate=rate, channels=1, format="ogg") as f:
            f.write(data)
    t = threading.Thread(target=_write)
    threading.stack_size(4096 * 4096)
    t.start()
    t.join()
    buf.seek(0)
    return buf.read()


def pack_aac(data: np.ndarray, rate: int) -> bytes:
    proc = subprocess.Popen(
        ["ffmpeg", "-f", "s16le", "-ar", str(rate), "-ac", "1",
         "-i", "pipe:0", "-c:a", "aac", "-b:a", "192k", "-vn", "-f", "adts", "pipe:1"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    out, _ = proc.communicate(input=data.tobytes())
    return out


def pack_audio(data: np.ndarray, rate: int, media_type: str) -> bytes:
    if media_type == "ogg":
        return pack_ogg(data, rate)
    elif media_type == "aac":
        return pack_aac(data, rate)
    elif media_type == "wav":
        return pack_wav(data, rate)
    return data.tobytes()


def wave_header_chunk(sample_rate: int = 32000) -> bytes:
    buf = BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(b"")
    buf.seek(0)
    return buf.read()


# ── App ─────────────────────────────────────────────────
app = FastAPI(
    title="ATR TTS API",
    description="ATR 角色语音合成接口。基于 GPT-SoVITS v2Pro 模型。",
    version="1.0.0",
)
tts_pipeline: TTS = None


@app.on_event("startup")
def startup():
    global tts_pipeline
    print("Loading models...")
    config = TTS_Config("GPT_SoVITS/configs/tts_infer.yaml")
    _device = os.environ.get("TTS_DEVICE", "cuda").lower()
    config.device = _device
    config.is_half = (_device == "cuda")
    config.version = VERSION
    config.t2s_weights_path = GPT_MODEL
    config.vits_weights_path = SOVITS_MODEL
    tts_pipeline = TTS(config)
    print(f"Models loaded. Version: {VERSION}")
    print(f"  GPT:    {GPT_MODEL}")
    print(f"  SoVITS: {SOVITS_MODEL}")
    print(f"  Ref:    {REF_AUDIO}")


def _build_req(req: TTSRequest, streaming_mode: int = 0) -> dict:
    return {
        "text": req.text,
        "text_lang": req.text_lang.lower(),
        "ref_audio_path": req.ref_audio_path or REF_AUDIO,
        "prompt_text": req.prompt_text if req.prompt_text is not None else REF_TEXT,
        "prompt_lang": (req.prompt_lang or REF_LANG).lower(),
        "top_k": req.top_k,
        "top_p": req.top_p,
        "temperature": req.temperature,
        "text_split_method": req.text_split_method,
        "batch_size": req.batch_size,
        "batch_threshold": 0.75,
        "split_bucket": True,
        "speed_factor": req.speed_factor,
        "fragment_interval": 0.3,
        "seed": req.seed,
        "media_type": req.media_type,
        "streaming_mode": streaming_mode in (2, 3),
        "return_fragment": streaming_mode == 1,
        "fixed_length_chunk": streaming_mode == 3,
        "parallel_infer": True,
        "repetition_penalty": 1.35,
        "sample_steps": req.sample_steps,
        "super_sampling": False,
    }


# ── Endpoints ───────────────────────────────────────────
@app.get("/health", response_model=HealthResponse, summary="健康检查")
async def health():
    return HealthResponse(
        status="ok",
        gpt_model=GPT_MODEL,
        sovits_model=SOVITS_MODEL,
        ref_audio=REF_AUDIO,
        version=VERSION,
    )


@app.post("/tts", summary="语音合成", description="输入文本，返回完整的音频文件。",
          responses={200: {"content": {"audio/wav": {}}}, 400: {"description": "合成失败"}})
async def tts_endpoint(request: TTSRequest):
    req = _build_req(request, streaming_mode=0)
    try:
        gen = tts_pipeline.run(req)
        # 非流式：把 generator 里的所有分段全部取完再拼起来。
        # 原来只 next(gen) 一次，长句被 cut5 切成几段时只会返回第一段（约 1 秒）。
        sr = None
        chunks = []
        for sr_i, chunk in gen:
            sr = sr_i
            chunks.append(chunk)
        if not chunks:
            raise RuntimeError("tts produced no audio")
        audio = chunks[0] if len(chunks) == 1 else np.concatenate(chunks)
        audio_bytes = pack_audio(audio, sr, request.media_type)
        return Response(audio_bytes, media_type=f"audio/{request.media_type}")
    except Exception as e:
        return JSONResponse(status_code=400, content={"message": "tts failed", "error": str(e)})


@app.post("/tts/stream", summary="流式语音合成",
          description="输入文本，流式返回音频数据。适用于长文本实时播放。",
          responses={200: {"content": {"audio/wav": {}}}, 400: {"description": "合成失败"}})
async def tts_stream_endpoint(request: TTSStreamRequest):
    req = _build_req(request, streaming_mode=request.streaming_mode)
    try:
        gen = tts_pipeline.run(req)
        media = request.media_type

        def stream(gen: Generator):
            first = True
            for sr, chunk in gen:
                if first and media == "wav":
                    yield wave_header_chunk(sample_rate=sr)
                    first = False
                    yield pack_audio(chunk, sr, "raw")
                else:
                    yield pack_audio(chunk, sr, media)

        return StreamingResponse(stream(gen), media_type=f"audio/{media}")
    except Exception as e:
        return JSONResponse(status_code=400, content={"message": "tts failed", "error": str(e)})


# ── Main ────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="ATR TTS API Server")
    parser.add_argument("-a", "--host", default="127.0.0.1", help="绑定地址 (默认 127.0.0.1)")
    parser.add_argument("-p", "--port", type=int, default=9880, help="端口号 (默认 9880)")
    args = parser.parse_args()

    print(f"\n  API docs: http://{args.host}:{args.port}/docs\n")
    uvicorn.run(app=app, host=args.host, port=args.port, workers=1)
