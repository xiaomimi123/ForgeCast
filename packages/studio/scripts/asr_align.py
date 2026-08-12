#!/usr/bin/env python
"""字幕真对齐：<python> asr_align.py <wav> <sentences.json> <out.json>
faster-whisper 转写出词级时间戳，只用来对时间——识别出的文字本身丢弃不用，
我们展示的字幕内容始终是调用方传入的原文（sentences.json）。
对齐用标准库 difflib 做字符级序列匹配：把 ASR 转写的每个词展开成逐字符时间
（词内线性插值），拼成一条"ASR 字符流"，再跟原文整体拼接做 SequenceMatcher，
把每句原文的字符区间映射到 ASR 字符流上对应的时间区间。
任何一步失败（字符匹配率过低、某句完全没匹配上）都写 {"ok": false, "reason": ...}，
调用方（Node 侧 alignCues）据此回落到按字数估算的旧逻辑，不当成异常处理。
需要 faster-whisper（pip install faster-whisper，装进 FORGECAST_ASR_PYTHON 指向
的 venv；见 docs/hyperframes-deploy.md）。"""
import difflib
import json
import sys

MODEL_SIZE = "small"
MIN_MATCH_RATIO = 0.5  # 匹配到的字符占原文总字符数的最低比例，低于此判定对齐失败


def fail(out_path, reason):
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"ok": False, "reason": reason}, f)


def main():
    wav_path, sentences_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(sentences_path, encoding="utf-8") as f:
        sentences = json.load(f)

    if not sentences:
        return fail(out_path, "无原文句子")

    from faster_whisper import WhisperModel

    model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
    segments, _ = model.transcribe(wav_path, word_timestamps=True, language="zh")

    asr_chars = []
    asr_times = []
    for seg in segments:
        for w in seg.words:
            word = w.word.strip()
            if not word:
                continue
            n = len(word)
            span = (w.end - w.start) / n
            for i, ch in enumerate(word):
                asr_chars.append(ch)
                asr_times.append((w.start + i * span, w.start + (i + 1) * span))

    if not asr_chars:
        return fail(out_path, "ASR 未识别出任何文字（可能是静音音轨）")

    full_text = "".join(sentences)
    asr_text = "".join(asr_chars)

    sm = difflib.SequenceMatcher(None, full_text, asr_text, autojunk=False)
    matched = [None] * len(full_text)  # full_text 下标 → asr_chars 下标（未匹配为 None）
    total_matched = 0
    for block in sm.get_matching_blocks():
        for k in range(block.size):
            matched[block.a + k] = block.b + k
            total_matched += 1

    if len(full_text) == 0 or total_matched / len(full_text) < MIN_MATCH_RATIO:
        return fail(out_path, f"字符匹配率过低（{total_matched}/{len(full_text)}）")

    cues = []
    offset = 0
    last_end = 0.0
    for s in sentences:
        n = len(s)
        idxs = [matched[offset + i] for i in range(n) if matched[offset + i] is not None]
        offset += n
        if not idxs:
            return fail(out_path, "存在句子完全未匹配到 ASR 结果")
        start = asr_times[min(idxs)][0]
        end = asr_times[max(idxs)][1]
        if start < last_end:
            start = last_end
        if end < start:
            end = start + 0.1
        cues.append({"start": round(start, 3), "end": round(end, 3)})
        last_end = end

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"ok": True, "cues": cues}, f)


if __name__ == "__main__":
    main()
