# 做内容视觉重做 + 页内预览 设计

> 日期：2026-08-30　状态：设计待确认
>
> 对标参考：`video-talkcraft`（PolyForm Noncommercial，**仅借鉴方法论，不搬代码**——见 §0.3）

## 0. 背景：诊断是实测出来的，不是推测

用户反馈「生成的视频不好看，整体就不能看，说不上来哪里」。本次没有靠猜，而是把现有成片
（`workspace/ant-design-pro/hf`，insight 横屏模板，61 秒）在 HyperFrames Studio 里逐帧调出来看，
并跑了官方 `check` / `snapshot`。结论分三层。

### 0.1 已被工具确认的缺陷

`npx hyperframes check` 的输出（原文）：

| 级别 | 缺陷 | 原文要点 |
|---|---|---|
| ✗ error | `non_deterministic_code` | 脚本里有 `Math.random()`，「渲染时各帧可能不一致」。来源是解码特效 `DECODE_RUNTIME` 的乱码鬼影字符池 |
| ✗ error | `overlapping_clips_same_track` | Track 2 上「58s 结束的 clip 与 41.9s 开始的 clip 重叠」，官方明示「同轨重叠导致渲染冲突」 |
| ⚠ warning | `studio_missing_editable_id` ×2 | 时间轴元素没有 `id`，「Studio 无法用稳定的编辑目标」 |

第三条直接卡住本次要做的编辑/预览能力：没有稳定 id，用户在预览里点中某个元素也无法稳定回指。

### 0.2 肉眼确认的结构性问题

Studio 里拖到 14s 与 30s，**两帧完全相同**；时间轴上 `InsCard0 0` 单个 clip 横跨约 25 秒。
`snapshot --at 14` 出的真实渲染帧显示：1920×1080 画布上只有右上角一张卡片，**其余约 88% 是空的网格背景**。

根因在模板 CSS 里写死（`templates/hf/insight-landscape.html:18`）：

```css
.card { position: absolute; right: 140px; width: 560px; ... }
```

卡片恒为 560px 宽且贴右，**左侧 1200px 是结构性永久空白**——不是内容不够，是布局如此。
叠加字幕默认关闭（`config.video.captions` 默认 off，`.cap` 不渲染），底部同样空置。

对照 `video-talkcraft` 的「PPT 感四个病根」，当前模板四条全中：无相机层、元素入场即冻结、
场景硬切、只进不出；并且多一条它没列的——**构图本身就是空的**。

### 0.3 已在本 spec 之外修掉的字体缺陷（commit `a32c9dc`）

调查中发现两个字体问题，因与本次改造正交且成本极低，已单独修复并提交：

1. `@font-face` 指向的 `assets/fonts/NotoSansSC.otf` **从未被下载过**（实测 HTTP 404）；
   `templates/hf/fonts/` 里只有一个「请把字体放这里」的 README。
2. 模板用了 **44 处** `font-weight: 700/800/900`，却只声明了一个常规字重的 `@font-face`
   ——所有粗体都是渲染器合成的**伪粗体**，中文笔画糊，且屏幕上最大的标题字全中招。

已下载 Noto Sans SC Regular + Bold（SIL OFL，可商用；`*.otf` 本就 gitignore，仅本地落盘），
拆成 `400` 与 `700 900` 两个字面，并移除 `font-family` 里 HyperFrames 无法解析的
`"Noto Sans CJK SC"` / `"PingFang SC"` 回落。`check` 的字体 error 已消失，
`snapshot` 报 `Fonts: 2 loaded`，真实渲染帧中文粗体已正常。

**关于对标项目的协议**：`video-talkcraft` 是 PolyForm Noncommercial 1.0.0，
「任何商业使用需作者事先授权」，而 ForgeCast 的用途是变现，属商业使用。
其 LICENSE 同时写明「用它做出来的视频归创作者所有」——受限的是工具代码本身。
本 spec **只借鉴其公开方法论（七层镜头模型、反 PPT 诊断口径），不复制其任何代码**；
且技术上也无法复制——它是 Remotion 的 tsx 组件，本项目是 HyperFrames 的 HTML+GSAP。
沿用 dbskill（CC BY-NC）那次的处理纪律。

