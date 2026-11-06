FROM node:22-bookworm-slim@sha256:f576cc608b02e6b04bb0700e13be83eb5ceb7bb24584c3181b0f4ecfa0cd0edf AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json

# CPU inference only: never fetch optional CUDA libraries, and ship only the Linux runtime.
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN npm ci \
  && find node_modules/onnxruntime-node/bin/napi-v6 -mindepth 1 -maxdepth 1 ! -name linux -exec rm -rf {} +

FROM dependencies AS build

COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/api apps/api
COPY scripts/vendor-work-catalog.mjs scripts/vendor-work-catalog.mjs
COPY scripts/fetch-semantic-model.mjs scripts/fetch-semantic-model.mjs

# Pinned, hash-verified semantic memory model. Offline builds place the same files in
# apps/api/semantic/model/<id>/ first; verified files are reused, nothing is downloaded.
RUN node scripts/vendor-work-catalog.mjs && node scripts/fetch-semantic-model.mjs && npm run build:contracts && npm run build:api

FROM node:22-bookworm-slim@sha256:f576cc608b02e6b04bb0700e13be83eb5ceb7bb24584c3181b0f4ecfa0cd0edf AS runtime

ENV HOST=0.0.0.0
ENV NODE_ENV=production
ENV PORT=4000

WORKDIR /app

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=dependencies --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/migrations ./apps/api/migrations
COPY --from=build --chown=node:node /app/apps/api/catalog ./apps/api/catalog
COPY --from=build --chown=node:node /app/apps/api/semantic ./apps/api/semantic
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist

USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health/ready').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]
