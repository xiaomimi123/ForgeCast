# 口播合成（子项目④第一期 talk 模板）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 talk 模板：上传口播当底层视频 + 动效层 + 手动字幕，剪辑台 trim/打字幕/调时间，Remotion 渲成品。

**Architecture:** schema 给 video 类型补 `trimStart/trimEnd/volume`，compositions 用 `<Sequence>+startFrom` 渲（顺带还②的起播债）；studio 新增 `lowerTalk`（Remotion-only，不产 HF html，大文件软链零拷贝）；editing 新增 `trimVideoLayer/addCaptionLayer` 纯函数；web 加出片入口与剪辑台 talk 配套。

**Tech Stack:** 同③；ffprobe（时长）；软链复用②验证过的 bundle copy-dir 行为。

**Spec:** `docs/superpowers/specs/2026-09-06-talk-composite-design.md`

## Global Constraints

- **①②门禁全绿红线**：`equivalence.test.ts`（talk 不进它，五模板零改动）、compositions 内容断言。红了查自己不改基线。
- `apps/web` 无测试框架不得新增；可测逻辑进 editing/studio/server。
- editing/compositions 零 Node 依赖守卫保持；对 studio 只 `import type`。
- 不动 `mixAudio/analyzeBeats/chooseBgmPath/upload 流程` 本体；五模板的 lower 分支零改动。
- 测试 Node ≥22 且 nvm 与命令**同一次 shell 调用内**：`export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 22.23.2 && npx pnpm test`。
- **禁止 `pkill`/`killall`**（用户 dev server 在 5173/4321）；自起进程按 PID 关；浏览器自验一律临时 workspace+独立 db。
- 提交不带 `Co-Authored-By`。已知无关：`hyperframes.test.ts:591` tsc 错、`rebrand/kill-port`+`studio/tts` 并行 flake。

## 文件结构

```
packages/studio/src/videospec.ts        改：video content 加 trimStart/trimEnd/volume
packages/studio/src/lower.ts            改：lowerTalk 分支（五模板分支零改动）
packages/studio/src/generate.ts         改：talk 管线分支（软链/不产 html/ffprobe）
packages/server/src/app.ts              改：/video 路由 talk 校验
packages/editing/src/ops.ts 或新文件     改：trimVideoLayer/addCaptionLayer
packages/compositions/src/LayerView.tsx 改：<Sequence>+startFrom+volume
packages/compositions/src/styles/talk.css + all.css 注册
packages/compositions/test/fixtures/    改：talk fixture + 覆盖守护
apps/web/src/pages/workshop/editor/InspectorPane.tsx  改：出片参数 talk+口播下拉；视频层 trim/volume 字段
apps/web/src/pages/workshop/editor/{TimelinePane,ShotList,EditorPage}.tsx  改：trim 拖拽/加字幕/talk 字幕可拖
```

---

### Task 1: schema 字段 + compositions `<Sequence>` 渲染

**Files:**
- Modify: `packages/studio/src/videospec.ts`（video content 三个可选字段+注释）、`packages/compositions/src/LayerView.tsx`
- Test: `packages/compositions/test/video-layer.test.tsx`（更新断言——②当年断的是裸 `<Video>`，本次是**预期更新**非弱化，spec §6 已声明）

**Interfaces:**
- Produces: video 图层渲为 `<Sequence from={secToFrames(layer.start)} durationInFrames={secToFrames(layer.duration)}><Video startFrom={secToFrames(trimStart ?? 0)} endAt={trimEnd? secToFrames(trimEnd):undefined} volume={volume ?? 1} muted src=encodePathForUrl(src)/></Sequence>`
- mock 扩展：video-layer/narration/contract 测试的 `vi.mock('remotion')` 加 `Sequence: ({children,...p}) => <div data-testid="seq" data-from={p.from} data-dif={p.durationInFrames}>{children}</div>`

- [ ] **Step 1: 写失败测试**（video-layer.test.tsx 重写三条+新增）：
```tsx
it('视频图层包 <Sequence>：from/durationInFrames 来自 layer 时间', …)   // seq 的 data-from=secToFrames(start)
it('trimStart/volume 透传 startFrom/volume；缺省 0/1', …)
it('trimEnd 透传 endAt；缺省不传', …)
it('start>0 的视频图层不再从片源 0 秒起播（②Task 8 遗留还债）——断言 Sequence.from 正确', …)
it('路径仍走 encodePathForUrl（与图片同函数）', …)                       // 既有断言保留
it('文字叠视频 zIndex 断言', …)                                          // 既有保留
```
- [ ] **Step 2: 确认失败 → Step 3: 实现 →（compositions 全绿 + studio 全绿含 equivalence——schema 只加可选字段）→ Step 4: 提交** `git commit -m "feat(compositions): 视频图层 Sequence+trim+volume——还掉起播债"`