## 1. 目标

1. 清掉 §0.1 三个已确认缺陷，让 `hyperframes check` 的 lint 降到 0 error。
2. 加**基础运动层**，消灭「整段完全静止」——任意时刻画面至少有一层在动。
3. 重做 insight 模板构图，消除结构性空白。
4. 在「做内容」页内嵌 `<hyperframes-player>`，不渲染就能看到成片效果。

## 2. 非目标

- **不做完整七层镜头系统**。用户明确选择「先修硬伤，再加基础运动」。焦点层、配角层、
  遮罩层、六式运动承接转场、长镜头世界画布**本次全部不做**，留给后续子项目。
- **不做编辑能力**。本次预览是只读的（看 + 播放 + 拖时间轴）。改字幕/改文案/调特效参数
  属于原计划的子项目③，需要先引入「可编辑中间文档」，本次不碰。
- **不引入 HyperFrames Studio**。用户选择页内嵌 player 统一 UI，不跳转到 Studio 的独立端口/独立界面。
- **不改 TTS / ASR / BGM / 卡点 / 渲染管线**。本次只动模板与合成层。
- **不重做全部五个模板的构图**。只重做 insight（问题最严重、已实测）。flash/story/demo/changelog
  只享受第 3 节的基础运动层与缺陷修复，构图维持原样。
- **不给 `apps/web` 引入单测框架**（既定约定，见全局约束）。

## 3. 缺陷修复

### 3.1 解码特效去随机化（`packages/studio/src/hyperframes.ts`）

`DECODE_RUNTIME` 用 `Math.random()` 从字符池挑鬼影字。改为 **seeded PRNG**，
按 HyperFrames 官方建议用 mulberry32：

```js
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;var t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
```

种子取自元素在文档中的稳定序号 + 字符索引（不得用时间/随机），保证同一份 HTML 每次渲染出的
鬼影序列完全一致。验收：`check` 的 `non_deterministic_code` 消失。

### 3.2 消除同轨 clip 重叠

Track 2 上 41.9s 与 58s 的 clip 重叠。需定位到 `build*Sections` 里对应的时间计算
（insight 走 `buildInsightSections`），修正为同轨不重叠——或把其中一个挪到独立
`data-track-index`。**修哪一种由实现者按代码实际结构定**，但必须满足：
`check` 的 `overlapping_clips_same_track` 消失，且各段的可见时间窗语义不变
（不能靠截短内容显示时长来「修」）。

### 3.3 给时间轴元素生成稳定 id

所有带 `data-start` 的元素补 `id`。命名须**稳定且可读**（官方建议 `hero-title` / `scene-1-card` 这类），
由生成器按「模板名-段落角色-序号」拼出，例如 `ins-card-0`、`flash-hook`、`story-bubble-3`。
禁止用随机数或时间戳（否则每次生成 id 都变，编辑器无法回指）。
验收：`check` 的 `studio_missing_editable_id` 消失。

## 4. 基础运动层

目标是消灭「完全静止」，不是做完整镜头语言。只加两样，两样都是纯 transform/opacity
（HyperFrames 允许动的属性白名单内），且必须挂在暂停主时间线 `tl` 上——
**不得用 CSS `@keyframes`**（逐帧 seek 渲染下不随帧走，项目已知铁律）。

### 4.1 相机层（camera rig）

在 `#root` 内、所有 clip 外包一层 `.cam` 容器，对它施加一条**全程连续**的缓慢曲线：

- 整片 `scale` 从 `1.0` 缓推到 `1.06`（`ease: 'none'` 或 `sine.inOut`）
- 叠加极缓的 `x`/`y` 漂移（振幅 ≤ 画布 1.5%）

实现要点与坑：

- 曲线**末键必须落在片长之外**（值随之外推）。末键正好压在片尾时最后 0.8~0.9s 会慢到停死，
  仍会被判静止——这是 talkcraft 文档明确记录的实测坑，直接适用。
