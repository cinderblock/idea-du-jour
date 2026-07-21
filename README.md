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

## Web UI

A mobile-first triage PWA (installable; add to Home Screen on iOS):
- **Inbox** (`/`) — quick-capture box, `open`/`all`/`done` filters, item cards.
- **Item detail** (`/items/$id`) — full body, activity/comment thread, add comment,
  mark done / reopen.

The UI reads and writes through first-party **server functions** (`src/server/webapi.ts`)
that call the domain layer directly — no bearer token. The token API below is for Siri +
external agents. *(Note: the web UI is not yet auth-gated — that's the WebAuthn phase.)*

## Token API (Siri + agents)

| Method + path | Scope | Purpose |
|---|---|---|
| `POST /api/capture` | capture | Append an item (raw text or JSON). |
| `GET /api/items?status=&kind=&limit=` | agent | List/query items. |
| `GET /api/items/:id` | agent | One item + its full event history. |
| `POST /api/items/:id/comment` | agent | Add a comment (raw text or `{text}`). |
| `POST /api/items/:id/done` · `/reopen` | agent | Change status. |
| `GET /api/events?since=<seq>` | agent | Append-only cursor feed (`nextCursor`). |

## Development

See scripts: `bun run dev` · `typecheck` · `build` · `db:migrate` · `db:generate` ·
`db:rebuild` (replay log → projection) · `token:mint <capture|agent> "<label>"` ·
`icons:gen` (regenerate PWA icons).

### Layout
- `src/db/` — Drizzle schema (`events`, `items`, `tokens`, `users`, `credentials`),
  libsql client, migrator.
- `src/server/` — `events.ts` (append + project + rebuild), `tokens.ts` (bearer
  auth/scopes), `capture.ts` (keyword/tag parsing), `webapi.ts` (web server functions),
  `env.ts`.
- `src/routes/` — web UI (`index.tsx`, `items.$id.tsx`) + `api/` token endpoints.
- `src/ui/` — presentation helpers. `scripts/` — token mint, projection rebuild, icon gen.
- `public/` — PWA manifest, service worker, icons.
