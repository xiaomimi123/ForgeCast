# M5（子块①）— 渲染管线 + flash 视频模板设计

> M5 studio 是多子系统，本 spec 只覆盖**第一口**：Remotion 脚手架 + flash 模板（纯文字动效、无旁白）+ `video` 生成管线 + 素材工坊接入。
> 后续子块（②TTS+字幕+模板B、③模板A+录屏、④videocut 剪辑、⑤Docker renderer 镜像）各自单独 spec。
> 上游：flash 内容来自 M4 的 copy 素材（`parseCopyOutput` 解析）；下游产物是视频 asset，素材工坊内嵌播放。

## 目标

搭起 M5 的渲染骨架：把一个已生成的 copy 素材"打包成"一条 15 秒竖屏 flash 视频（痛点大字 → 一句卖点 → CTA 三段文字动效），CLI/API/Web 三入口，产出真实 mp4；渲染做成 stub/real 双模式，测试走 stub 不依赖重型渲染工具链。

沿用现有原则：引擎/界面分离；产物是文件；中文文档注释；`pnpm -r test` 不触发真渲染。

## 范围

**做**：新包 `@forgecast/studio`（Remotion 项目 + `generateVideo` 编排）；flash Remotion Composition（1080×1920, 30fps, ~15s）；`buildFlashProps`（copyDoc→props）；`renderFlash`（stub/real 双模式，real 用 @remotion/bundler+@remotion/renderer 动态加载）；core config 加 `video:{mode}`；server `POST /api/projects/:slug/video`（入队+SSE）；CLI `video <slug> --tpl=flash`；素材工坊 copy 卡「生成视频」按钮 + video 卡内嵌播放；vitest 全 stub 覆盖。

**不做（本子块）**：TTS/旁白/字幕（②）；产品录屏/截图快闪与模板A（③）；videocut 剪辑（④）；Docker renderer 镜像与中文字体封装（⑤）；模板B story；BGM 音轨（flash 无旁白，发布时 App 内加 BGM）；多模板（只 flash）。

## 架构

新包 `packages/studio`（`@forgecast/studio`），包名与 monorepo 结构约定一致（开发文档 §1）。依赖 `@forgecast/core` + `@forgecast/copywriter`（`parseCopyOutput`）+ `remotion`/`react`/`react-dom`（Compositions）+ `@remotion/bundler`/`@remotion/renderer`（real 渲染，动态加载）。

```
packages/studio/
  remotion.config.ts          # Remotion 最小配置（可选）
  src/remotion/Root.tsx       # registerRoot，注册 <Composition id="Flash" ...>
  src/remotion/Flash.tsx      # flash 模板组件，props: FlashProps
  src/props.ts                # interface FlashProps; buildFlashProps(doc: CopyDoc): FlashProps
  src/render.ts               # renderFlash(entry, propsPath, outPath, mode): Promise<void>
  src/generate.ts             # generateVideo(ctx, input): Promise<GeneratedVideo>
  src/index.ts                # 导出 generateVideo / buildFlashProps / FlashProps
```

对外核心函数：

```ts
interface FlashProps { painTitle: string; sellingPoint: string; cta: string; brandName: string }
interface GenerateVideoInput { slug: string; assetId?: number; tpl?: 'flash'; onProgress?: (msg: string) => void }
interface GeneratedVideo { assetId: number; filePath: string }  // filePath 相对 workspace

async function generateVideo(ctx: CoreCtx, input: GenerateVideoInput): Promise<GeneratedVideo>
function buildFlashProps(doc: CopyDoc): FlashProps
```

### 数据流

```
素材工坊「生成视频」/ POST /api/projects/<slug>/video / forgecast video <slug> --tpl=flash
  取 copy 素材（assetId 或该项目最新 type=copy）→ 读其 .md → parseCopyOutput
    → buildFlashProps(doc) → 写 workspace/<slug>/videos/<hook>-<stamp>.props.json
    → renderFlash(mode):
        stub  → 写占位 mp4（不跑 Remotion）
        render→ @remotion/bundler 打包 Root → selectComposition('Flash') → renderMedia(props, onProgress)
             → workspace/<slug>/videos/<hook>-<stamp>.mp4
    → INSERT assets (type='video', hook, file_path 相对 workspace, warnings '[]')
    → 素材列表出现视频（<video controls> 内嵌播放）
```

**边界纪律**：studio 只把 copy 素材打包成动效，不重读 analysis/README、不碰 GitHub/LLM。

## flash 模板（Flash.tsx）

Remotion Composition：`id="Flash"`，`width=1080, height=1920, fps=30, durationInFrames=450`（15s）。三段 `<Sequence>`：

| 段落 | 帧 | 内容 |
|---|---|---|
| 痛点大字 | 0-120（0-4s） | `painTitle` 大字弹入（spring 缩放/淡入），深色背景 |
| 一句卖点 | 120-300（4-10s） | `sellingPoint` 居中，配色块 |
| CTA | 300-450（10-15s） | `cta` + `brandName` 水印，行动号召样式 |

- 字体 `font-family: "PingFang SC", "Noto Sans CJK SC", sans-serif`（同 M4 封面 HTML；本机 headless Chrome 取系统中文字体，已被 M4 封面渲染验证）。
- 动效用 Remotion 的 `useCurrentFrame` + `interpolate`/`spring`，纯文字、无外部资源。
- props 缺字段给安全默认（空串不崩）。

`Root.tsx`：`registerRoot(() => <><Composition id="Flash" component={Flash} durationInFrames={450} fps={30} width={1080} height={1920} defaultProps={...} /></>)`。

## buildFlashProps（props.ts）

