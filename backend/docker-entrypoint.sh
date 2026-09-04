#!/bin/sh
# docker-entrypoint.sh — migrate, then serve.
#
# `prisma migrate deploy` applies the migrations committed in prisma/migrations
# and refuses to invent new ones. That is the right command for a deploy: if
# the schema and the migration folder have drifted, this fails loudly here
# rather than the server starting against a table that does not exist.
#
# `set -e`: a failed migration must stop the container. Starting the API
# anyway would serve requests against a half-migrated database.
set -e

echo "[entrypoint] applying migrations"
bunx prisma migrate deploy

echo "[entrypoint] starting server"
exec bun src/server.ts
