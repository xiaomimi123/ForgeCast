# HyperFrames 主视频流水线（全面替换 Remotion）设计

> 日期：2026-07-24　状态：设计已确认，待实施
>
> 大 pivot：把视频引擎从 Remotion 全面替换为 [HyperFrames](https://github.com/heygen-com/hyperframes)（HeyGen 出品，Apache-2.0，HTML→headless Chrome + ffmpeg→MP4，本地渲染）。经真机试跑验证：中文渲染、Kokoro 离线中文配音、代码编辑风成片均通（见会话记录）。

## 决策依据

用户看过真机试跑成片后拍板：HyperFrames 效果优于现有 Remotion，尤其配音（Kokoro 离线中文声 `zf_xiaobei`）。要求全面替换、整份计划一次排完。

已确认的四个方向：
1. **接入方式：混合** — 参数化模板打底自动出片为主线，留 agent 微调入口（本期只留缝不建自动化）。
2. **图片：两个都要** — demo 画面本身要润色 + 产品截图要能嵌入。
3. **范围：全面替换 Remotion**，分阶段但一次排完。
4. **配音：Kokoro 默认 + 中转站可切换**。

## 架构骨架

核心不变，换引擎在内部。`generateVideo(ctx, input)` 函数签名、CLI `forgecast video`、server 视频路由全不动。内部流程：

```
1. 读 analysis/copy 数据（同现在）
2. 数据填进 HyperFrames HTML 模板 → 写 workspace/<slug>/hf/index.html
3. Kokoro/中转站 生成 narration.wav（新 TTS 层，模式可切）
4. 文案切句生成字幕 cues（同现在，不依赖 TTS）
5. spawn `hyperframes render` → MP4
6. 落 asset 行（同现在）
```

**模板填充沿用仓库既有套路**：`templates/hf/<name>.html` 带 `{{slot}}`，读文件 + 字符串替换（同 `copywriter/src/cover.ts` 的 `buildCoverHtml` 填 `{{shot}}`）。不引入新机制。

### 4 套 HyperFrames 模板

| 模板 | 用于 | 画面 |
|---|---|---|
| `demo` | 产品演示（pain/infogap 钩子）· 配比 60% | 钩子→痛点→**产品截图轮播（手机外框）**→报价锚点→CTA。吸收原 A2 截图嵌入 |
| `story` | 接单故事/副业（story/sideline 钩子）· 20% | 气泡对话 + 卖点 + CTA |
| `changelog` | 开发过程碎片 · 20% | 标题→变更统计→代码 diff→品牌。**新增**，试跑已验证 |
| `flash` | 轻量快闪 | 纯文字动效，保留作低成本选项 |

### CJK 字体打底

check 会警告 `font_family_without_font_face`：CJK 字体不在 HyperFrames 自动解析表内。模板用 `@font-face` 指向随仓库打包的 Noto Sans CJK SC（放 `templates/hf/fonts/`），不靠宿主系统字体。保证本地与 Docker 渲染结果一致，一次性消除豆腐块风险。

### Remotion 全退役

`packages/studio` 包名保留，内部替换：删 `src/remotion/*`、`src/render.ts`（Remotion 版）、`package.json` 的 `@remotion/*` + `react`/`react-dom` 依赖；换成 HyperFrames 渲染调用（spawn CLI）+ 模板填充。

### agent 微调（留缝不建）

参数化路径是主线。agent 路径 = 「打开 `workspace/<slug>/hf/index.html` 手改再重渲」，设计上不堵死（每个视频有独立 hf 项目目录），本期不建自动化。

## TTS 层

新 `packages/studio/src/tts.ts`，`FORGECAST_TTS_MODE` 从 `stub|live` 扩为三档：

- `kokoro`（默认）— spawn 本地 Kokoro（`hyperframes tts` 或直调），中文 `zf_xiaobei`。渲染环境需 Python venv + kokoro-onnx + soundfile + misaki[zh] + espeak-ng。
- `live` — 中转站 OpenAI 兼容 `/audio/speech`（现有实现保留）。
- `stub` — 静音占位 WAV（测试用，同现在）。

字幕 cues 仍来自文案切句，任何模式下都有字幕。缺 key/依赖时的降级说明沿用现有 `modeNotes` 机制（可见降级，不静默）。

`config.ts` 的 `TtsMode` 类型加 `'kokoro'`；`loadConfig`/`normalizeModes` 相应处理。

## Docker

更新 `Dockerfile.renderer`（或并入 app 镜像）：Node 22+ / Bun / hyperframes（自带拉 chrome-headless-shell）/ ffmpeg / Python3 + venv(kokoro-onnx, soundfile, misaki[zh]) / espeak-ng（设 `ESPEAK_DATA_PATH` 等 3 个环境变量）/ Noto Sans CJK 字体。

镜像比现在重（~1.8GB+），这是全离线出片的代价。构建按既有经验用 `DOCKER_BUILDKIT=0`（中文路径）+ 国内 apt/npm/pip 镜像源（否则 ffmpeg/依赖构建会卡）。Kokoro 首次装有 espeak-ng 数据路径的坑（`espeak-ng-data/phontab` 指向 CI 死路径），需 `brew/apt install espeak-ng` 并设 `ESPEAKNG_DATA_PATH`/`ESPEAK_DATA_PATH`/`PHONEMIZER_ESPEAK_PATH`——试跑已趟通，写进部署文档。

## 测试策略

沿用仓库既有做法（前端/渲染无法纯单测的，靠 stub + 真渲人工验）：

| 层 | 怎么测 |
|---|---|
| 模板填充函数 | 纯函数单测——slot 填对、HTML 转义、缺字段兜底（同 `props.ts`/`cover.ts`） |
| TTS 层 | 模式切换 + stub 离线可测；kokoro/live 真跑另标 |
| 渲染 | `FORGECAST_VIDEO_MODE=stub` 写占位可测；真渲靠 ffprobe + 抽帧人工验 |
| 端到端 | 每套模板真渲一条，抽帧看中文/画面 |

## 分阶段（写计划时展开）

1. **核心引擎** — HyperFrames 项目脚手架 + render 调用封装 + CJK 字体打底 + `changelog` 模板接进 `generateVideo` + Kokoro TTS 模式。端到端跑通（最薄一条先立起来）。
2. **TTS 层完整** — kokoro/live/stub 三档可切 + 降级说明 + 字幕对齐。
3. **demo 模板** — 含产品截图轮播 / 手机外框（横图回落居中缩放+虚化背景）。
4. **story + flash 模板**。
5. **Docker 镜像** — 全依赖打包，`DOCKER_BUILDKIT=0` 真构建验证。
6. **删 Remotion + 清理 + README/部署文档**。

阶段 1 即「最薄端到端切片」，先证明整条链成立，再逐层往上铺，每步可验证、不推翻重来。

## 已知非纯代码成本（诚实标注）

- **Kokoro 首装** 有 Python venv + espeak-ng 数据路径的 yak-shaving（试跑已趟通，写进部署文档）。
- **Docker 镜像** 需真构建验证（`DOCKER_BUILDKIT=0` + 国内源），镜像变重。
- **每套模板** 需真渲人工验画面，参数需看真片回调（运镜幅度、停留时长）。
- **CJK 字体** 需在 Docker 与本地都确认非豆腐块（@font-face 打底后应稳）。

## 不做

- agent 微调自动化（本期只留缝）。
- 视频里的转场/贴纸/滤镜等超出四套模板既定画面的花活。
- 多语种配音（Kokoro 支持但本期只中文）。
- 保留 Remotion 作 fallback（全面替换，不留双引擎）。
