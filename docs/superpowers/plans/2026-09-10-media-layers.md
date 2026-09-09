# 素材图层入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 剪辑台「＋素材」入口——图片（上传/截图/新传）与形状（rect/ellipse/line）加层，品牌 kit 自动角落 logo。

**Architecture:** editing 三纯函数管加层/删层；server 两个新端点（图片上传扩 MIME、素材拷进包）；shape 联合加 line 两端渲染；kit 加 logoAssetId 生成期注入；web「＋素材」菜单+素材选择弹层。拖/缩/效果全吃 A/B 期基建。

**Tech Stack:** @forgecast/editing 纯函数、Hono、React、vitest。

**Spec:** `docs/superpowers/specs/2026-09-10-media-layers-design.md`

## Global Constraints

- editing 零 Node/纯函数/不可变/原引用；`media-` 前缀白名单删除（同 removeCaptionLayer 姿势）
- 缺省零变化红线：不加素材层/kit 无 logo 时既有渲染逐字节不变（①②门禁）
- 素材=拷贝进包（值快照）；只列/只收本项目素材，跨项目 400
- 图片 MIME 白名单 png/jpg/jpeg/webp/svg，10MB 上限
- apps/web 无测试框架；tsc+浏览器自测（临时 workspace+独立 db；server Node 版本先探 better-sqlite3 ABI）
- 用户 5173/4321 不碰；禁止 pkill/killall；提交不带 Co-Authored-By
- 测试同 shell：`export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use <版本> && npx pnpm test`

---

### Task 1: editing 加层/删层纯函数 + line 渲染两端

**Files:**
- Create: `packages/editing/src/media-ops.ts`；Modify: `packages/editing/src/index.ts`
- Modify: `packages/studio/src/videospec.ts`（shape 联合加 'line'）、`packages/compositions/src/LayerView.tsx`（line case）、`packages/studio/src/render-html.ts`（line case）
- Test: `packages/editing/test/media-ops.test.ts`、compositions/studio 各补 line 断言

**Interfaces（Task 3/4 逐字消费）:**

```ts
export interface MediaLayerOpts { x?: number; y?: number; width?: number; height?: number }
/** id media-<n>（现有 media- 层最大序号+1）；from:null; track=全 spec 最大 track+1;
 *  start:0 duration:spec.durationSec; 默认几何居中: 图 width 640(height 不写,图片自比例),
 *  rect/ellipse 400×240, line 600×6。style 里落 x/y/width[/height]（B 期字段面板可继续调）。 */
export function addImageLayer(spec: VideoSpec, src: string, opts?: MediaLayerOpts): VideoSpec
export function addShapeLayer(spec: VideoSpec, shape: 'rect' | 'ellipse' | 'line', opts?: MediaLayerOpts): VideoSpec
/** 仅 media- 前缀（含 media-logo）可删，否则 throw；不存在 throw。 */
export function removeMediaLayer(spec: VideoSpec, layerId: string): VideoSpec
```

line 渲染：两端 shape case 里 `shape==='line'` 渲 `<div class="shape shape-line">`（样式全由 style.bg/width/height 驱动，无新 CSS——`.shape` 既有基类若有底色规则先读再定）。

- [ ] **Step 1: 失败测试**：id 序号推进（已有 media-0 → 新 media-1）；track=最大+1；默认几何三组数值；removeMediaLayer 白名单（cap0/手动字幕/不存在 各 throw；media-logo 可删）；不可变/原引用；line 两端渲染断言+既有 shape fixture 零变化。
- [ ] **Step 2: 红→实现→绿 + 变异**（前缀白名单放宽 'media' → 'me' 应有用例红？不对——变异做「删除白名单判定去掉→非 media 层可删」用例红；还原）。零 Node 守护绿。
- [ ] **Step 3: Commit** `feat(editing,compositions,studio): 素材加层/删层纯函数与 line 形状`

### Task 2: server——图片上传 + 素材拷进包端点 + kit logoAssetId

**Files:**
- Modify: `packages/server/src/app.ts`（upload-image 路由或扩 upload-video 为 upload-asset；新端点 media-asset）、`packages/server/src/preset-routes.ts`（brand-kit 校验加 logoAssetId）
- Modify: `packages/studio/src/brand-kit.ts`（BrandKit 加 logoAssetId?: number；applyBrandKit 不处理 logo——logo 注入在 generate 层做，见语义）、`packages/studio/src/generate.ts`（出片时 kit 有 logoAssetId → 拷贝 logo 进 assets/media/ → spec 加 media-logo 层）
- Test: `packages/server/test/`（upload MIME 正反/media-asset 拷贝/跨项目 400）、`packages/studio/test/`（logo 注入 stub：层几何/id/幂等、无 logo 零变化）

