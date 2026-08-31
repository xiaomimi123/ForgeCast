# Remotion 渲染后端设计（做内容重构 子项目②）

> 日期：2026-08-31　状态：设计已确认，待写实施计划
>
> 上游依赖：子项目①「VideoSpec 素材包」（已合入 main，HEAD `9affff7`）。①把视频生成拆成
> 语义层 `semantic.ts` → 单向下沉 `lower.ts` → 表现层 `Layer[]` → `render-html.ts` 出 HTML，
> 其中 `VideoSpec` 被刻意做成**渲染器无关**的中间层，正是为本子项目准备的换点。

## 1. 目标与非目标

**目标**：把固定五模板（flash/story/demo/insight/changelog）的渲染后端从 HyperFrames 换成
Remotion，并把预览改造为实时预览。

**明确的非目标（用户已确认）**：

- **不改视觉**。五模板忠实搬运，产出与现在等价。用户的真实痛点是「视觉效果不好看」，但那要在
  ③剪辑台里逐帧看着调才高效；②的验收标准是**「没弄坏东西」**，不是「变好看了」。
  这一条必须写死：②做完视频看起来和现在几乎一样是**预期结果**，不是失败。
- **不建合成功能**。只打通「图层可以叠在视频素材之上」的架构能力，真人口播/数字人/绿幕留给④。
- **不迁自定义模板**。LLM 生成模板那一支（`custom-template.ts`，产出 HyperFrames 格式 HTML）
  留在 HyperFrames 上，另起一份 spec 迁到 LLM 生成 TSX。**故②做完 HyperFrames 不退场。**
- **旧成片不迁移**。已渲好的 mp4 与其 spec 原样保留；切换点之后新生成的走 Remotion。

## 2. 为什么换（以及为什么这次不会重蹈覆辙）

仓库 2026-07-24 曾从 Remotion 全面迁到 HyperFrames，理由有二：①用户看过真机成片认为
HyperFrames 观感更好；②Kokoro 离线中文配音。现在换回来，必须先说清这两条为何不再成立：

- **观感理由已被经验推翻**：用户实际使用后的评价是「视觉效果不好看，整体就不能看」。当初的
  比较结论没有保持住。
- **配音理由不成立**：`runKokoroTts` 的实现是 spawn `hyperframes tts <text> --output x.wav`
  ——一个**独立 CLI 子命令**，不需要项目目录、不参与渲染管线。换渲染器不影响配音，②之后继续
  这样调用。这一点是本次设计的前提，已在代码中核实（`hyperframes.ts` `runKokoroTts`）。

**换的真实收益**（用户选择 Remotion 的理由）：Studio 时间轴可逐帧拖动，调动效的反馈回路从
「渲染 3 分钟再看」变成即时；以及把动效贴到已有视频素材上是 Remotion 的原生能力。

**风险认知**：换引擎本身不改善观感。若②之后用户仍不满意，那是③的工作，不应据此判定②失败。

## 3. 架构：抽独立的纯 React 包

新增 `packages/compositions`——**纯 React，零 Node 依赖**（不得 import sqlite/fs/child_process）。

存在两个消费方，这是抽包的唯一理由：

```
VideoSpec ──┬──> @forgecast/compositions ──> packages/studio: renderMedia() ──> mp4
            └──> @forgecast/compositions ──> apps/web: <Player>            ──> 实时预览
```

若把组件放进 `packages/studio`，`apps/web` 打包预览时会把 `better-sqlite3` 等 Node 依赖拖进
浏览器产物。抽包是硬性要求，不是洁癖。

**渲染与预览共用同一组件、同一份 spec**，故不存在「预览与成片不一致」这一类 bug。

### 3.1 VideoSpec 类型的归属（必须明确，否则会把 Node 依赖拖进浏览器包）

`VideoSpec` 等类型**留在 `packages/studio/src/videospec.ts` 不动**；`packages/compositions`
以 **`import type` 方式**引用（类型导入在编译期擦除，不产生运行时依赖），studio 作为其
`devDependency` 仅供类型解析。

**硬约束**：`packages/compositions` 对 `@forgecast/studio` **不得有任何值导入**，只能 `import type`。
一个值导入就会把 `better-sqlite3` 等 Node 依赖拖进 `apps/web` 的浏览器产物并炸掉构建。
此约束须有测试或 lint 保障，不能只靠约定。

## 4. VideoSpec → Remotion 映射

形状与 `render-html.ts` 现有的图层遍历一致，只是出口不同。**时间仍然只存在于 `spec.layers`
一个地方，组件不得自行计算/推导/吸附任何起止时间**（这是①确立的分层原则，②继续遵守）。

