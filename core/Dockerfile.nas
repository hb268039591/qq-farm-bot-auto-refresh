# Precompiled JavaScript and web assets are included in the delivery ZIP.
# npm installs only production dependencies for the NAS CPU architecture.
ARG NODE_IMAGE=node:20.19.6-alpine3.21
FROM ${NODE_IMAGE}
ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /app/core
ENV NODE_ENV=production TZ=Asia/Shanghai FARM_DATA_DIR=/app/core/data FARM_AUTO_START=1
RUN apk add --no-cache tzdata
COPY core/package.json core/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --registry="${NPM_REGISTRY}" && npm cache clean --force
COPY core/client.js ./client.js
COPY core/dist ./dist
COPY core/src ./src
COPY web/dist /app/web/dist
RUN mkdir -p /app/core/data
VOLUME ["/app/core/data"]
EXPOSE 3007
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:3007/api/game-version || exit 1
CMD ["node", "client.js"]