- `.cam` 必须是 block 级且有确定尺寸（HyperFrames 对 transform 元素的硬要求）。
- **必须验证包一层 `.cam` 不破坏 HyperFrames 对 `.clip` 的显隐控制**——这是本节最大技术风险，
  实现的第一步就是做这个验证（见 §7 Task 排序）。

### 4.2 idle 微动

元素入场结束后不再冻结：对主体元素加持续微动——`scale ±0.5%`、`y ±3px`，
用两个不可通约频率的正弦叠加，避免同屏元素同相位（按元素序号错开相位）。
GSAP 需用**有限 repeat 次数**（`repeat: -1` 被 HyperFrames 禁止），
按片长算出足够的重复次数。

### 4.3 验收口径

`snapshot --at` 在整片均匀取 ≥6 个时间点，**任意相邻两帧不得逐像素相同**。
当前实测 14s 与 30s 完全相同，是本节要消灭的状态。
（注：HyperFrames `check` 的 Motion 段对此不报错——实测当前这条 25 秒静止的片子
Motion 仍是 `0 errors`，所以**不能拿 Motion 段当验收依据**，必须用 snapshot 逐帧比对。）

## 5. insight 构图重做

只改 `insight.html` / `insight-landscape.html` 的版式与 `buildInsightSections` 的排布，
不改数据来源（仍是 TTS cue 驱动的卡片累加）。

版式设计本身需要看着效果调，所以**本节的实现顺序排在页内预览之后**（见 §7），
让实现者能边改边看。以下是必须满足的硬约束，不是风格建议：

1. **主内容区占比下限**：承载卡片的内容区宽度 ≥ 画布宽度的 55%（当前是 560/1920 ≈ 29%）。
   卡片不得再恒定 `right: 140px` 贴边。
2. **同屏卡片数 2~3**：insight 的设计语义本就是「卡片按 TTS cue 逐句累加」，
   但实测只有 1 张长期驻留。要求任意时刻同屏卡片在 2~3 张之间——
   低于 2 则画面空，高于 3 则凌乱（借鉴 talkcraft 的同屏预算口径）。
   超过 3 张时最旧的一张必须真退场（缩小+降透明度移出），不是无限堆叠。
3. **单卡驻留上限 8 秒**：当前单个 clip 横跨 25 秒。超过 8 秒必须有新卡进场或旧卡退场。
4. **留白锚**：保留至少一个空象限，但不允许「内容缩在一角、其余三面全空」——
   当前状态（内容占右上角约 12%）正是要消灭的。
5. **hero 唯一**：同屏多张卡时，只有一张享受主视觉造型（大字号/高亮色），
   其余降为次级样式，避免互相抢戏。
6. 竖屏（`insight.html`）与横屏（`insight-landscape.html`）**各自独立成立**，
   不共用一套绝对定位数值——两者画布比例差异过大，一套数值必有一边不成立。

验收以 §8 的 `snapshot` 抽帧人工核对为准（构图好坏无法自动断言）。

## 6. 页内预览

在「做内容」页嵌入 `<hyperframes-player>`，只读预览当前项目最新合成的 `hf/index.html`。

### 6.1 播放器：自己写，不用官方 player

调查中实测了官方 `<hyperframes-player>`（`hyperframes play` 服务的页面用它），
结论是**不采用**，理由是它的 `_injectRuntime()` 会往 iframe 注入

```
https://cdn.jsdelivr.net/npm/@hyperframes/core@0.7.68/dist/hyperframe.runtime.iife.js
```

——**运行时从公网 CDN 拉取**。ForgeCast 是明确的「本机运行、数据不出 localhost」工具，
不应为一个只读预览引入公网依赖与离线不可用。

改为自己实现，成本很低：合成产物本来就在 `window.__timelines[<composition-id>]` 上暴露
一条**暂停的 GSAP timeline**，而 GSAP timeline 自带 `play()` / `pause()` / `seek()` /
`time()` / `duration()`——官方 player 判定时间线用的正是这五个方法的鸭子类型检测，
说明这套接口足以驱动播放。