| VideoSpec | Remotion |
|---|---|
| `layer.start` / `layer.duration` | `<Sequence from={round(start*fps)} durationInFrames={round(dur*fps)}>` |
| `layer.track` | z-index / 渲染顺序 |
| `content.kind` | 分支渲 `text` / `caption` / `image` / `video` |
| `layer.effects` | 由 `useCurrentFrame()` 逐帧计算 |
| `spec.canvas` | `<Composition width height>` |
| — | **fps = 30（必须显式设定）** |

**fps 已实测确认**：现有成片为 1080×1920 @ 30fps（HyperFrames 用其默认值，未显式传参）。
Remotion 必须显式设成 30，否则卡点与既有基线全部错位。秒转帧的舍入漂移 <17ms，远低于
BGM 卡点既有的 3 帧容差（详见 `2026-07-24-bgm-beat-sync` spec）。

**逐字解码效果的实现变化**：HyperFrames 下受限于 seek 渲染模式无法逐帧改 `textContent`，
现有实现是用透明度叠层绕开（见 `injectAudioCaptions` 注释）。Remotion 是逐帧函数式渲染，
可直接按帧算出该显示几个字。**观感保持一致，实现从「绕过限制」改为正常写法**。

## 5. 音频与卡点：不动

- **旁白**：`<Audio>` 进合成。
- **BGM 与强拍音效**：**仍用现有 ffmpeg 后混**（`mixAudio`），不搬进 Remotion。理由是那套
  三级 fail-soft（无曲库 / 节拍分析失败 / 混音失败，三条都降级不崩）是真跑验证过的资产，
  没有理由在换引擎的同时重写它。
- **卡点**：切点时间已固化在 `spec.layers` 的 `start` 中（①已完成），秒转帧即可，无需重跑 librosa。
- **TTS**：继续 spawn `hyperframes tts`，与渲染解耦。

## 6. 预览：@remotion/player

`apps/web` 嵌 `@remotion/player`，`inputProps` 喂 spec JSON。

**现有预览机制会被完整替换**：当前 `PreviewTab.tsx` 是把合成 HTML 塞进 iframe、父页面直接驱动
其中暂停的 GSAP 主时间线（`window.__timelines`）。这套机制是 HyperFrames 独有的，Remotion 下
既无 HTML 产物也无 GSAP 时间线，必须重做。

**对③剪辑台的回报**：实时预览意味着「改一下立刻看到」，而非每改一次等一轮渲染（容器内实测
单条 flash 约 16 分钟）。这是②顺带产出的、对③价值最大的一块。

**向后兼容**：`spec_path` 为 NULL 的历史素材（①遗留，见该 spec）在 Remotion 预览下同样无法
定位，沿用现有的「没读到合成时间线」空状态，不崩不白屏。

## 7. 合成能力留缝

`LayerContent` 增加 `video` 类型：

```ts
| { kind: 'video'; src: string; trimStart?: number; trimEnd?: number; volume?: number }
```

组件渲成 Remotion `<Video>`。**本期只打通类型定义与渲染路径，并补一个「文字图层叠在视频图层
之上」的测试证明架构成立**；不建口播/数字人/绿幕任何具体功能，不改 `lower.ts` 去产出 video 图层
（那需要素材上传流程，属④）。

## 8. 验收门禁

**本节是本 spec 最重要的部分。** ①的等价门禁只比对 clip 的 id/start/duration/track/twCount/
accentCount，结果 6 个内容回归里 **5 个**（解码动效全丢、品牌名跨五模板丢失、字幕类丢失、
图片路径编码丢失、编码函数选错）**全部由人工与评审发现，测试一个没抓到**——因为指纹看不见
cssClass、文本内容、src 与 DOM 嵌套。

②不得重蹈覆辙，且②的产物**不可能与 HyperFrames 逐像素相同**（不同渲染器、不同字体光栅化），
故像素/SSIM 比对既脆弱又会给出假绿（①中已有一次「相邻帧不相同」的空洞判据在坏产物上照样通过
的先例）。门禁定为三层：

1. **图层级内容断言（主闸）**：复用①已有的 7 组 fixture 及其图层时间，在指定帧渲染组件，断言
   **应出现的文本、类名、图片路径确实存在于 DOM 中**。直接对准五次咬到我们的失效模式。
2. **合成契约测试**：每模板在给定时长下 `durationInFrames`、画布尺寸、图层数量正确。
3. **真渲人工验收**：五模板各出一条真片，抽帧看 + 验音轨。

