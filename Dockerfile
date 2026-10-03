# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Multi-stage build.
#   deps   - full install (needed to build anything)          -> cached
#   prod   - only runtime dependencies, no compilers          -> small image
#   runner - copies the prod node_modules + source             -> the final one
# ---------------------------------------------------------------------------

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS prod
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app

# dumb-init reaps zombies and, more importantly, forwards SIGTERM to node so the
# graceful-shutdown handler in server.js actually runs on `docker stop`.
RUN apk add --no-cache dumb-init

# Never run the app as root.
RUN addgroup -S app && adduser -S app -G app

COPY --from=prod --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json ./
COPY --chown=app:app server.js ./
COPY --chown=app:app src ./src
COPY --chown=app:app scripts ./scripts

USER app
EXPOSE 4000

# Compose/orchestrators use this to gate traffic on real readiness, not liveness.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||4000)+'/health/ready',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
