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

## Open questions for the user
1. **Domain/hostname** on firefly? e.g. `idea.<domain>`, `todo.<domain>`, `brain.<domain>`.
   (Needed for Siri shortcut + Caddy; not blocking local dev.) Recommendation: short, memorable.
2. **"Kinds" + keyword syntax** for v1. Proposal: everything is an *item*; default kind `note`.
   Lenient parse of leading keyword: `todo:`/`t:` → task, `idea:` → idea, `memory:`/`rem:` →
   memory. `#tags` extracted anywhere. Raw text always stored verbatim regardless. OK?
3. **Backups**: Litestream (continuous → object storage) vs. cron `sqlite3 .backup`.
   Recommendation: Litestream once hosted; cron is fine early.

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

### Deployment (LATER — gated by infra authorization rules)
- Docker image (Bun), SQLite on a mounted volume, behind firefly's Caddy (HTTPS).
- **Any firefly/Caddy/DNS change requires explicit per-change authorization and goes
  through the ops repo** (`~/git/Personal Projects/ops`). Do not touch infra directly.

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