**Interfaces:**
- `POST /api/projects/:slug/upload-image`（multipart，MIME 白名单 png/jpg/jpeg/webp/svg、≤10MB；INSERT assets type='image' origin='upload'；返 {id, filePath}）
- `POST /api/videos/:videoId/media-asset` body `{assetId?: number; shotPath?: string}`（二选一：upload 图片素材 id，或项目截图相对路径）→ 校验本项目→拷贝进该视频素材包 `assets/media/<原名>`（重名加 -1 后缀）→ 返 `{src: 'assets/media/<名>'}`；跨项目/不存在 400/404
- `GET /api/projects/:slug/image-assets` → 列本项目 upload 图片 + demo shots（`[{kind:'upload'|'shot', id?, path, name}]`，给弹层）
- kit PUT 校验：logoAssetId 须为本项目 upload image 素材 id（400 否则）
- logo 注入语义（generate 层）：kit.logoAssetId 有值→拷 logo 文件进包→spec.layers 追加 `{id:'media-logo', kind:'image', from:null, overridden:false, start:0, duration:durationSec, track:max+1, content:{kind:'image',src}, style:{x:canvas.width-240, y:60, width:180}, effects:[]}`；已存在 media-logo 跳过（幂等）；失败（素材没了）warning 不炸出片

- [ ] **Step 1: 路由正反测试先行 → 红 → 实现 → server/studio 包绿**
- [ ] **Step 2: Commit** `feat(server,studio): 图片上传/素材进包端点与 kit logo 注入`

### Task 3: web——「＋素材」菜单 + 素材选择弹层 + 删除入口

**Files:**
- Modify: `apps/web/src/pages/workshop/editor/EditorPage.tsx`（工具栏菜单）、`InspectorPane.tsx` 或新建 `MediaPicker.tsx`（弹层）、`ShotList.tsx`/`TimelinePane.tsx`（media- 层删除按钮）、`apps/web/src/api.ts`

要点：「＋素材」菜单（同「版式」菜单款）：图片…→MediaPicker 弹层（三分组缩略图网格：上传图/截图/上传新图按钮；缩略图用既有静态文件服务路径）；矩形/圆形/线条直接 `ed.apply(addShapeLayer(...))`。图片选中→`POST media-asset` 拿 src→`ed.apply(addImageLayer(spec, src))`→自动选中新层（onSelectLayer）。上传新图→upload-image→成功自动选中加层。删除：ShotList 的 media- 层行+时间轴选中态出「删除」小按钮→in-app confirm→`ed.apply(removeMediaLayer(...))`。busy 禁用；一次加/删=一步 undo。

- [ ] **Step 1: 读现场**（版式菜单/Confirm/api.ts/ShotList 行结构）→ 实现 → `npx tsc --noEmit` 干净
- [ ] **Step 2: 浏览器自测**（临时 workspace+独立 db）：加图/加三种形状→画布拖缩→B 期效果可调→时间轴拖时长→删除 confirm→undo 全链；上传新图直加；截图分组可选
- [ ] **Step 3: Commit** `feat(web): ＋素材菜单/选择弹层/删除入口`

### Task 4: 设置页 kit logo + 端到端真渲验收 + 文档

**Files:**
- Modify: `apps/web/src/pages/SettingsPage.tsx`（kit 块加 logo 下拉：列项目 upload 图片，可清空）、`README.md`、spec 附注

- [ ] **Step 1: 设置页 logo 选择**（GET image-assets 的 upload 分组；PUT 带 logoAssetId；清空=null 删键）→ tsc 干净
- [ ] **Step 2: 真渲验收**（临时 workspace+独立 db、app.fetch、FORGECAST_VIDEO_MODE=render）：上传一张测试 png+设 kit logo → 出片 → 抽帧验：图片层上屏位置尺寸对、line 线条渲出（色/粗细）、logo 右上角 180px；svg 一并验（不一致则按 spec §5 去掉 svg 记偏差）；对照组（无素材无 logo）HF sha256 与 merge-base 一致
- [ ] **Step 3: 回归**：全仓测试绿（已知 flake 单包重跑）；README「素材图层」段；spec 实现偏差注记（读 ledger 提炼）
- [ ] **Step 4: Commit** `feat(web)+docs: 设置页 kit logo 与素材图层落地说明`

## Self-Review

- Spec 覆盖：§1 通路（T1/T2）、§2 UI（T3）、kit logo（T2/T4）、§3 边界测试（各任务+T4 端到端）、§4 非目标未越界、§5 svg 风险预案（T4 Step2）。缺口：无。
- 占位符：无 TBD；T1 变异描述已修正为明确可执行（白名单判定删除→红）。
- 类型一致性：`MediaLayerOpts/addImageLayer/addShapeLayer/removeMediaLayer/logoAssetId/media-asset` 各任务引用一致。
