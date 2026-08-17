# AI 产品介绍 B-roll 视频 设计

## 背景

用户研究了 `github.com/erduo1998-cell/erduo-broll-loop-engineering`（SRT 驱动、Director+Assets+Builder 多智能体、HyperFrames/Remotion 双后端自动路由的 B-roll 生成方案），想给"做内容"板块加一个"产品介绍视频"能力。排查发现这个项目正是本环境里已经装好的 `erduo-broll-loop-engineering` Skill 的源项目——不需要另起炉灶重写一遍多智能体编排系统，直接复用即可。

**关键架构限制（已与用户对齐）**：这个 Skill 需要 Claude Code 会话主动调度多个子智能体（Director→Assets→Builder→装配预览→用户看动态预览确认→定稿），不是 ForgeCast 服务端能自动跑完的后端函数调用。**不会有网页按钮一键出片的入口**，必须由用户在 Claude Code 对话里用自然语言发起，我来触发整条链路。因此本次要写的新代码很少，核心交付物是一份操作手册（`docs/broll-intro-workflow.md`），配合三个小型可复用工具函数/命令。

## 已与用户对齐的三个关键决定

1. **口播稿来源**：新写一份专门的"产品介绍"文案（跟现有短视频钩子文案语气不同，更像官方宣传片解说词），不复用 `douyinScript`。
2. **AI 生图内容**：纯凭空想象的示意 UI 效果图（文生图，基于项目 `analysis.md` 里的产品描述生成"这个产品可能长什么样"的概念图），无真实依据——视频里需要标注是概念示意，不是真实截图（真实感红线：不能让观众误以为是真实产品截图）。
3. **触发方式**：纯自然语言指令（"帮项目 X 做条产品介绍视频"），不做固定 CLI 入口驱动整条流程；但落地环节（登记成片）用一个小 CLI 命令承接，避免每次手写 SQL。

## 现有系统摸底

- `packages/studio/src/tts.ts` 的 `Cue { start: number; end: number; text: string }` + `synthesizeVoice(ctx, script, outPath)`：现成的口播配音+字幕时间轴生成，`cues` 数组（毫秒级 start/end + 文本）就是转 SRT 需要的原始数据。
- `packages/copywriter/src/script.ts` 的 `generateShootScript`：结构范本——mock 走 fixture、live 读 `templates/prompts/*.md` 模板拼 prompt 调 LLM、校验长度、写文件到 `workspace/<slug>/`、插入 `assets` 表一行。新函数照抄这个结构。
- `packages/rebrand/src/rebrand.ts`：读 `analysis.md` 的范本——`fs.readFileSync(path.join(ctx.config.paths.workspace, slug, 'analysis.md'))`，不存在则抛错提示先跑 `forgecast analyze`。新函数读 `analysis.md` 当产品介绍文案的依据，照抄这个读取+报错方式。
- `packages/server/src/app.ts` 的 `POST /api/projects/:slug/upload-video`：现有"登记外部成片"范本——存进 `workspace/<slug>/uploads/`（不是 `videos/`，`uploads/` 是现有上传目录，已在 `.gitignore` 里）、同名文件加时间戳前缀防覆盖、`assets` 表插入 `type='video', origin='upload', hook=NULL`。新 CLI 命令照抄这个文件落盘+建表逻辑，不用 HTTP multipart，直接读本地绝对路径的文件。
- `templates/prompts/` 目录现有模板风格（`shoot-script.md`/`rebrand.md` 等）：新增 `templates/prompts/broll-script.md`。

## 设计

### 组件 1：`cuesToSrt`（SRT 转换器）

**Files:** 新建 `packages/studio/src/srt.ts`

```ts
export function cuesToSrt(cues: Cue[]): string
```

纯函数：把 `Cue[]`（`start`/`end` 毫秒、`text`）转成标准 SRT 文本（`1\n00:00:00,000 --> 00:00:03,000\n文本\n\n2\n...`）。空数组返回空串。不做任何 I/O，写文件的动作留给调用方（我在跑流程时手动 `fs.writeFileSync`，不进 ForgeCast 自动化管线）。

### 组件 2：`generateProductIntroScript`（产品介绍解说词生成）

**Files:** 新建 `packages/copywriter/src/broll-script.ts`，新建 `templates/prompts/broll-script.md`

```ts
export interface ProductIntroScriptResult { assetId: number; filePath: string }
export async function generateProductIntroScript(
  ctx: CoreCtx,
  input: { slug: string; onProgress?: (msg: string) => void },
): Promise<ProductIntroScriptResult>
```

结构照抄 `generateShootScript`：
- 项目不存在 → 抛错。
- 读 `workspace/<slug>/analysis.md`，不存在则抛错提示先跑 `forgecast analyze <slug>`（照抄 `rebrand.ts` 的错误文案风格）。
- mock 模式：走固定 fixture（一段结构完整的示例解说词，不调 LLM，测试用）。
- live 模式：读 `templates/prompts/broll-script.md` 模板 + 注入 `analysis.md` 全文，调 `ctx.llm.complete`，输出低于阈值长度则抛错（照抄 `generateShootScript` 的"过短疑似生成失败"校验）。
- 写入 `workspace/<slug>/broll/script.md`（新建 `broll/` 子目录，加进 `.gitignore` 的 workspace 运行时产物那一段，跟 `scripts/`/`uploads/` 同级）。
- 插入 `assets` 表一行：`type='broll_script'`（新素材类型，跟现有 `copy`/`script`/`video` 区分开）、`hook=NULL`、`file_path` 相对路径、`warnings='[]'`。
- **不调用 `advanceStage`**——这是一个可选的辅助产出物，不是主流程的必经阶段，不影响项目看板的阶段推进。

