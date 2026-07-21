# idea-du-jour container image. Built by CI, pushed to ghcr, deployed on firefly
# as an ops-managed "stack" (docker compose pull + up). Runtime is Bun — it builds
# the app, runs migrations on boot, and serves the Nitro node output.

FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATABASE_URL=file:/data/idj.db

# Production deps only — needed by the migrate step (drizzle-orm + @libsql/client).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Built server + what the migrate-on-boot step needs.
COPY --from=build /app/.output ./.output
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /app/src ./src

# Data (SQLite) lives on a mounted volume.
VOLUME ["/data"]
EXPOSE 3000

# Apply migrations, then serve. `bun` runs the Nitro node output directly.
CMD ["sh", "-c", "bun run db:migrate && exec bun .output/server/index.mjs"]
