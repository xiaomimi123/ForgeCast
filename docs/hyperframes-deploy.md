# HyperFrames 视频渲染 · 部署与环境

视频引擎已从 Remotion 全面替换为 [HyperFrames](https://github.com/heygen-com/hyperframes)（HTML→headless Chrome + ffmpeg→MP4，本地渲染，Apache-2.0）。配 Kokoro 离线中文配音。本文记录环境依赖与踩坑。

## 运行时依赖

| 依赖 | 用途 | 备注 |
|---|---|---|
| **Node 22+** | HyperFrames CLI 要求 | forgecast 进程本身也须跑在 22+ |
| ffmpeg | 视频编码 | |
| Chromium | HyperFrames 自带拉 chrome-headless-shell | `npx hyperframes browser ensure` |
| Bun | HyperFrames 工具链 | |
| Python3 + venv | Kokoro TTS | `kokoro-onnx` `soundfile` `misaki[zh]` |
| espeak-ng | Kokoro 中文音素化 | 有数据路径坑，见下 |
| Noto Sans CJK | 中文字体 | 模板 @font-face 优先用打包字体，回退系统 CJK |

## TTS 模式（`FORGECAST_TTS_MODE`）

- `kokoro`（默认）— 本地 Kokoro 离线中文配音（`zf_xiaobei`），免 key。**机器味重、咬字糊**，仅作兜底。
- `melo` — 本地 MeloTTS 离线中文配音，**明显更自然**，免 key。需单独 venv（见下）。**只有一个女声**。快（RTF 0.23x，一条视频约 8s 配音）。
- `cosy` — 本地 CosyVoice2 零样本克隆，**男声/任意音色**（给段参考音频克隆谁的声音都行）。免 key。**慢**（RTF ~2.75x，一条视频约 90s+ 配音）。需 `FORGECAST_COSY_HOME`（见下）。
- `live` — 中转站 OpenAI 兼容 `/audio/speech`（需 `FORGECAST_TTS_KEY`/`FORGECAST_TTS_MODEL`/`FORGECAST_TTS_VOICE`）。音质最好、音色最全，付费。
- `stub` — 静音占位（测试用）。

选型：**日常批量用 `melo`（快、女声够好）；要男声/特定音色的精品用 `cosy`（慢但灵活）；不想维护本地重模型就 `live`（云端，付费）。**

### MeloTTS 本地配音（`melo` 模式）

MeloTTS 需要一个独立 Python venv（torch 等依赖较重）。`FORGECAST_MELO_PYTHON` 指向该 venv 的 python。

```bash
uv venv --python 3.11 ~/.forgecast-venvs/melo
uv pip install --python ~/.forgecast-venvs/melo/bin/python \
    "git+https://github.com/myshell-ai/MeloTTS.git" "setuptools<80"
~/.forgecast-venvs/melo/bin/python -m unidic download   # ~526MB 词典
export FORGECAST_TTS_MODE=melo FORGECAST_MELO_PYTHON=~/.forgecast-venvs/melo/bin/python
```

**Apple Silicon（M1/M2/M3）必须走纯 CPU**——MeloTTS 的 MPS 路径慢到不可用（实测 163s/句），纯 CPU 反而快（~1.3s/句，RTF 0.23x）。`scripts/melo_infer.py` 已在脚本内 `torch.backends.mps.is_available=lambda:False` 强制 CPU，无需额外配置。

**踩坑（CN 网络 / VPN）**：
- `setuptools<80`——新版删了 `pkg_resources`，librosa 会报 `No module named 'pkg_resources'`。
- `unidic download` 的 526MB 词典若被 VPN 拦，多试几次（可断点续）。
- nltk 数据（`averaged_perceptron_tagger`、`averaged_perceptron_tagger_eng`、`cmudict`）会被 VPN 沉洞（`SSRF attempt to restricted IP 198.18.x`）。从 github 手动取放 `~/nltk_data/`：
  ```bash
  for it in corpora/cmudict taggers/averaged_perceptron_tagger taggers/averaged_perceptron_tagger_eng; do
    curl -sL "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/$it.zip" \
      -o ~/nltk_data/$(dirname $it)/$(basename $it).zip && unzip -oq ~/nltk_data/$(dirname $it)/$(basename $it).zip -d ~/nltk_data/$(dirname $it)/
  done
  ```

字幕 cues 来自文案切句，任何模式下都有字幕。口播脚本的 `【节奏标记】`（画面指示）在配音/字幕前会被 `cleanNarrationText` 去掉。

## 本地开发（macOS）踩坑

1. **Node 版本**：`.nvmrc` 指定 22。用 `nvm install 22 && nvm use 22`。
   - ⚠ **不要用 Node 25+**（系统 homebrew node 可能是 25）：`better-sqlite3` 11.10.0 无对应预编译包、源码编译也失败。
2. **better-sqlite3 原生模块 ABI**：一个二进制只配一个 Node ABI。切 Node 版本后需：
   ```bash
   cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3
   npx prebuild-install --runtime node --target 22.23.1   # 换成你的 node 版本
   ```
   跑测试（若用 Node 20）与真渲（Node 22）之间切换二进制即可。**Docker 里 `pnpm install` 直接编对，无此问题。**
3. **Kokoro 首装**：
   ```bash
   python3 -m venv ~/kokoro-venv
   ~/kokoro-venv/bin/pip install kokoro-onnx soundfile "misaki[zh]"
   brew install espeak-ng
   export HYPERFRAMES_PYTHON=~/kokoro-venv/bin/python
   ESPEAK_DATA=$(brew --prefix espeak-ng)/share/espeak-ng-data
   export ESPEAK_DATA_PATH=$ESPEAK_DATA ESPEAKNG_DATA_PATH=$ESPEAK_DATA PHONEMIZER_ESPEAK_PATH=$(which espeak-ng)
   ```
   - ⚠ 不设 espeak 数据路径会报 `espeak-ng-data/phontab: No such file or directory`（指向 CI 死路径的已知 bug）。
4. **字体**：把 `NotoSansSC.otf`（思源黑体/Noto Sans SC，OFL 可商用）放 `templates/hf/fonts/`。字体二进制已 gitignore，需自行放置。macOS 缺字体时模板会回退系统 PingFang，Docker 回退 fonts-noto-cjk。

## Docker（renderer 镜像）

`Dockerfile.renderer` 已把上述依赖全部打进 `node:22-bookworm-slim`：ffmpeg / fonts-noto-cjk / espeak-ng / Bun / Kokoro venv / chrome-headless-shell。espeak 数据路径按架构（arm64/amd64）自动探测软链到 `/opt/espeak-data`。

```bash
# 中文路径需 BUILDKIT=0
DOCKER_BUILDKIT=0 docker build -f Dockerfile.renderer -t forgecast-renderer:latest .
# 或经 compose（renderer profile）
DOCKER_BUILDKIT=0 docker compose --profile render build renderer
```

镜像约 ~2GB（含 Chromium + Kokoro onnx 模型）。

**构建网络要求（重要）**：构建过程要从 Debian/PyPI 拉包。若在开启了透明代理/VPN 的机器上构建，可能遇到：
- apt 报 `Unable to connect to deb.debian.org:80: [IP: 198.18.x.x]`（HTTP 被沉洞）；
- 或 `Certificate verification failed ... [IP: 198.18.x.x 443]`（HTTPS 被 MITM）。

这是**宿主机 VPN 拦截了所有镜像流量**，与 Dockerfile 无关，换任何镜像源都绕不过。解决：关掉透明代理，或直接在**部署目标服务器**（配好国内 apt/pip 源、无 MITM）上构建。Dockerfile 已加 apt 重试与 `ca-certificates`，pip 用清华源；apt 默认 deb.debian.org，CN 服务器可自行 sed 成阿里云/清华等可达源。

进容器渲染：
```bash
docker compose --profile render run --rm renderer \
  pnpm exec tsx cli.ts video <slug> --tpl=demo
```
产物落 `workspace/<slug>/videos/`（挂载卷持久）。

## 四套模板

| tpl | 用途 | 素材要求 |
|---|---|---|
| `flash` | 纯文字快闪 | 仅文案 |
| `story` | 微信气泡对话（接单/副业） | 仅文案 |
| `demo` | 产品截图轮播（手机外框） | **需 `workspace/<slug>/shots/` 放截图**，无图报错 |
| `changelog` | 代码变更讲解（开发碎片） | 仅文案 |

时长自适应：跟旁白末尾对齐（各模板有下限），旁白多长片子多长，不截断。

### CosyVoice2 本地克隆配音（`cosy` 模式）

CosyVoice2 靠一段参考音频克隆任意音色（含男声），`FORGECAST_COSY_HOME` 指向一个约定结构的目录：

```
$FORGECAST_COSY_HOME/
├── venv/            # py3.11 venv（装了 CosyVoice requirements）
├── CosyVoice/       # clone github.com/FunAudioLLM/CosyVoice（含 third_party/Matcha-TTS 子模块）
├── model/           # CosyVoice2-0.5B（modelscope 下，~5.3G）
├── prompt.wav       # 要克隆的参考音频（换男声就换这个 + prompt.txt）
└── prompt.txt       # 参考音频的转写文本
```

搭建：
```bash
H=~/.forgecast-cosy; mkdir -p $H
GIT_LFS_SKIP_SMUDGE=1 git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git $H/CosyVoice
uv venv --python 3.11 $H/venv
uv pip install --python $H/venv/bin/python "setuptools<80" wheel pip   # 先装，否则 openai-whisper 构建缺 pkg_resources
# 去掉 requirements 里的 cu121 extra-index（Mac 用不上），再关构建隔离装
grep -v "extra-index-url.*cu121\|onnxruntime-cuda" $H/CosyVoice/requirements.txt > /tmp/cosy-reqs.txt
uv pip install --python $H/venv/bin/python --no-build-isolation -r /tmp/cosy-reqs.txt
$H/venv/bin/python -c "from modelscope import snapshot_download; snapshot_download('iic/CosyVoice2-0.5B', local_dir='$H/model')"
# 参考音频：任意 5-10s 清晰人声（男声就放男声），写好转写
cp $H/CosyVoice/asset/zero_shot_prompt.wav $H/prompt.wav   # 自带女声示例，替换成你要的音色
printf '希望你以后能够做的比我还好呦。' > $H/prompt.txt
export FORGECAST_TTS_MODE=cosy FORGECAST_COSY_HOME=$H
```

- **Apple Silicon 强制 CPU**：`scripts/cosy_infer.py` 已 `torch.backends.mps.is_available=lambda:False`。M1 上模型加载 ~10s、合成 RTF ~2.75x。
- **换音色 = 换 `prompt.wav` + `prompt.txt`**（不用改代码/环境变量）。
- `pynini`/`ttsfrd` 在 Mac 装不上没关系——CosyVoice2 用 `wetext` 前端兜底。
