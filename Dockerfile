# syntax=docker/dockerfile:1

# idea-du-jour — low-friction capture + triage. Built by CI and published to
# GHCR; which image runs on firefly is pinned in the ops repo at
# servers/firefly/stacks/idj/pin.json.

# --- Build: full deps, Nitro build, then prune to production deps -----------
FROM oven/bun:1.3 AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# Prune to production dependencies for the runtime stage. After the build, so
# vite / drizzle-kit / tailwind are still present above.
RUN rm -rf node_modules && bun install --frozen-lockfile --production

# --- Runtime ----------------------------------------------------------------
FROM oven/bun:1.3 AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The built Nitro server, plus what the boot-time migration and the admin
# scripts need: drizzle/ (the SQL), src/ (migrate.ts and its imports),
# scripts/ (token:mint et al, run via `docker exec`), and prod node_modules.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.output ./.output
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/package.json /app/bun.lock /app/drizzle.config.ts ./

# Stamp the build; the app serves it at /api/version.
ARG GIT_SHA=unknown
RUN printf '%s' "${GIT_SHA}" > /app/BUILD_SHA

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Nitro speaks TCP only — it cannot bind a unix socket. The previous deployment
# bridged that with a socat sidecar inside the runner container; now the
# container publishes the port on the host's loopback and Caddy proxies to it
# (see ops servers/firefly/sites.d/idj.isozilla.com.caddy).
ENV HOST=0.0.0.0 \
    PORT=3000
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
