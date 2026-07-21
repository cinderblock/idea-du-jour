# idea-du-jour

A personal, low-friction capture + triage system for tasks, notes, ideas, and memories —
built for **agent collaboration** and **frictionless iPhone capture**.

The signature flow: hold the iPhone Action button → Siri → dictate → it lands in your own
database. Agents (e.g. Claude via a skill) read the same store to help you work through your
daily ideas.

## Status
Greenfield / early. See [`plans/idea-du-jour.md`](plans/idea-du-jour.md) for the living design
and progress.

## Design at a glance
- **Stack:** TanStack Start (React, SSR via Nitro) — one deployable serving the PWA and the API.
- **Store:** SQLite (via libsql), **append-only event log** as source of truth + a rebuildable
  `items` projection for fast reads. Drizzle ORM.
- **Web auth:** Passkey / WebAuthn (Face ID). *(auth phase — not wired yet)*
- **API auth:** bearer tokens — *capture* (write-only, for Siri) and *agent* (read + comment).
- **Hosting:** Docker on `firefly` behind Caddy (HTTPS) at `idj.isozilla.com`. *(later; infra
  changes are gated — see `plans/idea-du-jour.md`)*

## Capture (iPhone)
A Siri Shortcut POSTs dictated text to `/api/capture` with a *capture* bearer token, bound to
the Action button. The endpoint accepts raw `text/plain` or JSON `{text, kind?, tags?}`.
Leading `todo:`/`idea:`/`rem:` set the kind; `#tags` are auto-extracted; raw text is kept
verbatim. (Full Shortcut recipe: TODO.)

## Development

```sh
bun install
cp .env.example .env
bun run db:migrate                       # apply migrations to ./data/idj.db
bun run token:mint capture "dev-siri"    # prints a one-time capture token
bun run token:mint agent   "dev-agent"   # prints a one-time agent token
bun run dev                              # http://localhost:3000
```

Quick smoke test (note: the dev server binds IPv6 — use `localhost`, not `127.0.0.1`):

```sh
curl -X POST http://localhost:3000/api/capture \
  -H "Authorization: Bearer <capture-token>" \
  -H "Content-Type: text/plain" \
  --data "todo: buy milk #groceries"
# -> {"id":"<ulid>"}

curl "http://localhost:3000/api/items?status=open" \
  -H "Authorization: Bearer <agent-token>"
```

Other scripts: `bun run typecheck`, `bun run db:generate` (regenerate migrations after a
schema change), `bun run build`.

### Layout
- `src/db/` — Drizzle schema, libsql client, migrator.
- `src/server/` — `events.ts` (append + project), `tokens.ts` (bearer auth/scopes),
  `capture.ts` (keyword/tag parsing), `env.ts`.
- `src/routes/api/` — `capture.ts` (POST, capture scope), `items.ts` (GET, agent scope).
- `scripts/mint-token.ts` — mint API tokens.