实现：`<iframe>` 加载 §6.2 的合成产物路由（同源，父页面可直接访问 `iframe.contentWindow`），
自写播放/暂停/进度条，调用上述方法。播放靠 `requestAnimationFrame` 推进 `seek()`，
不依赖任何第三方播放器文件。

已知取舍：官方 player 的成熟功能（倍速、全屏、缓冲态处理等）需要自己补，本次只做
播放/暂停/拖动三件事，够用即可；若后续证明不足，`<hyperframes-player>` 仍是可回退选项。

### 6.2 合成产物的 HTTP 路由

新增只读路由把 `workspace/<slug>/hf/` 暴露给浏览器。

**必须处理的坑（已实测）**：`workspace/<slug>/hf/assets/fonts` 是指向 `templates/hf/fonts` 的
**软链，指向服务根目录之外**。HyperFrames 自己的 play 服务器对它返回 **403**（拒绝跟随软链）。
渲染器不受影响（`snapshot` 报 `Fonts: 2 loaded`，渲染器直接读盘），但**我们的 HTTP 路由会踩到**。

处置：路由解析真实路径（`fs.realpathSync`）后，校验其落在**两个白名单根之一**内——
`workspace/<slug>/hf/` 或 `templates/hf/fonts/`——落在外面一律 403。
不要简单地「允许跟随软链」（等于开路径穿越）；也不要改成复制字体
（每个项目多 17MB，且项目数会增长）。

### 6.3 已知限制（写进 UI 文案，不藏着）

`workspace/<slug>/hf/` 是**每个项目一份、每次生成覆盖**（`hfDir` 路径固定，与模板无关）。
因此预览的永远是**该项目最近一次生成的那条**，不是任意历史成片。
本次不改这个结构（改成按视频分目录属于编辑器子项目的前置工作），但 UI 上必须说清楚
「预览的是最近一次生成的合成产物」，避免用户以为在预览某条选中的历史视频。

## 7. 实施顺序与风险

Task 1 必须是 **§4.1 相机层的可行性验证**：手工在一份现有 `hf/index.html` 上包 `.cam` 并加曲线，
跑 `check` + `snapshot`，确认不破坏 clip 显隐、不触发新 lint。
**这个验证不过，第 4 节整体要换设计**（退回到「对每个 clip 内部元素单独加持续微动」，不做全局相机）。
这是本 spec 唯一的未验证技术假设，所以排第一——失败要在投入之前暴露，不是之后。

其余顺序：

1. §4.1 相机层可行性验证（spike）
2. §3 三个缺陷修复（3.1 去随机 / 3.2 clip 重叠 / 3.3 稳定 id）
3. §6 页内预览（含 §6.2 路由与软链 403 处置）
4. §4 运动层落地（相机层 + idle 微动）
5. §5 insight 构图重做

**预览（3）排在运动层与构图（4、5）之前是刻意的**：这两项都需要反复看效果才能调准，
而当前唯一的查看方式是几分钟一轮的完整渲染。先把预览做出来，后两项的迭代成本从分钟级降到秒级。

## 8. 测试与验收

- **后端逻辑**（`packages/studio`）：vitest。`hyperframes.ts` 里新增的纯函数
  （seeded PRNG、id 生成、相机曲线关键帧计算、idle 相位错开）都要有单测。
- **合成产物**：`npx hyperframes check` 在 workspace 样例上 **lint 0 error**
  （warning 允许保留但要在报告里列出）；`snapshot --at` 取 ≥6 点，相邻帧不得逐像素相同。
- **前端**：按既定约定人工浏览器验收（`apps/web` 无单测框架）。
- **回归**：`pnpm test` 全绿（需 Node ≥22，本机 nvm 默认 20 会因 better-sqlite3 ABI 假红；
  `packages/studio` 的 `tts.test.ts` 与 `packages/rebrand` 的 `kill-port`/`screenshot` 是已知并行满载 flake，
  单独重跑必绿，不算回归）。
- **真渲染**：本 spec 的验收**不要求跑完整 MP4 渲染**（一轮数分钟且烧 TTS 额度），
  以 `check` + `snapshot` 为准；但合并前须至少真渲一条确认没有只在完整渲染才暴露的问题。
