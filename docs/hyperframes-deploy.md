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

- `kokoro`（默认）— 本地 Kokoro 离线中文配音（`zf_xiaobei`），免 key。
- `live` — 中转站 OpenAI 兼容 `/audio/speech`（需 `FORGECAST_TTS_KEY`/`FORGECAST_TTS_MODEL`）。
- `stub` — 静音占位（测试用）。

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
