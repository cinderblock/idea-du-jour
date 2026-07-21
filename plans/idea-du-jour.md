# idea-du-jour — Plan

## Goal
A personal, low-friction capture + triage system for tasks / notes / ideas / memories,
designed from the ground up for **agent** collaboration and **frictionless iPhone capture**.
The signature flow: hold the iPhone Action button → Siri → dictate → it lands in *my* database.
Agents (Claude here, via a skill) read the same store to help me work through my daily ideas.

Non-negotiables:
- Capture must be dead simple and never lose data (append-only source of truth).
- Agents get first-class read (and comment) access via API tokens.
- Hosted on `firefly` in Docker behind its Caddy HTTPS proxy (later; infra changes gated).

## Decisions already made (don't re-ask)
- **Greenfield**, not Vikunja. Vikunja's task-centric model fights "append anything, triage
  later" and isn't built for agent access. (User leaned this way; confirmed.)
- **Stack: TanStack Start** — full-stack React (SSR, file routes, TanStack Query/Router).
  One deployable serving both the PWA and the API. Matches user's preference.
- **Store: SQLite, append-only event log** as source of truth + a rebuildable `items`
  projection for fast reads. One file, trivial backup, WAL for single-user concurrency.
- **Web (human) auth: Passkey / WebAuthn** (`@simplewebauthn`). Face ID unlocks the PWA.
- **API auth: bearer tokens**, two scopes:
  - *capture* tokens = write-only (Siri shortcuts hold these; leak = append-only blast radius).
  - *agent* tokens = read + comment (Claude skill holds these).
- **Runtime: Bun** (`bun:sqlite`, no native build) unless TanStack Start friction forces Node.
- **ORM: Drizzle** (type-safe, first-class SQLite + bun:sqlite).

## Answers locked (2026-07-21)
1. **Hostname: `idj.isozilla.com`** — Cloudflare-proxied (orange cloud), mirroring the
   existing `vikunja.isozilla.com`. See "Deployment via ops repo" below.
2. **Keyword syntax: proposal accepted for v1** — everything is an *item*, default kind
   `note`; leading `todo:`/`t:` → task, `idea:` → idea, `memory:`/`rem:` → memory;
   `#tags` extracted anywhere; raw text always stored verbatim.
3. **Backups: deferred** (low priority). Revisit Litestream once hosted.

## Architecture

### Data model (event-sourced-lite)
`events` — append-only, **never UPDATE/DELETE**:
- `seq` INTEGER PK AUTOINCREMENT (monotonic order / cursor)
- `id` TEXT (ULID, external ref, sortable)
- `ts` INTEGER (unix ms)
- `type` TEXT — `item.created` | `item.commented` | `item.tagged` | `item.done` |
  `item.reopened` | `item.edited` | `item.deleted` (tombstone, row kept)
- `item_id` TEXT — entity ULID (minted on create)
- `actor` TEXT — `siri` | `web` | `agent:claude`
- `token_id` TEXT — which token wrote it (audit)
- `payload` TEXT (JSON)

`items` — projection, rebuildable by replaying `events` (safety + fast reads):
- `id` TEXT PK, `created_ts`, `updated_ts`, `kind`, `title`, `body`, `status`
  (open|done|archived), `tags` (JSON), `first_capture` (raw)

"Edit"/"complete"/"delete" = new events. Projection updated on write and fully rebuildable.

### API surface
- `POST /api/capture` — *capture* token. Accepts JSON `{text, kind?, tags?, ts?}` OR raw
  `text/plain`. Forgiving. Returns `{id}`. **This is the Siri endpoint.**
- `GET  /api/items?status=&since=&q=&kind=` — *agent* token. List/search.
- `GET  /api/items/:id`
- `POST /api/items/:id/comment` — *agent* token.
- `POST /api/items/:id/done` / `/reopen`
- `GET  /api/events?since=<seq>` — raw feed for agents (cursor pagination).
- Web session routes (passkey-guarded) reuse the same handlers.

### Auth
- Web: WebAuthn register (first-run bootstrap creates the single user) → passkey login →
  secure session cookie. `@simplewebauthn/server` + `/browser`.
- Tokens: `tokens` table, value **hashed** (store prefix + hash), `scope`, `label`,
  `created_ts`, `last_used_ts`. Manage from a settings page.

### iPhone capture
- Siri Shortcut: "Get Contents of URL" → POST `https://<host>/api/capture`,
  header `Authorization: Bearer <capture-token>`, body = dictated/typed text.
- Bind to Action button. Second shortcut on the share sheet for text/URLs.

### Agent enrichment (built)
- **Async, never inline.** Capture appends `item.created` and returns instantly; a
  fire-and-forget worker (`src/server/enrich.ts`) calls Claude and appends `item.enriched`.
  Capture never blocks on or fails from the LLM.
