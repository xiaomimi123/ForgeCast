#!/usr/bin/env python
"""成片转写：<python> asr_transcribe.py <wav> <out.json>
faster-whisper 全文转写（中文），输出 {"ok": true, "text": ..., "segments": [{"start","end","text"}]}
或 {"ok": false, "reason": ...}。与 asr_align.py 共用同一 venv（FORGECAST_ASR_PYTHON，
回落 FORGECAST_MELO_PYTHON；见 docs/hyperframes-deploy.md）。"""
import json
import sys

MODEL_SIZE = "small"


def fail(out_path, reason):
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"ok": False, "reason": reason}, f)


def main():
    wav_path, out_path = sys.argv[1], sys.argv[2]
    from faster_whisper import WhisperModel

    model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
    segments, _ = model.transcribe(wav_path, language="zh")
    segs = [
        {"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip()}
        for s in segments if s.text.strip()
    ]
    if not segs:
        return fail(out_path, "未识别出任何文字（可能是静音音轨）")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"ok": True, "text": "".join(x["text"] for x in segs), "segments": segs}, f)


if __name__ == "__main__":
    main()