`templates/prompts/broll-script.md` 内容要点（新模板，跟其它 prompt 模板同一种"system 角色说明+要求列表"风格）：要求输出面向"不了解这个项目的普通用户"的产品介绍解说词，语气类比官方产品发布视频（不是短视频钩子体），基于注入的 `analysis.md` 内容（谁掏钱/痛点/换皮方向），禁止编造未在 `analysis.md` 里出现的具体数字/客户案例（延续本仓库既有的"真实感红线"约定）。

### 组件 3：`forgecast broll-import` CLI 命令

**Files:** 修改 `cli.ts`

```
forgecast broll-import <slug> <本地mp4绝对路径> [--hook=<hook>]
```

逻辑照抄 `POST /api/projects/:slug/upload-video` 路由：
- 项目不存在 → 报错退出。
- 校验源文件存在、扩展名是 `.mp4`/`.mov`/`.m4v`。
- 目标目录 `workspace/<slug>/uploads/`，同名文件加时间戳前缀防覆盖（不覆盖旧成片）。
- `fs.copyFileSync` 把源文件复制进去（不是移动，保留 erduo skill 产出的原始文件）。
- 插入 `assets` 表：`type='video', origin='upload'`，`hook` 取 `--hook` 参数（缺省 `NULL`），`file_path` 相对路径，`warnings='[]'`。
- 打印登记结果（assetId + 相对路径），提示"该视频已登记，可在做内容页面成片 tab 看到"。

### 交付物 4：`docs/broll-intro-workflow.md`（操作手册，非代码）

按用户确认的九步流程写清楚，供任何一次 Claude Code 会话照着执行：

1. 确认目标项目 slug，确认 `workspace/<slug>/analysis.md` 已存在（没有就先跑 `forgecast analyze`）。
2. 调 `generateProductIntroScript` 生成/复用产品介绍解说词。
3. 调 `synthesizeVoice` 用解说词配音，拿到 `audioRel` + `cues`。
4. 调 `cuesToSrt(cues)` 转 SRT，写到一个新建的临时/项目目录下的 `.srt` 文件（跟 erduo skill 要求的输入位置对齐，具体路径按它当时的目录约定来，不在此文档里写死，因为这是 erduo skill 自己的接口细节）。
5. 用 `media-use` Skill 生成 2-4 张概念 UI 效果图（prompt 基于 `analysis.md` 的产品描述），跟用户确认这些是"概念图"用途。
6. 把 SRT + 概念图作为 user media 一起交给 `erduo-broll-loop-engineering` Skill，按它自己的 Director→Assets→Builder→装配预览流程走（不跳过任何一步，尤其是"给用户看动态预览"这一步不能省）。
7. 用户看预览确认没问题（或提出具体修改意见，回到对应 Builder 改）。
8. 定稿后，erduo skill 出最终 `master.mp4`；运行 `forgecast broll-import <slug> <master.mp4路径>` 登记进 ForgeCast。
9. 在视频描述/发布文案里注明"UI 画面为概念演示，非真实产品截图"，避免误导用户。

## 测试

- `packages/studio/test/srt.test.ts`：`cuesToSrt` 空数组→空串；单条/多条 cue 正确转出时间戳格式（补零、逗号分隔毫秒）；文本里有换行/特殊字符时的处理（照抄现有 studio 包测试风格）。
- `packages/copywriter/test/broll-script.test.ts`：mock 模式返回 fixture、不调 `ctx.llm`；`analysis.md` 不存在时抛错；live 模式输出过短抛错；`assets` 表写入 `type='broll_script'`。
- CLI `broll-import` 不加自动化测试（`cli.ts` 现有其它命令均无测试文件，遵循既有约定），走人工命令行验证：跑一次真实命令确认文件复制成功+`assets` 表多一行+打印信息正确。

## 不做的事

- 不做网页端"生成产品介绍视频"按钮或任何自动触发入口——本次范围内确认这条链路必须由 Claude Code 会话人工触发。
- 不重新实现 `erduo-broll-loop-engineering` Skill 内部的任何逻辑（Director/Assets/Builder 编排、运行时排期、装配脚本等），完全复用已装好的 Skill。
- 不用真实网站截图（这些开源项目大多没有真实上线的换皮站点）——AI 生图内容明确是"概念示意"，不追求写实还原。
- 不给 `broll_script` 素材类型加专属前端 UI tab（本次没有被要求，YAGNI；素材本身正常登记进 `assets` 表，以后要做 UI 再加）。
- 不改动 `synthesizeVoice`/`generateShootScript`/现有 `upload-video` 路由的任何逻辑，只新增、不修改。
