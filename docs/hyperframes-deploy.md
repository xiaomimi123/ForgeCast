# HyperFrames 视频渲染 · 部署与环境

> **现状（2026-08-31，子项目② Remotion 渲染后端）**：五个内置模板（flash/story/demo/insight/changelog）的渲染已改走 **Remotion**（合成组件在 `packages/compositions`）。HyperFrames 仍然承担**自定义模板**渲染与 **Kokoro/Melo/Cosy TTS** 链路，本文其余部分（TTS、字体、espeak、ffmpeg）依然适用。
> **本文「Docker renderer 镜像」一节的验证状态已失效**，见该节开头的醒目提示。

视频引擎最初为 Remotion，中途整体替换为 [HyperFrames](https://github.com/heygen-com/hyperframes)（HTML→headless Chrome + ffmpeg→MP4，本地渲染，Apache-2.0），现在五个内置模板又回到 Remotion。配 Kokoro 离线中文配音。本文记录环境依赖与踩坑。

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

> ⚠️ **状态：Remotion 改造后尚未验证，请勿假定这个镜像还能渲出五模板视频。**
> 下面「已真实构建 + 容器内真渲验证过」指的是 **HyperFrames 时期（2026-08-23）**的镜像。子项目② 把五模板换成 Remotion 之后，**没有重新构建过该镜像、也没有在容器内跑过一次真渲**（本期不要求）。已知的不对齐点：
>
> 1. **镜像里预装的 Chromium 与 `HYPERFRAMES_BROWSER_PATH` 对 Remotion 不生效。** Remotion 4.x **不探测系统浏览器**，只认 `renderMedia({ browserExecutable })` 或它自己下载的 chrome-headless-shell；`packages/studio/src/remotion-render.ts` 当前**没有传 `browserExecutable`**，所以容器首次渲染会在**运行时联网下载** chrome-headless-shell——这与本镜像「构建期烤进所有依赖、运行时不联网」的原则相反。
> 2. **chrome-headless-shell 没有 Linux ARM64 官方构建**（见下方「已知构建/渲染坑」第一条，HyperFrames 时期就是被这条逼着改用 Debian chromium 的）。Apple Silicon 上容器架构是 arm64，这条下载大概率直接失败。
> 3. **阿里云 CN 机器上这类运行时下载是记录在案会挂住的**（见下方 §「CN 网络」与 Kokoro 语音包那条坑）。
>
> 可选出路（**建议，本期未实现、未验证**）：① 在 `Dockerfile.renderer` 构建期跑 `npx remotion browser ensure` 把浏览器烤进镜像层；② 给 `renderMedia` 显式传 `browserExecutable`（指向镜像里已有的 `/usr/bin/chromium`，复用 `HYPERFRAMES_BROWSER_PATH`）。②在 arm64 上更可能成立，因为它不依赖 chrome-headless-shell 的官方构建。
> 自定义模板走的仍是 HyperFrames 路径，理论上不受影响，但同样没有在改造后复验过。

`Dockerfile.renderer` 已把上述依赖全部打进 `node:22-bookworm-slim`：ffmpeg / fonts-noto-cjk / espeak-ng / Bun / Kokoro venv / Chromium（Debian 包）。espeak 数据路径按架构（arm64/amd64）自动探测软链到 `/opt/espeak-data`。**已真实构建 + 容器内真渲验证过（HyperFrames 时期，2026-08-23，Apple Silicon；Remotion 改造后未复验）**。

```bash
# 中文路径需 BUILDKIT=0
DOCKER_BUILDKIT=0 docker build -f Dockerfile.renderer -t forgecast-renderer:latest .
# 或经 compose（renderer profile）
DOCKER_BUILDKIT=0 docker compose --profile render build renderer
```

镜像约 3GB（含 Chromium + Kokoro onnx runtime + 语音包）。

**构建网络要求（重要）**：构建过程要从 Debian/PyPI 拉包。若在开启了透明代理/VPN 的机器上构建，可能遇到：
- apt 报 `Unable to connect to deb.debian.org:80: [IP: 198.18.x.x]`（HTTP 被沉洞）；
- 或 pip 装包报 `Could not find a version that satisfies the requirement`（清华源对部分网络返 403，实测踩过）。

这是**宿主机 VPN 拦截了所有镜像流量**，与 Dockerfile 无关，换任何镜像源都绕不过。解决：关掉透明代理，或直接在**部署目标服务器**（配好国内 apt/pip 源、无 MITM）上构建。Dockerfile 已把 apt 与 pip 都指到**阿里云镜像**（`mirrors.aliyun.com`，清华源在实测环境下 403，阿里云可用）；apt 默认 deb.debian.org，如镜像源又失效可自行改 sed 目标。

**已知构建/渲染坑（真机构建踩过，均已在 Dockerfile 里修复）**：
- **chrome-headless-shell 无 Linux ARM64 官方构建**（Apple Silicon 上容器架构是 arm64）：`hyperframes browser ensure` 会直接报错退出。改用 Debian 的 `chromium` 包 + `HYPERFRAMES_BROWSER_PATH=/usr/bin/chromium` 环境变量。x86_64 服务器理论上 chrome-headless-shell 有官方构建，但既然 Debian chromium 已验证可用，Dockerfile 统一走这条路径，不按架构分叉。
- **`hyperframes` npm 包默认联网拉最新版**：即使命令里 pin 了版本号（`npx hyperframes@0.7.68`），首次调用仍会检查/拉包，容器每次 `docker compose run` 都是一次性实例（`--rm`），意味着**每条视频渲染都要在渲染开始前先联网**。已在镜像构建期 `npm install -g hyperframes@0.7.68` 全局预装，运行时 `npx` 命中缓存不再联网。
- **Kokoro 语音包（~27MB）默认运行时首次下载到 `/root/.cache/hyperframes/tts/voices/`**：这个目录不在任何持久卷里，容器每次都是新实例，意味着**每条视频渲染都要重新下载**，网络稍慢就会撞上 TTS 180s 超时降级成静音占位——**实测踩过：渲染流程全程无报错、视频正常产出，但音轨是静音**（`ffmpeg -af volumedetect` 测出 mean_volume ≈ -91dB 才发现）。已在镜像构建期跑一次 `hyperframes tts` 预热，把语音包烤进镜像层，运行时不再联网。
- **`workspace/<slug>/hf/assets/fonts` 若曾在宿主机上创建过绝对路径软链**（比如本机开发跑过一次），Docker 容器内因为路径不存在会变成"坏软链"——`scaffoldHfProject` 原先用 `fs.existsSync` 判断"已存在跳过"，但坏软链 `existsSync` 返回 `false`，于是尝试 `symlinkSync` 会因为目标已占用而报错，`catch` 分支的 `fs.cpSync` 又会直接把 Node worker 崩掉（`filesystem_error: Operation not supported`）。已修：坏软链先 `rmSync` 清掉，新软链一律用**相对路径**（macOS 下还要对两端 `realpathSync` 再算相对，否则 `/var`→`/private/var` 这类系统级软链会导致层级算错）。
- **默认 600s（10min）渲染超时在低配/容器环境下不够**：本机构建的容器实测单条 flash 视频（92s 成片，2760 帧）渲染耗时约 16 分钟。已加 `FORGECAST_RENDER_TIMEOUT_MS` 环境变量（Dockerfile 里设为 1800000 = 30min），可按机器性能再调。

进容器渲染：
```bash
docker compose --profile render run --rm renderer \
  pnpm exec tsx cli.ts video <slug> --tpl=demo
```
产物落 `workspace/<slug>/videos/`（挂载卷持久）。

**部署提醒：`app`/`renderer` 两个容器共享同一个 `./db` 挂载卷**，Web 设置页存的 `tts_mode`（settings 表）优先级高于容器 `ENV`（见 §"Web 设置页"一节的存储优先级）。若本机开发时已经在设置页把 `tts_mode` 配成了 `melo`/`live`（本机专属路径/云端 key），`renderer` 容器会读到同一条设置，而这些模式在纯净的 renderer 镜像里通常不可用（melo 需要宿主机 venv 路径，容器里没有）——**会 fail-soft 静默降级成静音占位**（视频照常渲染完成，看着一切正常，实际没声音）。渲染前建议在设置页确认 `tts_mode=kokoro`（唯一预装进 renderer 镜像的离线方案），或渲染后用 `ffmpeg -i out.mp4 -af volumedetect -f null -` 抽查 `mean_volume` 是否接近 -91dB（等于静音）。

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

### 字幕真对齐（faster-whisper，`FORGECAST_ASR_PYTHON`）

TTS 合成音频后，若配置了 `FORGECAST_ASR_PYTHON`（或已有 `FORGECAST_MELO_PYTHON`，缺省会自动回落），
会用本地 [faster-whisper](https://github.com/SYSTRAN/faster-whisper)（CTranslate2 重实现的 Whisper）
转写出真实词级时间戳，跟原文做字符级对齐，把字幕/旁白从"按字数估算时长"换成真实语音对齐的时间轴。
**只用 ASR 的时间信息，不用它识别出的文字**——字幕显示内容永远是我们自己生成的原文，识别偶尔认错字
不影响显示、只影响对齐精度；对齐失败（静音、匹配率过低）会静默回落原有估算，不阻断视频生成。

复用 melo 的 venv（装了 melo 就免配置）：

```bash
uv pip install --python ~/.forgecast-venvs/melo/bin/python faster-whisper
export FORGECAST_ASR_PYTHON=~/.forgecast-venvs/melo/bin/python
```

或单独建一个 venv：

```bash
uv venv --python 3.11 ~/.forgecast-venvs/asr
uv pip install --python ~/.forgecast-venvs/asr/bin/python faster-whisper
export FORGECAST_ASR_PYTHON=~/.forgecast-venvs/asr/bin/python
```

模型用 `small`（约 500MB，首次运行自动从 Hugging Face 下载并缓存，无需手动下载步骤），
CPU 上单条几秒到十几秒。不配置这个变量视频照常生成，只是字幕退回估算时间轴。
