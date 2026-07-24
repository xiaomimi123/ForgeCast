#!/usr/bin/env python
"""MeloTTS 中文配音推理：<python> melo_infer.py <text> <out.wav> [speed]
强制 CPU——MeloTTS 的 MPS 路径在 Apple Silicon 上慢到不可用（实测 163s/句），
纯 CPU 反而快（~1.3s/句，RTF 0.23x）。需在装好 MeloTTS 的 venv 里跑，见部署文档。"""
import sys
import torch
torch.backends.mps.is_available = lambda: False  # 屏蔽 MPS，逼全 CPU
from melo.api import TTS

text, out = sys.argv[1], sys.argv[2]
speed = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
model = TTS(language="ZH", device="cpu")
spk = list(model.hps.data.spk2id.values())[0]  # 中文单说话人
model.tts_to_file(text, spk, out, speed=speed, quiet=True)
