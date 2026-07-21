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

### Claude skill (system skill)
- A skill that calls the *agent* API: `GET /api/items?status=open` for recent/unfinished,
  posts comments back. Lives in skills dir; token from local config/env, not committed.

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
- [ ] Repo scaffold: TanStack Start + Bun + Drizzle + SQLite; README.
- [ ] DB schema + migration (`events`, `items`, `tokens`, `users`/`credentials`).
- [ ] Event append + projection layer (write event → update projection; replay/rebuild fn).
- [ ] `POST /api/capture` + token middleware (capture scope). Test with curl.
- [ ] Read/query endpoints + agent-scope middleware.
- [ ] WebAuthn register/login + session; guard web routes.
- [ ] Triage PWA UI (inbox list, item detail + comments, done/tag). Manifest + SW.
- [ ] Token management settings page.
- [ ] Siri Shortcut recipe (documented in README).
- [ ] Claude skill hitting the agent API.
- [ ] Dockerfile + compose; backups. Deploy to firefly (gated).

## Findings / gotchas
- (none yet)

## Things not to do
- Don't UPDATE/DELETE rows in `events` — the log is the source of truth.
- Don't give Siri shortcuts a read/agent token — capture scope only.
- Don't touch firefly / Caddy / DNS without explicit per-change authorization; work via ops repo.
- Don't commit real tokens or the SQLite data file.
