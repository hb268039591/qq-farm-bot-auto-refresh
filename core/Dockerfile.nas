# Precompiled ZIP: both backend and session-host use this image.
ARG NODE_IMAGE=node:20.19.6-alpine3.21
FROM ${NODE_IMAGE}
ARG PNPM_VERSION=10.30.2
ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Shanghai FARM_DATA_DIR=/app/core/data FARM_RELEASE_ID=docker
RUN apk add --no-cache tzdata \
    && npm install --global "pnpm@${PNPM_VERSION}" --registry="${NPM_REGISTRY}"
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY core/package.json ./core/
COPY web/package.json ./web/
COPY packages/session-contract/package.json ./packages/session-contract/
RUN pnpm --filter 'qq-farm-bot...' install --prod --frozen-lockfile --registry="${NPM_REGISTRY}"
COPY packages/session-contract/dist ./packages/session-contract/dist
COPY core/client.js ./core/client.js
COPY core/dist ./core/dist
COPY core/src ./core/src
COPY web/dist ./web/dist
WORKDIR /app/core
RUN mkdir -p data /app/runtime
VOLUME ["/app/core/data", "/app/runtime"]
EXPOSE 3007
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:3007/api/game-version || exit 1
CMD ["node", "client.js"]