---

### Task 2: editing — `trimVideoLayer` + `addCaptionLayer`

**Files:**
- Create: `packages/editing/src/video-ops.ts`；Modify: `src/index.ts`
- Test: `packages/editing/test/video-ops.test.ts`

**Interfaces（签名固定，T7 按此装配）:**
```ts
export function trimVideoLayer(spec: VideoSpec, layerId: string, edge: 'start' | 'end', deltaSec: number): VideoSpec
// 目标必须是 kind video，否则 throw；edge='start'：trimStart+=δ 且 duration−=δ（start 保持不变）；
// edge='end'：trimEnd−=δ 语义上等价 duration−=δ（trimEnd = (trimStart??0)+新duration）；
// 联动 spec.durationSec = 视频层新 duration；越界动效层钳回（duration 超出的截短、start 超出的贴末尾、
// 完全落在界外的图层 duration 钳到 0.2 贴末尾——不删层，用户可再拉回）；
// 钳制下限：视频层 duration ≥ 0.2s；trimStart ≥ 0；无操作返回同一引用；置 overridden:true
export function addCaptionLayer(spec: VideoSpec, tSec: number, text: string): VideoSpec
// 新建 { id: 'cap-manual-<n>' 唯一, kind:'caption', from:null, overridden:true,
//   start:clamp(tSec,0,durationSec-1), duration:min(2.5,durationSec-start), track:字幕轨 track 号,
//   content:{kind:'caption',text}, style:{cssClass:'cap'}, effects:[] }
// track 取既有 caption 图层的 track（无则取 max(track)+1）；同轨重叠时向后顺延起点（复用 moveLayer 的钳制思路）
```
- [ ] **Step 1: 失败测试**（清单）：trim start/end 各自语义与联动 durationSec；越界动效层三种钳回；<0.2 钳住；非 video throw；无操作同引用；addCaption 的 track 分配/唯一 id/重叠顺延/clamp 边界；两 op 不可变性。
- [ ] **Step 2-4: 红→实现→editing 全绿**；**变异两组**：删 durationSec 联动→红；删钳回→红；还原 git diff 干净。
- [ ] **Step 5: 提交** `git commit -m "feat(editing): trimVideoLayer/addCaptionLayer——口播裁剪与手动字幕纯函数"`

---

### Task 3: studio — `lowerTalk`

**Files:**
- Modify: `packages/studio/src/lower.ts`（switch 加 `case 'talk'`，五模板分支零改动）、`videospec.ts` 的 `MIN_DURATION` 加 `talk: 6`
- Test: `packages/studio/test/lower-talk.test.ts`（新）

**Interfaces:**
- `lowerTalk(sections, opts)`：消费 `opts.videoSrc?: string`（**LowerOpts 加可选字段**）与 `opts.durationSec`——
  - track 0：`{ id:'talkVideo', kind:'video', from:'sec-video', start:0, duration:opts.durationSec, content:{kind:'video', src:opts.videoSrc, muted:false}, style:{}, effects:[] }`；semantic.sections 需含 `{id:'sec-video', role:'demo'}` 段（buildSemantic 不改——talk 的 semantic 由 generate 分支组装时**追加**该段，Task 4 做；lowerTalk 只按约定读）
  - 动效层：标题（hook 文案，0→15% 时长）/卖点卡（body items 均分中段）/CTA+品牌（末 15%）——节奏常数抄 lowerFlash 的比例逻辑起步，cssClass 用 talk.css 的类
  - 无字幕层（手动打）；`audio.narration` 由调用方置 null（lowerTalk 不管 audio）
- [ ] **Step 1: 失败测试**：层结构（video 层字段齐/动效层时间在界内/无 caption）；durationSec 透传；sec-video 关联；五模板行为不变（跑既有 lower 相关测试全绿即证）。
- [ ] **Step 2-4: 红→实现→studio 全绿（equivalence ✓）→提交** `git commit -m "feat(studio): lowerTalk——口播底层+动效层的图层编排"`

---

### Task 4: studio/server — generate talk 管线 + 路由

**Files:**
- Modify: `packages/studio/src/generate.ts`、`packages/server/src/app.ts`（/video 路由）
- Test: `packages/studio/test/generate.test.ts`（追加）、`packages/server/test/video.test.ts`（追加）