**对第 3 层的硬性要求**：验收项必须包含**能区分正确产物与错误产物的属性**。本项目已两次被
「看着通过实则失败」的检查骗过——`<audio>` 位置错误导致的静音（视频照常渲出、进度条走完、
零报错，只有音轨是空的，靠 `ffmpeg volumedetect` 测出 −91dB 才发现）、预览器硬编码 16:9 裁切
竖屏产物（「有画面/能播/拖动跟手」在被裁切的产物上全过）。故本层必须显式验：
`volumedetect` 均值不是 −91dB 静音特征、`ffprobe` 分辨率为 1080×1920、抽帧目视无内容丢失。

**门禁自身必须被证明会失败**：新增门禁后须做一次变异实验（故意删掉一处内容 → 确认测试变红
→ 还原），证明其非空转。①中的变异实验分别抓出过「门禁恒真」与「测试写松」两类问题。

### 8.1 `render-html.ts` 与①的等价门禁在②期间保留

五模板搬到 Remotion 后，`render-html.ts` 与①的 `equivalence.test.ts` 不再服务于生产路径。
**但②期间必须保留它们，不得删除。**

理由：`lower()` 是**两个渲染器共用**的层。①的等价门禁比对的是 `lower()` 经 `render-html.ts`
的产出与改造前 `build*Sections` 的一致性——只要它还在，任何对 `lower()` 的意外改动就会立刻
暴露。②要新建 Remotion 组件、极可能顺手动到 `lower()`，此时失去这道网风险极高。

保留的代价仅是多跑一组测试；删除的代价是共享层失去回归保护。**何时退役由③或更后的子项目
决定，不在②的范围内。**

## 9. 已知成本与风险（诚实标注）

- **两套渲染器并存**：E（自定义模板）未迁，那支继续走 HyperFrames。②完成 ≠ HyperFrames 退场。
- **Docker renderer 镜像需重新验证**：现镜像为 HyperFrames 预装 Chromium 并用
  `HYPERFRAMES_BROWSER_PATH` 指定；Remotion 有自己的 Chromium 获取逻辑。上次构建该镜像踩过
  「chrome-headless-shell 无 Linux ARM64 官方构建」的坑（见 `docs/hyperframes-deploy.md`），
  Remotion 下需重新趟一遍。**本期不要求 Docker 通过**，但须在文档中标注状态。
- **bundle 耗时**：`bundle()` 每次渲染都跑会显著拖慢，需缓存 bundle 目录、仅在组件变更时重建。
- **历史实现参考价值有限**：`1431fb9^` 可翻出旧 Remotion 实现（Flash 44 行 / Story 49 /
  Demo 60 / Root 34 / Subtitles 17 / render.ts 27，共约 230 行）。当年真渲验证过，但现有
  HyperFrames 模板已长出逐字解码、5 套科技背景、强拍脉冲及 insight/changelog 两个新模板，
  丰富度远超旧版。**旧代码只在打包/渲染接线上有参考价值**（`bundle({publicDir})` 与组件内
  `staticFile(src)` 的配合——`renderMedia` 不接受 publicDir，只有 bundle 接受），
  **不是可恢复的实现**。
- **字体**：CJK 字体在 Remotion 下同样需处理；`templates/hf/fonts/*.otf` 仍是 gitignore 的，
  故新鲜检出中不存在，`@font-face` 需保留 `local()` 回落。

## 10. 全局约束（写进实施计划）

- **不改视觉**：五模板产出与现在等价；任何「顺手优化一下版式」都属越界。
- **时间只存在于 `spec.layers`**：组件不得计算/推导/吸附起止时间。
- **fps 固定 30**，显式设定。
- **`packages/compositions` 零 Node 依赖**。
- **不动 `build*Sections`**（`hyperframes.ts` 内，自定义模板与旧路径仍依赖）。
- **不动 `mixAudio` / `analyzeBeats` / `runKokoroTts`** 的既有 fail-soft 行为。
- 测试须 Node ≥22（`nvm use 22.23.2`），否则 `better-sqlite3` ABI 报假错。
- `apps/web` 无测试框架（`"test": "echo 'web: 人工验收，无单测'"`），此为项目约定，不得新增。
- **禁止 `pkill`/`killall` 等广谱杀进程**：用户 dev server 跑在 5173/4321，曾被此类命令整套杀掉。
- 提交信息不带 Co-Authored-By trailer。

## 11. 交付形态

- 新包 `packages/compositions`（组件 + 内容断言测试）
- `packages/studio`：新增 Remotion 渲染路径，替换五模板的 `renderHyperframes` 调用
- `apps/web`：`PreviewTab` 改用 `@remotion/player`
- 文档：更新 README 与部署文档中渲染引擎相关的描述
