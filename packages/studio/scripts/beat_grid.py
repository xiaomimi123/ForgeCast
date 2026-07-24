#!/usr/bin/env python
"""BGM 节拍分析：<python> beat_grid.py <bgm> <out.json>
librosa beat_track 取节拍 → 最小二乘拟合线性网格（不信标量 tempo，能差 2%+）→
40-160Hz 带通滤底鼓定强拍。输出 {t0,T,bpm,beats,strongBeats,duration}。需 librosa+numpy（melo venv 里有）。"""
import json
import sys
import numpy as np
import scipy.signal
# 兼容：librosa 0.9.x 的 beat_track 调 scipy.signal.hann，scipy>=1.13 已把窗函数移到
# scipy.signal.windows。melo venv 的 scipy 较新（1.17），补回旧符号避免 AttributeError。
for _w in ("hann", "hamming", "blackman", "bartlett"):
    if not hasattr(scipy.signal, _w) and hasattr(scipy.signal.windows, _w):
        setattr(scipy.signal, _w, getattr(scipy.signal.windows, _w))
import librosa

bgm, out = sys.argv[1], sys.argv[2]
y, sr = librosa.load(bgm, sr=None, mono=True)
duration = float(len(y) / sr)
_, beat_frames = librosa.beat.beat_track(y=y, sr=sr, tightness=400, units="frames")
beats = librosa.frames_to_time(beat_frames, sr=sr)

if len(beats) >= 2:
    # 最小二乘拟合 t_i = t0 + i*T
    i = np.arange(len(beats))
    A = np.vstack([i, np.ones_like(i)]).T
    (T, t0), *_ = np.linalg.lstsq(A, beats, rcond=None)
    T = float(T); t0 = float(t0)
    bpm = 60.0 / T if T > 0 else 0.0
else:
    T, t0, bpm = 0.5, float(beats[0]) if len(beats) else 0.0, 120.0

# 强拍：40-160Hz 带通滤底鼓 → onset 能量 → 落在拍上能量最强的几下
try:
    yk = librosa.effects.preemphasis(y)
    S = np.abs(librosa.stft(yk))
    freqs = librosa.fft_frequencies(sr=sr)
    band = (freqs >= 40) & (freqs <= 160)
    kick_env = S[band, :].sum(axis=0)
    times = librosa.frames_to_time(np.arange(len(kick_env)), sr=sr)
    strong = []
    for b in beats:
        idx = int(np.argmin(np.abs(times - b)))
        strong.append((float(kick_env[idx]), float(b)))
    strong.sort(reverse=True)
    n = max(2, len(beats) // 8)  # 取约 1/8 的拍作强拍
    strong_beats = sorted(b for _, b in strong[:n])
except Exception:
    strong_beats = [float(b) for b in beats[::8]]

json.dump({
    "t0": t0, "T": T, "bpm": bpm,
    "beats": [float(b) for b in beats],
    "strongBeats": [float(b) for b in strong_beats],
    "duration": duration,
}, open(out, "w"))