**Interfaces:**
- generate 的 talk 分支（`renderTalkPipeline`，与五模板的 renderHfPipeline 平行）：入参加 `uploadAssetId`；
  1. 查 asset（type video + origin upload，否则 throw 明确消息）；ffprobe 时长（spawn ffprobe，超时 30s；失败 throw）
  2. hfDir 建 `assets/` + **软链** `talk-source.mp4 → workspace 里的上传视频`（`fs.symlinkSync` 绝对目标；软链失败（如 FS 不支持）**回落真拷贝** + warning——比渲染失败强）
  3. semantic = buildSemantic(doc, 'talk'…) 产文案段 + **追加 `{id:'sec-video', role:'demo'}` 段**；`lower(semantic, {template:'talk', videoSrc:'assets/talk-source.mp4', durationSec: ffprobe 时长, …})`
  4. `audio = { narration: null, bgm: 走既有 selectBgm（talk 也配 BGM，ducking 现成）, beatGrid, captionsEnabled: false }`
  5. **不产 index.html**（跳过 renderSpecToHtml/injectTechFx/scaffoldHfProject 的 html 部分——assets 目录仍要建）；bgVariant 默认 `'none'`（spec §1.4，可被 --bg 覆盖）
  6. `renderAndRegister(…, { engine:'remotion', bgVariant })`——sourceAssetId/orig 快照/spec 落盘全走现成路径
- server `/video` body 加 `uploadAssetId?: number`；`tpl==='talk'` 时必填（缺→400「talk 需要选择口播素材」）、指向非 upload 视频→400；queue meta 照旧
- [ ] **Step 1: 失败测试**：studio——stub 模式 talk 全链路（软链存在且指向正确/无 index.html/spec.durationSec=ffprobe 值〔测试里 ffprobe 打桩或用已知时长小视频，照 cutplan 测试的素材策略〕/narration null/sourceAssetId 透传/orig 快照在）；软链失败回落拷贝+warning（打桩 symlinkSync throw）。server——talk 缺 uploadAssetId 400 / 指向 copy 资产 400 / 合法入队 meta 对。
- [ ] **Step 2-4: 红→实现→studio+server 全绿→提交** `git commit -m "feat(studio,server): talk 生成管线——软链零拷贝、Remotion-only、口播素材校验"`

---

### Task 5: compositions — talk.css + 内容门禁 fixture

**Files:**
- Create: `packages/compositions/src/styles/talk.css`；Modify: `styles/all.css`（注册第七份——**注意 P0 教训**：all.css 是唯一清单，index.ts 只 import all.css）、`src/SpecView.tsx` 的 `TEMPLATE_CLASSES` 加 talk
- Modify: `test/fixtures/generate.ts`（talk 组——用 lowerTalk 真生成）、`test/content.test.tsx`（覆盖守护加 video 类：「至少一组含带 trimStart 的 video 图层」）

**Interfaces:**
- talk.css：从 flash.css 复制标题/卡/CTA/cap 规格改 `.tpl-talk` 前缀（起步样式，spec §1.4）；竖横版两套照抄结构
- talk fixture：`generate.ts` 里加 talk 输入（DOC_FIXTURE + videoSrc:'assets/talk-source.mp4' + durationSec:20 + trimStart:1.5），重跑落 `talk.json`
- [ ] **Step 1: 生成 fixture + 写守护断言（失败）→ Step 2: talk.css/TEMPLATE_CLASSES → Step 3: compositions 全绿（内容断言对 talk 组全过：图层出现/文本上屏/cssClass 保留/video src 编码）→ Step 4: 变异一组**（TEMPLATE_CLASSES 去掉 talk→回落 flash 类——有断言红吗？没有就补一条 `.tpl-talk` 在 classList 的用例）**→ Step 5: 提交** `git commit -m "feat(compositions): talk 模板样式与内容门禁 fixture——video 类覆盖守护补位"`

---

### Task 6: web — 出片入口

**Files:**
- Modify: `apps/web/src/pages/workshop/editor/InspectorPane.tsx`（出片参数面板：模板下拉加 talk；选中时出「口播素材」下拉——本项目 `origin==='upload'` 的 video assets，空则提示「先去成片库上传口播」+ 禁用出片）、`EditorPage.tsx`/`WorkshopPage.tsx`（makeVideo 请求体带 uploadAssetId 透传）
- 展示映射：模板名常量表加 `talk:'口播合成'`（沿用无裸枚举纪律）

