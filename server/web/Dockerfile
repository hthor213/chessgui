# ChessGUI web client (spec 221). Multi-stage: pnpm builds the apps/web static
# export from the workspace, nginx:alpine serves it. Build context is the REPO
# ROOT (see docker-compose.yml) — the workspace packages, the desktop hooks/lib
# that apps/web aliases via @/*, and data/personas/*.json are all build inputs.
# The root .dockerignore is an allowlist keeping the multi-GB desktop build
# artifacts out of the context.

FROM node:24-slim AS build
# No packageManager field in package.json — pin the pnpm major/minor used on
# the laptop (10.12.x) instead of trusting corepack.
RUN npm install -g pnpm@10.12.4
WORKDIR /app

# Manifests first so the dependency layer caches across source-only changes.
# --frozen-lockfile needs every workspace importer's package.json present.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/desktop/package.json apps/desktop/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/ui/package.json packages/ui/
RUN pnpm install --frozen-lockfile --filter @chessgui/web...

# .git + git binary so next.config.mjs's `git rev-parse` stamps the header
# build info with the real commit (it falls back to "dev" without them).
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/* \
    && git config --global --add safe.directory /app
COPY .git ./.git
COPY packages ./packages
COPY data/personas ./data/personas
COPY apps/desktop/hooks ./apps/desktop/hooks
COPY apps/desktop/lib ./apps/desktop/lib
COPY apps/web ./apps/web

# Same-origin relative base: the client calls /chess/api/*, Caddy strips
# /chess and proxies to the arena on 8017 (spec 221 API routing) — no CORS.
# Inlined at build time by Next, hence ARG not runtime env.
ARG ARENA_API_BASE=/chess
ENV NEXT_PUBLIC_ARENA_API_BASE=$ARENA_API_BASE
RUN pnpm --filter @chessgui/web build

FROM nginx:alpine
COPY server/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