- **SDK, structured output.** `@anthropic-ai/sdk` `messages.parse` + zod schema
  (kind/title/tags/summary). Model `claude-sonnet-5` (`ENRICH_MODEL`), `thinking: disabled`
  + `effort: low` (cheap classify). Gated on `ANTHROPIC_API_KEY` — no key → silent skip
  (dev works without creds). `bun run enrich:pending` sweeps items captured before a key existed.
- **Precedence (human/keyword wins):** `kind` only overwritten when still default `note`;
  `title` fills only when empty; AI `tags` union with existing; `summary` is AI-owned. All
  applied via the append-only event, so `rebuildProjection` replays enrichment too.
- Future: graduate to the Claude Agent SDK so the enricher can dedupe/link related items
  and split brain-dumps — for now it's a single structured call per item.

### Claude triage skill (built)
- `.claude/skills/idj-triage/` — a **project skill** (committed, versioned with the API it
  calls). Invoked in Claude Code ("triage my inbox"), it reads `GET /api/items?status=open`,
  reasons across the whole set (cluster/dedupe/next-actions/stale), and writes back
  comment/done/reopen. **Runs on the user's Claude Max subscription** (no API bill) — the
  richer, whole-inbox counterpart to the cheap per-item auto-enricher.
- Config in `.claude/skills/idj-triage/.env.local` (gitignored): `IDJ_BASE_URL` +
  `IDJ_AGENT_TOKEN`. `.env.example` committed. Mint token: `bun run token:mint agent "..."`.
- Loads only when Claude Code is in the idj repo. To use it from anywhere, junction it into
  system skills: `mklink /J "%USERPROFILE%\.claude\skills\idj-triage" "<repo>\.claude\skills\idj-triage"`.
- Gap the skill can't yet fill: no `item.edited` endpoint, so it can comment + change status
  but not retag/rewrite kind via the API. Add that endpoint when the skill needs it.

### Billing model (decided)
- Max x20 covers **Claude Code** (incl. `claude -p`) + Claude.ai, NOT the raw Anthropic API
  (`x-api-key`, pay-per-token). So: the **triage skill** (Claude Code) is subscription-covered;
  the **auto-enricher** (SDK → api.anthropic.com) needs a key + bills per token (pennies at
  this volume). Auto-enrich stays optional/off-without-key; the skill is the primary path.

### Deployment via ops repo (LATER — gated; nothing applied yet)
Firefly has two app-hosting patterns in ops. We mirror the **socket-based isolated runner**
(bins / camptool) — it's the current gold standard and fits idj exactly: a Bun app + SQLite
data volume + a unix socket shared with Caddy, plus a self-hosted GitHub runner for
push-to-deploy. No published TCP port, no docker socket, no host mounts. The `bins` app
(Node + SQLite via DATABASE_PATH + SOCKET_PATH) is a near-identical template.

Ops changes required (all staged for review; **infra rules: per-change authorization,
CI-only deploys, `bun run sync` dry-run before committing CF changes, don't touch servers
directly**). Note: ops repo is currently on branch `ask-worker`.

1. **Cloudflare DNS** — `cloudflare/config/isozilla/isozilla.com.yaml`, firefly entry,
   add under `proxies:`:  `    idj.isozilla.com: idea-du-jour capture/todo app on docker`
2. **Caddy site** — new `servers/firefly/sites.d/idj.isozilla.com.caddy`:
   ```
   # idj.isozilla.com — idea-du-jour capture/triage app (unix socket, bins pattern).
   idj.isozilla.com {
       request_body { max_size 20MB }
       reverse_proxy unix//run/idj/idj.sock {
           header_up X-Real-IP {client_ip}
           header_up X-Forwarded-Proto https
           header_up X-Forwarded-For {client_ip}
       }
   }
   ```
3. **Caddy compose** — `servers/firefly/docker-compose.yml`: add `idj_sock:/run/idj` volume
   mount + external `idj_sock` volume (mirror `bins_sock`).
4. **Runner stack** — `servers/firefly/idj-runner/compose.yml` + `ensure-idj-runner.sh`
   (clone of bins-runner) + install job in the ops workflow. Needs the idj app repo to
   publish an image to ghcr and host a self-hosted runner (labels `firefly,idj`).

App-side prerequisites before wiring 3–4: Dockerfile, `SOCKET_PATH=/run/idj/idj.sock`,
`DATABASE_PATH` on a persisted volume, a deploy workflow. WebAuthn RP ID = `idj.isozilla.com`.

