FROM oven/bun:1 AS base
WORKDIR /app

COPY package*.json ./
COPY turbo.json ./
COPY tsconfig.json ./
COPY packages/ ./packages/
COPY apps/server/ ./apps/server/

RUN bun install --frozen-lockfile

EXPOSE 3000
CMD ["bun", "run", "apps/server/src/index.ts"]
