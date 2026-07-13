FROM node:20-slim
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
COPY apps ./apps
COPY templates ./templates
COPY cli.ts tsconfig.base.json ./
RUN pnpm install --frozen-lockfile
EXPOSE 4321
CMD ["pnpm", "--filter", "@forgecast/server", "dev"]
