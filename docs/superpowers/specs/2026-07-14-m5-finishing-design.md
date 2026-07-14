# M5 收尾脚手架（⑤ Docker renderer + ④ videocut）设计

> M5 最后两口，本质是**脚手架/文档**（非可单测代码），用户"搭着不验证"。
> ⑤ Docker renderer 镜像：给渲染打一个含 Chromium+ffmpeg+**中文字体**的镜像配方（解决 M5① review 指出的"渲染宿主可能缺 CJK 字体→豆腐块"）。Docker 构建本轮不实际执行（中文路径需 `DOCKER_BUILDKIT=0`、耗时/重）。
> ④ videocut 剪辑：主要是 Claude Code skill 装入 + 火山引擎 ASR key（非 forgecast 代码），本口只交付**集成文档** + CLI `--cut` 占位标志。

## 范围

**做**：
- ⑤ `Dockerfile.renderer`（node20 + Chromium 依赖 + ffmpeg + fonts-noto-cjk + app），`docker-compose.yml` 的 renderer 服务落实为 `profiles: [render]`（默认不起、按需构建），验证 `docker compose config -q` 通过。
- ④ `docs/m5-videocut.md`（集成路径：装 videocut-skills 插件 + 火山 ASR key + `forgecast video --cut` 预处理步骤，明确未实装）；`cli.ts` 的 `video` 命令加 `--cut` 占位标志（打印"videocut 预处理占位，需装 videocut-skills + 火山 ASR key，本版未实装"，不阻断，仍正常渲染）。

**不做**：真实 Docker 构建/运行（`DOCKER_BUILDKIT=0` 一次性、未验证）；render-worker 队列/协议（renderer 镜像先作"可 exec 进去跑 forgecast video 的环境"，不做独立 worker）；videocut 真实剪辑（需 ASR key + 插件）。

## ⑤ Dockerfile.renderer

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
# 渲染宿主：默认进容器手动 `pnpm exec tsx cli.ts video <slug> --tpl=demo`（真渲染需 FORGECAST_VIDEO_MODE=render）
CMD ["sleep", "infinity"]
```
（中转站中文路径构建：`DOCKER_BUILDKIT=0 docker compose --profile render build renderer`。）

`docker-compose.yml` renderer 服务（把原注释占位落实，加 profiles 使默认不起）：
```yaml
  renderer:
    profiles: ["render"]
    build: { context: ., dockerfile: Dockerfile.renderer }
    volumes:
      - ./workspace:/app/workspace
      - ./db:/app/db
      - ./templates:/app/templates
    env_file: .env
```

## ④ videocut 集成文档 + --cut 占位

`docs/m5-videocut.md`：说明 OBS 录屏 → videocut(拆分镜/去废话/ASR字幕/竖屏导出) → 精选片段 → Remotion(模板A 演示段) 的两层分工；依赖火山引擎「录音文件识别 2.0」key；集成方式=装 videocut-skills 到 Claude Code + `forgecast video --cut` 在渲染前调用其分镜产物；**本版未实装**（占位）。

`cli.ts` video case：识别 `--cut` 标志，若有则 `console.log` 一行占位提示（未实装、需插件+key），继续正常渲染（不阻断）。

## 验证策略

- ⑤：`cp -n .env.example .env; docker compose --profile render config -q`（若本机有 docker）验证 compose 语法（含 renderer 服务）；**不跑 `docker compose build`**（未验证）。Dockerfile 静态审查。
- ④：`cli.ts` 加 `--cut` 后 tsc/整体行为不破坏；`pnpm -r test` 全绿。
- 无新单测（脚手架/文档）。

## 全局约束（沿用）

- 中文文档注释；commit trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`；Docker 构建 `DOCKER_BUILDKIT=0`（中文路径）。

## 未决/后续

- 真实 Docker 构建+渲染验证；render-worker 队列化（把渲染 offload 到 renderer 服务）；videocut 真实接入（火山 ASR key + 插件）与 `--cut` 实装。