从 `CopyDoc`（copywriter 的 `parseCopyOutput` 产物）取：
- `painTitle` = `doc.cover.main`（封面主标题＝痛点大字）
- `sellingPoint` = `doc.cover.sub`（封面副标题＝一句卖点）
- `cta` = 从 `doc.douyinScript` 里抽 `【..CTA..】` 段的台词；抽不到则用 `doc.comments`/固定兜底「想要同款？评论区扣1」
- `brandName` = 传入（项目 brand_name）或 slug

（具体 CTA 抽取正则在实现里给出；均有兜底，不抛错。）

## 渲染双模式（render.ts + config）

- core config 增 `video: { mode: 'render' | 'stub' }`，`FORGECAST_VIDEO_MODE` 默认 `render`；`.env.example` 增该变量。
- `renderFlash(entry, propsPath, outPath, mode)`：
  - `stub`：`fs.writeFileSync(outPath, <占位字节>)`，不加载 Remotion。
  - `render`：`const { bundle } = await import('@remotion/bundler')`、`const { selectComposition, renderMedia } = await import('@remotion/renderer')`；bundle `src/remotion/Root.tsx` → selectComposition('Flash', inputProps) → renderMedia({codec:'h264', outputLocation: outPath, inputProps, onProgress})。**动态 import**：stub 与测试不加载重型模块。
- `generateVideo` 依 `ctx.config.video.mode` 选分支；render 的 onProgress → `input.onProgress`（`渲染 NN%…`）。
- **所有测试用 `FORGECAST_VIDEO_MODE=stub`**（`loadConfig(root,{FORGECAST_VIDEO_MODE:'stub'})`），`pnpm -r test` 绝不真渲染、不下 Chrome。

## 入口

### CLI（`cli.ts` 增加分支）
```bash
forgecast video <slug> --tpl=flash [--asset=<id>]
```
不给 `--asset` 用该项目最新 `type='copy'` 素材；打印生成的 mp4 相对路径。default help 把 `video` 移到已实现。

### REST（`packages/server/src/app.ts` 增加路由，复用 `queue`+SSE）
| 方法 路径 | 说明 | 返回 |
|---|---|---|
| `POST /api/projects/:slug/video` | body `{assetId?, tpl?}`；项目不存在 404；否则 enqueue `generateVideo(ctx, {slug, assetId, tpl, onProgress:log})` | `{taskId}` |

### Web（素材工坊 AssetCard）
- copy 卡：底部加「生成视频」按钮 → POST `/api/projects/:slug/video` `{assetId: copy.id}` → `subscribeTask` → done 后 `invalidateQueries(['assets', slug])`。（AssetCard 需知道 slug——由 WorkshopPage 传入，或按现有 onRegenerate 模式加 `onVideo` 回调交给 WorkshopPage 发起。）
- video 卡（`type==='video'`）：`<video src={\`/files/${asset.file_path}\`} controls className="...">` 内嵌播放（与现有 cover 分支并列）。

## 测试策略（TDD，全 stub）

`packages/studio/test/`：
- **buildFlashProps**：给一个 CopyDoc → painTitle=cover.main、sellingPoint=cover.sub、cta 非空（抽取或兜底）、brandName 用传入/slug。
- **generateVideo（stub）**：seed 一个 project + 一份 copy 素材 `.md`（fixture，符合产物契约），`FORGECAST_VIDEO_MODE=stub` → 跑后 `videos/*.props.json` 存在且含 FlashProps 字段、`videos/*.mp4` 占位文件存在、`assets` 有 `type='video'` 行且 `file_path` 为相对路径、返回 `{assetId, filePath}`；无 copy 素材 → 抛错。
- **renderFlash（stub）**：写出非空占位文件，不加载 remotion。
- Remotion 组件（Root/Flash）不单测——studio `tsc --noEmit` 门禁 + 里程碑末真渲染走查。

`packages/server/test/`：`POST /api/projects/<slug>/video`（config stub、先 seed copy 素材）→ 任务完成 → `GET assets` 含 video 素材；未知项目 404。

Web：无单测，门禁 = `tsc --noEmit` + `vite build`。

里程碑末走查：真实模式（`FORGECAST_VIDEO_MODE=render`）跑一次 `forgecast video <slug> --tpl=flash`，确认产出 mp4 尺寸 1080×1920、可播放；素材工坊点「生成视频」→ 视频卡内嵌播放。**若本机 Remotion 渲染跑不动，如实报告**。

## 全局约束（沿用）

- Node 20 / pnpm 9；`@forgecast/studio` 的 `main` 直指 `src/index.ts`，无 build 步骤（studio 的 Remotion Compositions 由 Remotion bundler 在渲染时自行打包）。
- 包名 `@forgecast/studio`，依赖 core+copywriter+remotion 等，自身 `devDependencies` 声明 `@types/better-sqlite3`（对齐其他包）+ `@types/react`/`@types/react-dom`（因含 React 组件）。
- **studio 的 tsconfig 与其他 node-only 包不同**：需 `"jsx": "react-jsx"` + `"lib": ["ES2022","DOM","DOM.Iterable"]` + react 类型（因 `src/remotion/*.tsx` 是 Remotion React 组件），参照 `apps/web/tsconfig.json` 的形态。
- 服务只绑 127.0.0.1；产物落 `workspace/<slug>/videos/`；assets.file_path 存相对 workspace 路径。
- 文档注释中文；TDD；commit conventional，结尾 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

## 未决/后续

- TTS+字幕+模板B（②）、模板A+录屏（③）、videocut（④）、Docker renderer 镜像+中文字体（⑤）、BGM/多模板——各自后续子块。
- flash 的产品截图快闪（用 raw/ 或录屏）——③。
- 渲染进度百分比的更细粒度 SSE、渲染失败的降级为 warning（同 M4 封面失败降级）——实现时按 M4 cover 的 try/catch 思路对齐。
