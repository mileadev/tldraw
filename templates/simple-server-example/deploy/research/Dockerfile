# syntax=docker/dockerfile:1
FROM node:24.19.0-bookworm-slim AS build
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY internal ./internal
COPY packages ./packages
COPY templates/simple-server-example ./templates/simple-server-example
RUN pnpm install --frozen-lockfile --filter @tldraw/simple-server-example... --ignore-scripts
RUN pnpm --filter @tldraw/simple-server-example build-worker
RUN pnpm --filter @tldraw/simple-server-example build-server
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN pnpm rebuild better-sqlite3
RUN mkdir -p /out/node_modules && cp -RL templates/simple-server-example/node_modules/better-sqlite3 /out/node_modules/better-sqlite3 && cp -RL node_modules/.pnpm/node_modules/bindings /out/node_modules/bindings && cp -RL node_modules/.pnpm/node_modules/file-uri-to-path /out/node_modules/file-uri-to-path

FROM node:24.19.0-bookworm-slim AS runtime
RUN groupadd -g 10001 research && useradd -r -u 10001 -g research research
USER 10001:10001
WORKDIR /app
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=160

FROM runtime AS worker
COPY --from=build /src/templates/simple-server-example/dist/research-worker.cjs /app/worker.cjs
CMD ["node", "/app/worker.cjs"]

FROM runtime AS api
USER root
RUN mkdir -p /data/metadata /data/.rooms && chown -R 10001:10001 /data
USER 10001:10001
COPY --from=build /out/node_modules /app/node_modules
COPY --from=build /src/templates/simple-server-example/dist/server.cjs /app/server.cjs
WORKDIR /data
ENV NODE_OPTIONS=--max-old-space-size=320
CMD ["node", "/app/server.cjs"]
