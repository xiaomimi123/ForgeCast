#!/usr/bin/env python
"""CosyVoice2 零样本克隆配音：<cosyPython> cosy_infer.py <COSY_HOME> <text> <out.wav>
COSY_HOME 约定结构：venv/（本脚本用的 python 就在里面）、CosyVoice/（仓库）、
model/（CosyVoice2-0.5B）、prompt.wav + prompt.txt（要克隆的参考音频及其转写）。
强制 CPU（M1 无 CUDA）；换音色 = 换 prompt.wav/prompt.txt。速度 RTF ~2.75x。"""
import os
import sys

home, text, out = sys.argv[1], sys.argv[2], sys.argv[3]
sys.path.insert(0, os.path.join(home, "CosyVoice"))
sys.path.append(os.path.join(home, "CosyVoice", "third_party", "Matcha-TTS"))
os.chdir(os.path.join(home, "CosyVoice"))
import torch  # noqa: E402
import torchaudio  # noqa: E402
torch.backends.mps.is_available = lambda: False  # 逼 CPU
from cosyvoice.cli.cosyvoice import CosyVoice2  # noqa: E402

prompt_wav = os.path.join(home, "prompt.wav")
with open(os.path.join(home, "prompt.txt"), encoding="utf-8") as f:
    prompt_text = f.read().strip()

cv = CosyVoice2(os.path.join(home, "model"), load_jit=False, load_trt=False, fp16=False)
for j in cv.inference_zero_shot(text, prompt_text, prompt_wav, stream=False):
    torchaudio.save(out, j["tts_speech"], cv.sample_rate)
    break