- [ ] **Step 1: 实现 → Step 2: 构建+浏览器自验**（临时 workspace：上传一条小 mp4 → talk 出片 stub 全链 → 队列出卡 v1）**→ Step 3: 提交** `git commit -m "feat(web): talk 出片入口——口播素材选择"`

---

### Task 7: web — 剪辑台 talk 配套

**Files:**
- Modify: `editor/TimelinePane.tsx`（视频层 Clip 的边缘拖改走 `trimVideoLayer`——识别条件：该 shot 的 layerIds 对应图层 kind==='video'；普通 Clip 仍走 resizeLayer；字幕轨 talk 下可拖+双击加字幕）、`editor/ShotList.tsx`（字幕行可编辑；「口播视频」行显示 trim 摘要）、`editor/InspectorPane.tsx`（视频层选中时出 trimStart/trimEnd/volume 数字字段，走 `ed.apply(trimVideoLayer/setLayerStyle…)`——volume 走新的 content 字段需要小 op 或并入 trimVideoLayer？**裁决：加 `setVideoVolume(spec, layerId, v)` 进 Task 2 的 video-ops**〔实施者若 Task 2 已交付就在本任务补进 editing 带测试〕）、`EditorPage.tsx`（装配）
- 字幕可拖区分：`spec.template==='talk'` 时字幕轨 Clip 拖拽启用（moveLayer/resizeLayer 现成），双击空白插字幕（`addCaptionLayer` + 弹 inline 输入）；五模板保持不可拖

- [ ] **Step 1: 实现 → Step 2: 构建+浏览器自验**（talk spec：左缘拖裁头→durationSec 缩短+动效层钳回+Player 即时反映；Inspector 数字微调 trim；字幕轨双击→打字→上屏→拖挪；⌘Z 逐步回退；五模板字幕轨仍不可拖回归一眼）**→ Step 3: 提交** `git commit -m "feat(web): 剪辑台 talk 配套——trim 拖拽、手动字幕、数字微调"`

---

### Task 8: 端到端真渲验收 + 文档

- [ ] **Step 1: 造测试口播**：ffmpeg 合成 20s 视频（前 2s 纯红帧+后 18s 蓝底秒数字滚动，加 440Hz 正弦当人声）→ 走真 upload 流程上传。
- [ ] **Step 2: talk 全链真渲**：出片（真渲模式）→ 剪辑台裁头 2s（红帧应被裁掉）→ 加一条字幕「测试字幕」@5s → 保存 → 渲成片 → 验四件事：抽帧 t=0 无红帧（trim 生效）且蓝底数字从 ~2s 起（起播点对）/ 字幕在 5s 帧上 / 动效层叠在上方 / `volumedetect` 对照法（成片有 440Hz 人声；配 BGM 时 ducking 生效）。区分亲眼验/推断。
- [ ] **Step 3: 回归**：③的剪辑台主链快速复核（五模板改字/拖拽/渲片不受 talk 改动影响）；全仓 `npx pnpm test` 绿（①②门禁绿）。
- [ ] **Step 4: 文档**：README 加 talk 模板段（口播合成流程+字幕手动+trim）；spec 如实记录实现偏差（若有）。
- [ ] **Step 5: 提交** `git commit -m "docs: 口播合成 talk 落地说明"`

---

## 计划自查

**Spec 覆盖**：§1.1→T1；§1.2→T1；§1.3→T3（sec-video 段在 T4 组装侧追加，T3 按约定读——两任务接口在各自 Interfaces 写明）；§1.4→T5（talk.css/bgVariant none 在 T4）；§1.5→T4（narration null/BGM 现成）；§1.6→T4（不产 html）+T5（fixture+守护）；§2→T4/T6（入口）+软链 T4；§3→T2（两 op）+T7（装配）；§4→各任务测试+T8。
**占位符**：无 TBD；关键签名/钳制语义/测试清单齐。
**类型一致性**：`trimVideoLayer/addCaptionLayer/setVideoVolume`（T2/T7 定义与消费同名）；`LowerOpts.videoSrc`（T3 定义 T4 传入）；`uploadAssetId`（T4 服务端↔T6 请求体）；`sec-video`（T3 读 T4 写，字符串常量两侧测试都钉）。
**风险**：T7 的「视频层边缘拖=trim、普通层=resize」双语义分流是最易错处——判定条件（layer kind）与两条路径的钳制都有纯函数测试兜底；T4 软链的 FS 兼容回落已设计。
