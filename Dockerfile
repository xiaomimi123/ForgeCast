FROM node:20-slim
WORKDIR /app
# better-sqlite3 原生编译依赖（node:20-slim 无 build 工具）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
COPY apps ./apps
COPY templates ./templates
COPY cli.ts tsconfig.base.json ./
RUN pnpm install --frozen-lockfile
# 构建 Web 到 apps/web/dist（由 server 静态托管）
RUN pnpm --filter web build
# 容器内绑 0.0.0.0 让端口映射可达；host 侧仍由 compose 限定 127.0.0.1
ENV FORGECAST_HOST=0.0.0.0
EXPOSE 4321
# 生产：起 server（同一进程内提供 API + 托管构建好的 Web 静态）
CMD ["pnpm", "exec", "tsx", "packages/server/src/index.ts"]
