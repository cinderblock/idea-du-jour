#!/bin/sh
# Container entrypoint: migrate, then serve.
#
# Migrations run on every start rather than in a separate job — the app owns a
# single SQLite file and there is exactly one replica, so "migrate then boot" is
# the whole story. A failed migration must NOT fall through to serving an app
# against a half-migrated database, so this is `set -e` and the exec only
# happens if migrate exits 0.
set -e

cd /app

echo "idj: applying migrations ($(cat BUILD_SHA 2>/dev/null || echo dev))"
bun run src/db/migrate.ts

echo "idj: starting server on ${HOST}:${PORT}"
exec bun .output/server/index.mjs
