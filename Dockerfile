# Capitán Lunático's ship: webhook + calendar feeds + scheduler in one small container.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json packages/db/
COPY packages/agent/package.json packages/agent/
COPY apps/server/package.json apps/server/
COPY apps/cli/package.json apps/cli/
COPY evals/package.json evals/
RUN pnpm install --frozen-lockfile --prod=false

FROM deps AS run
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps/server ./apps/server
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
# tsx runs the TypeScript sources directly; the workspace packages export ./src.
CMD ["pnpm", "exec", "tsx", "apps/server/src/main.ts"]
