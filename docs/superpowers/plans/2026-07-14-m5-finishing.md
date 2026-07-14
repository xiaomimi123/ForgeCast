# M5 收尾脚手架（Docker renderer + videocut）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** 交付 M5 最后两口的脚手架：⑤ Docker renderer 镜像配方（含中文字体）+ ④ videocut 集成文档 + CLI `--cut` 占位。均标注未验证（Docker 构建/真实剪辑不执行）。

**Architecture:** 纯脚手架/文档 + 一个 CLI 占位标志。不改引擎逻辑。设计见 `docs/superpowers/specs/2026-07-14-m5-finishing-design.md`。

## Global Constraints

- 中文文档；commit trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`；Docker 构建需 `DOCKER_BUILDKIT=0`（中文路径，本口不实际构建）
- 不破坏现有测试：`pnpm -r test` 全绿；`--cut` 不阻断渲染

---

### Task 1: ⑤ Dockerfile.renderer + compose renderer 服务

**Files:**
- Create: `Dockerfile.renderer`
- Modify: `docker-compose.yml`

- [ ] **Step 1: 写 Dockerfile.renderer**

`Dockerfile.renderer`（逐字，见设计）:
```dockerfile
FROM node:20-slim
WORKDIR /app
# Remotion/Chromium 运行依赖 + ffmpeg + 中文字体（fonts-noto-cjk 解决豆腐块）
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg fonts-noto-cjk fonts-noto-color-emoji \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
COPY apps ./apps
COPY templates ./templates
COPY cli.ts tsconfig.base.json ./
RUN pnpm install --frozen-lockfile
# 渲染宿主：进容器手动 `pnpm exec tsx cli.ts video <slug> --tpl=demo`（真渲染需 FORGECAST_VIDEO_MODE=render）
CMD ["sleep", "infinity"]
```

- [ ] **Step 2: 落实 compose renderer 服务**

`docker-compose.yml`：把原注释掉的 renderer 占位（`# renderer: ...`）替换为可用服务，并加 `profiles: ["render"]` 使默认不启动。最终 renderer 段：
```yaml
  # renderer：渲染 worker 镜像（Chromium+ffmpeg+中文字体）。默认不起，按需：
  #   DOCKER_BUILDKIT=0 docker compose --profile render build renderer
  renderer:
    profiles: ["render"]
    build:
      context: .
      dockerfile: Dockerfile.renderer
    volumes:
      - ./workspace:/app/workspace
      - ./db:/app/db
      - ./templates:/app/templates
    env_file: .env
```
（保留文件顶部已有的 `name: forgecast` 与 app 服务不动。）

- [ ] **Step 3: 验证 compose 语法（不构建）**

```bash
cp -n .env.example .env || true
docker compose --profile render config -q && echo "compose(含 renderer) 语法 OK"
```
Expected: `compose(含 renderer) 语法 OK`（若本机无 docker，则用 python yaml 解析 docker-compose.yml 确认语法有效并在报告注明；**不要跑 `docker compose build`**）。确认 `.env` 未被 git add。

- [ ] **Step 4: Commit**

```bash
git add Dockerfile.renderer docker-compose.yml
git commit -m "chore(docker): renderer 镜像（Chromium+ffmpeg+中文字体）+ compose renderer 服务（profile render，未构建验证）"
```

---

### Task 2: ④ videocut 集成文档 + CLI --cut 占位

**Files:**
- Create: `docs/m5-videocut.md`
- Modify: `cli.ts`, `README.md`

- [ ] **Step 1: 写 videocut 文档**

`docs/m5-videocut.md`:
```markdown
# M5 ④ videocut 剪辑集成（脚手架，未实装）

> 状态：**未实装**。本文档说明集成路径；真实接入需火山引擎 ASR key + 装 videocut-skills 插件。

## 定位（开发文档 §6.4）

填补「原始录屏 → 可用素材」环节，与 Remotion 两层分工：

```
OBS 原始录屏(3-5分钟) → videocut(拆分镜/去废话/ASR字幕/竖屏导出)
                        → 精选片段 → Remotion(模板A 演示段 <OffthreadVideo>) → 成片
```

## 依赖

- 火山引擎「录音文件识别 2.0」API Key（中文 ASR，兼做字幕来源）——需注册开通。
- [Ceeon/videocut-skills](https://github.com/Ceeon/videocut-skills)：Claude Code 剪辑 Skills 包，可商用。

## 集成方式

1. 把 videocut-skills 装入 Claude Code 环境（与 Remotion skill 并存）。
2. `forgecast video <slug> --tpl=demo --cut`：渲染前先用 videocut 对 `workspace/<slug>/raw/` 的录屏做分镜/去废话/竖屏，产物作为模板A 演示段素材（替代直接用整段录屏）。
3. Agent 工作流：Claude Code 读写剪辑决策，人只看预览页、提修改意见、确认。

## 当前实现

- `forgecast video ... --cut` 已识别该标志，但**仅打印占位提示、不改变渲染**（未装插件/无 key 时不阻断）。
- 真实实装待：火山 ASR key + videocut-skills 插件 + `--cut` 调用其分镜产物填入演示段。
```

- [ ] **Step 2: cli.ts video 加 --cut 占位**

`cli.ts` 的 `case 'video'` 内，在调用 generateVideo **之前**，加：
```ts
      if (rest.includes('--cut') || arg('cut') !== undefined) {
        console.log('  ⚠ --cut：videocut 预处理占位，本版未实装（需装 videocut-skills + 火山 ASR key），继续常规渲染')
      }
```
（不影响 tpl/asset 解析与渲染流程；`--cut` 是无值标志，用 `rest.includes('--cut')` 判定。）

- [ ] **Step 3: README 提一句**

`README.md` 的 video 命令行附近或路线图，加一句：`# videocut 剪辑(④)、Docker renderer(⑤) 见 docs/，均为脚手架未实装/未构建验证`（精简，准确）。

- [ ] **Step 4: 验证**

Run: `pnpm exec tsx cli.ts video 2>&1 | head -3`（无参→用法提示，不崩）
Run: `pnpm -r test 2>&1 | tail -3`（全绿）
（`--cut` 的实际打印在真跑 video 时出现，无 db 会因项目不存在报错属正常，此处只验证 CLI 不崩、测试不破坏。）

- [ ] **Step 5: Commit**

```bash
git add docs/m5-videocut.md cli.ts README.md
git commit -m "docs+cli: videocut(④) 集成文档 + forgecast video --cut 占位（未实装）"
```

---

## 自查记录

- **Spec 覆盖**：Dockerfile.renderer + compose renderer(T1)、videocut 文档 + --cut 占位 + README(T2)。均脚手架/文档，明确未验证（Docker 未构建、videocut 未实装）。
- **不破坏**：`--cut` 只打印不阻断；无引擎改动；`pnpm -r test` 应全绿。
- **占位性质明确**：文档与提示均标注"未实装/未构建验证"，不误导为已验证功能。
