FROM node:22-bookworm-slim@sha256:f576cc608b02e6b04bb0700e13be83eb5ceb7bb24584c3181b0f4ecfa0cd0edf AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json

ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN npm ci

FROM dependencies AS build

ENV NEXT_TELEMETRY_DISABLED=1

COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/web apps/web

RUN npm run build:contracts && npm run build:web

FROM node:22-bookworm-slim@sha256:f576cc608b02e6b04bb0700e13be83eb5ceb7bb24584c3181b0f4ecfa0cd0edf AS runtime

ENV HOSTNAME=0.0.0.0
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

WORKDIR /app

RUN groupadd --system --gid 1001 nextjs \
  && useradd --system --uid 1001 --gid nextjs nextjs

COPY --from=build --chown=nextjs:nextjs /app/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nextjs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nextjs:nextjs /app/apps/web/public ./apps/web/public

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "apps/web/server.js"]
