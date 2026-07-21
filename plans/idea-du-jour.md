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

### Auth (built)
- **Web = passkeys.** `@simplewebauthn/server` ceremonies as API routes under
  `/api/auth/*` (register options/verify, login options/verify, logout, me). Single-user:
  first `register/options` with no user bootstraps; once a user exists, unauthenticated
  registration is closed (adding more passkeys requires a session).
- **Session = HMAC-signed cookie** (`idj_session`, 30d), stateless — no session store.
  WebAuthn challenge carried in a separate short-lived signed cookie (`idj_webauthn`, 5m).
  Cookies signed with `SESSION_SECRET`. Writes set `Set-Cookie` on the route Response;
  reads via ambient `getCookie` (`currentUserId`) or raw request (`userIdFromRequest`).
- **Gating:** web routes (`/`, `/items/$id`) `beforeLoad` → `getAuth()` → `redirect('/login')`
  if no session; every web server function calls `requireUserId()` (guards the RPC endpoints
  directly, not just the UI). `/login` is public. The token API (`/api/capture`, `/api/items`,
  `/api/events`) is unchanged — bearer tokens for Siri/agents, independent of the session.
- **Config:** `RP_ID` (localhost dev / idj.isozilla.com prod), `RP_ORIGIN`, `SESSION_SECRET`.
- Tokens: `tokens` table, value **hashed** (prefix + hash), `scope`, `label`, `created_ts`,
  `last_used_ts`. Manage from a settings page (TODO), alongside passkey management.

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
**Chosen pattern: ops-managed "stack"** (like `nginx-cache`), NOT the socket/runner pattern
(bins/camptool). Firefly's `deploy.sh` iterates `servers/firefly/stacks/*/compose.yml`,
generates `.env` from each stack's `env.json` (auto-generates `SESSION_SECRET`), and does
`docker compose pull` + `up -d`. Simpler than a self-hosted runner-in-container, and needs
**no change to Caddy's compose** — Caddy is `network_mode: host`, so it proxies straight to a
loopback port. This is why we switched off the earlier bins/socket plan.

Full picture + staged files live in **`deploy/`** (`deploy/README.md`, `deploy/ops-staged/`).

App-side (this repo — built + prod-runtime verified):
- `Dockerfile` (Bun build + slim runtime; migrate-on-boot; serves Nitro output on `PORT`),
  `.github/workflows/build.yml` (push → `ghcr.io/<owner>/idea-du-jour:{latest,sha}`).

Ops changes (GATED — per-change auth; `bun run sync` dry-run before CF commit):
1. **DNS** — one line under firefly `proxies:` in `isozilla.com.yaml` (proxied, like vikunja).
2. **Caddy site** — `sites.d/idj.isozilla.com.caddy` → `reverse_proxy 127.0.0.1:18787`.
3. **Stack** — `stacks/idj/compose.yml` + `env.json` (ghcr image, `data` volume, loopback
   `127.0.0.1:18787:3000`). Committing 2+3 to ops master triggers the deploy workflow.

Prereqs needing the user: (a) idj on GitHub (`cinderblock/idea-du-jour` assumed — image name);
(b) **make the ghcr package public** (stack pull runs without registry login); (c) enrichment
stays OFF in prod (no `ANTHROPIC_API_KEY`) — triage skill is the primary path.

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
- [x] WebAuthn register/login + signed-cookie session; web routes redirect + server
      functions `requireUserId`. **Passkey ceremony untested (needs a real authenticator).**
- [ ] Token management settings page (+ passkey management: list/add/remove).
- [ ] Siri Shortcut recipe (documented in README).
- [x] Claude triage skill (`.claude/skills/idj-triage/`) — whole-inbox reasoning via agent API.
- [x] Deploy artifacts: Dockerfile + CI (prod runtime verified); ops changes staged in `deploy/`.
- [ ] Go live: idj→GitHub, public ghcr package, apply gated ops changes, first passkey on prod.
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
- **Server-side request/cookie helpers** (`getCookie`/`setCookie`/`getRequest`/`useSession`,
  h3-style) are re-exported through `@tanstack/react-start/server` (→ react-start-server →
  start-server-core). Usable in server functions AND route handlers via ambient ALS context.
- **SimpleWebAuthn v13 byte-array typing:** `WebAuthnCredential.publicKey` /
  `generateRegistrationOptions.userID` want `Uint8Array<ArrayBuffer>`, but `Buffer.from(...)`
  yields `Uint8Array<ArrayBufferLike>` (TS rejects it). Use `Uint8Array.from(buf)` and
  annotate the return `Uint8Array<ArrayBuffer>`.
- **Service worker can't precache `/`** now that it redirects to `/login` when unauthed —
  a redirected response throws on `cache.put`. Dropped `/` from the precache SHELL; the nav
  handler caches it opportunistically only when `res.ok && !res.redirected` (bumped `idj-v2`).
- **Deploy: firefly uses a "stack" loop** in `servers/firefly/deploy.sh` — per-stack
  `env.json`→`.env` (with `generate` for secrets), `docker compose pull` + `up -d`, config-hash
  force-recreate. Triggers: weekly cron, ops push touching `servers/**`, or `workflow_dispatch`.
  **Stacks pull with NO registry login** (login is later, for Caddy) → the idj ghcr image must
  be **public**, else move `docker login` before the stacks loop (an ops change). `PREFIX` =
  `FIREFLY_`; `env.json` non-generated keys read `FIREFLY_<KEY>` secrets/vars, empty-string
  defaults still error (use a real default or omit the key).
- **No Docker on this machine** — the image build is unverified locally (CI builds it). But the
  container's exact runtime IS verified: `bun run db:migrate && bun .output/server/index.mjs`
  with `HOST`/`PORT`/`DATABASE_URL` env serves the prod build (307 gate + `/api/auth/me` OK).
- **Auth verified around the ceremony, not through it.** No WebAuthn authenticator available
  here, so register→login with a real passkey is UNTESTED. Verified: `/` redirects (307) when
  unauthed, `/login` is public, `/api/auth/me` reports no user, and register/login `options`
  return valid challenges + set the signed cookie. **To finish: test on a device with a
  passkey (iOS Face ID / a laptop), or drive a CDP virtual authenticator.**
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
