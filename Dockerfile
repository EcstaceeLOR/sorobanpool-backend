# Base image pinned by digest (#148) so a rebuild cannot silently pick up a different node:24-slim. Bump the tag and
# the digest together: `docker buildx imagetools inspect node:24-slim`.
ARG NODE_IMAGE=node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN corepack enable
# Install without scripts first: the Prisma client is generated after the schema is copied in.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm prisma generate && pnpm build

# Production dependencies only, installed in their own stage so pnpm's store and corepack cache stay out of the
# final image.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
# Contract addresses are read at startup from DEPLOYMENTS_FILE (default deployments/testnet.json).
COPY --from=build --chown=node:node /app/deployments ./deployments
# The official image ships an unprivileged `node` user (uid 1000); never run the service as root.
USER node
EXPOSE 3000
# Liveness probe against the existing /v1/health route, using Node's built-in fetch (no curl in the image). Only the
# API listens on HTTP; worker and indexer containers (ROLE != api) report healthy while their process is running.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "if ((process.env.ROLE ?? 'api') !== 'api') process.exit(0); fetch('http://127.0.0.1:' + (process.env.PORT ?? 3000) + '/v1/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/main"]