## Plan / steps
- [x] Lock big decisions (stack, store, auth). Write this plan.
- [x] Repo scaffold: TanStack Start (Nitro) + Bun + Drizzle + libsql; README.
- [x] DB schema + migration (`events`, `items`, `tokens`, `users`/`credentials`).
- [x] Event append + projection layer (`captureItem` writes event + projects, atomic).
- [x] `POST /api/capture` + token middleware (capture scope). **Verified end-to-end.**
- [x] Read/query endpoints + agent-scope middleware (`GET /api/items`).
- [x] Comment / done / reopen events + `GET /api/events?since=` cursor feed + `rebuildProjection`.
- [x] Web server functions (`src/server/webapi.ts`) — first-party read/write, no token.
- [x] Triage PWA UI (inbox + quick-capture + filters; item detail + comments + done/reopen).
- [x] PWA installability: manifest.json, service worker, iOS meta, generated PNG icons.
- [x] Agent enrichment: async Claude classify/tag/summarize → `item.enriched` event.
- [ ] WebAuthn register/login + session; guard web routes AND the web server functions.
- [ ] Token management settings page.
- [ ] Siri Shortcut recipe (documented in README).
- [x] Claude triage skill (`.claude/skills/idj-triage/`) — whole-inbox reasoning via agent API.
- [ ] Dockerfile + compose; backups. Deploy to firefly (gated).

## Findings / gotchas
- **Runtime driver = libsql, not bun:sqlite.** `bun:sqlite` only works under the Bun
  runtime; the Nitro server bundle may run on Node. `@libsql/client` + `drizzle-orm/libsql`
  is SQLite-compatible, file-backed (`file:./data/idj.db`), no native build, runs on both.
- **`create-start-app --template typescript` gives a router-only SPA** (no server routes).
  Omit `--router-only` and any `--template` to get real TanStack Start (Nitro server). The
  full scaffold pulls `nitro` (nitro-nightly), `@tanstack/router-plugin`, tailwind v4.
- **Server routes API (Start 1.168):** `createFileRoute('/api/x')({ server: { handlers: {
  GET/POST: async ({ request }) => Response } } })`. No `createServerFileRoute`. Handlers
  return native `Response` (use `Response.json(obj, { status })`).
- **`src/routeTree.gen.ts` is generated** by the plugin on first `vite dev`/build — until it
  exists, `tsc` errors on route paths and the `server` option. Gitignored. Typecheck clean
  once generated.
- **Vite dev binds IPv6 `::1` only on this box.** `curl 127.0.0.1:3000` is refused; use
  `localhost`/`[::1]` (or PowerShell `Invoke-WebRequest`, which resolves to `::1`).
- **Backgrounding via Git Bash `(cmd &)` doesn't survive** the tool call — the subshell is
  reaped. Use the Bash tool's `run_in_background: true` for the dev server.
- **Web UI uses `createServerFn`, not the token API.** GET/POST server functions in
  `src/server/webapi.ts` call the domain layer directly on the server. The public token API
  (`/api/*`) is only for Siri + external agents. **Auth gap:** these server functions are
  currently UNGUARDED — the WebAuthn phase must gate them (and the web routes) or anyone who
  reaches the site can read/write. Fine for local dev; must land before firefly exposure.
- **Server-function RPC is CSRF-protected + seroval-framed.** Endpoint is
  `/_serverFn/<base64 fileId>` (POST). Requires an `Origin` header matching host (else 403)
  and a seroval-encoded body (`toJSONAsync({data})`), returning a framed result. Verified
  webCapture over the wire this way when the browser preview tool was down.
- **Dev server doesn't pick up files added to `public/` after boot** — they 404 until
  restart (rescan). Not an extension/MIME issue. Also: the preview/browser MCP was flaky
  (malformed results, timeouts) during this session.
- **libsql bundles cleanly into the Nitro production build** (`.output/server`, ~54 kB
  gzip) — confirms the server runs on Node in Docker without a native SQLite build.
- **Enrichment verified around the model call, not through it.** No local Anthropic
  credentials (no `ANTHROPIC_API_KEY`, no `ant` CLI), so the live `messages.parse` +
  `zodOutputFormat` round-trip is UNTESTED. Everything else is verified: capture still 201s
  with the enricher wired in (no-key silent skip), and a synthetic enrichment exercises the
  event → projection precedence → API surface → rebuild-replay path end-to-end. **To finish
  verifying: set `ANTHROPIC_API_KEY` and `bun run enrich:pending`, or capture with a key set.**
  zod is v4 (`4.4.3`) and typechecks against the SDK's `zodOutputFormat` — watch for a
  runtime mismatch on the first real call.

## Things not to do
- Don't UPDATE/DELETE rows in `events` — the log is the source of truth.
- Don't give Siri shortcuts a read/agent token — capture scope only.
- Don't touch firefly / Caddy / DNS without explicit per-change authorization; work via ops repo.
- Don't commit real tokens or the SQLite data file.
