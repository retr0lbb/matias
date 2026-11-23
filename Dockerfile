# syntax=docker/dockerfile:1.7

# Build targets:
#   docker build -t matias .                          -> runtime image (default, last stage)
#   docker build --target migrate -t matias-migrate . -> one-off migration job
#
# Debian slim, not Alpine: Playwright's Chromium only supports glibc.

ARG NODE_VERSION=24.21.0
ARG PNPM_VERSION=12.8.1

# ---------------------------------------------------------------------------
# base: Node + pnpm (via corepack). Shared by every other stage.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    # pnpm-workspace.yaml has undecided allowBuilds entries; skip those
    # build scripts (as a local install does) instead of failing the build.
    PNPM_CONFIG_STRICT_DEP_BUILDS=false
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# ---------------------------------------------------------------------------
# deps: all dependencies (dev included). Only invalidated by lockfile changes.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build: compile TypeScript with the Nest CLI (also copies mail templates).
# ---------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm run build

# ---------------------------------------------------------------------------
# prod-deps: production dependencies only, for the runtime image.
# ---------------------------------------------------------------------------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ---------------------------------------------------------------------------
# migrate: runs drizzle-kit migrate once against $DATABASE_URL, then exits.
#   docker run --rm -e DATABASE_URL=... matias-migrate
# ---------------------------------------------------------------------------
FROM deps AS migrate
ENV NODE_ENV=production
COPY drizzle.config.ts ./
COPY drizzle ./drizzle
USER node
CMD ["node_modules/.bin/drizzle-kit", "migrate"]

# ---------------------------------------------------------------------------
# runtime: production image.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app

# tini is PID 1: forwards SIGTERM to Node and reaps Chromium's child processes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./

# Headless Chromium for PDF rendering (PdfRendererService), installed with the
# Playwright version from the lockfile so the browser always matches.
RUN node node_modules/playwright/cli.js install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"

COPY --from=build --chown=node:node /app/dist ./dist

USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
