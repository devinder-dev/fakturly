# Dockerfile — the API as a container image.
#
# Two stages. The first installs every dependency and generates the Prisma
# client; the second copies only what the server needs at runtime. The
# image that ships has no dev dependencies, no test files and no git history.
#
# Bun runs TypeScript directly, so there is no build step in the usual sense:
# the source IS the artifact. That keeps the image simple, at the cost of
# shipping .ts files rather than minified JS — irrelevant for a server.

# ── Stage 1: install ─────────────────────────────────────────
FROM oven/bun:1.3-slim AS install

WORKDIR /app

# Lockfile first, so this layer is cached until dependencies change. Copying
# the whole source here would invalidate the install on every code edit.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Prisma generates the client from the schema. It needs the schema and the
# config, and nothing else yet.
COPY prisma ./prisma
COPY prisma.config.ts ./
# `generate` never opens a connection, but prisma.config.ts resolves
# DATABASE_URL at load time and refuses to run without it. A placeholder
# satisfies the config; it exists only in this build stage and never
# reaches the image that runs.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" bunx prisma generate

# ── Stage 2: run ─────────────────────────────────────────────
FROM oven/bun:1.3-slim

WORKDIR /app

# The generated Prisma client lives inside src/, so it comes with the source.
COPY --from=install /app/node_modules ./node_modules
COPY --from=install /app/src/generated ./src/generated
COPY package.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
COPY docker-entrypoint.sh ./

# Run as the unprivileged user the base image provides. A process that does
# not need root should not have it — a container escape is then a user
# shell, not a root shell.
USER bun

ENV NODE_ENV=production
EXPOSE 3000

# The entrypoint applies pending migrations, then starts the server. See the
# script for why that order, and why "deploy" rather than "dev".
ENTRYPOINT ["./docker-entrypoint.sh"]
