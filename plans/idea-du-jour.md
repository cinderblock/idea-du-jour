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

### Offline (PWA) — built
- **Capture never fails offline.** `QuickCapture` tries `webCapture`; on any failure it queues
  the raw text in `localStorage` (`src/ui/offline.ts`), shows it as a dashed "pending" card, and
  flushes on the `online` event + on inbox mount. Order-preserving flush stops at the first
  failure (keeps the rest queued). Verified: 12/12 unit assertions.
- **Offline reads + entry.** Loader caches the inbox (`localStorage`) and falls back to it when
  the fetch fails; route `beforeLoad` guards are resilient — on a network error they trust a
  durable `idj:authed` marker instead of bouncing to `/login` (online, an unauthed user is still
  redirected — verified 307). The service worker already serves the cached shell + assets offline.
- **iOS caveat (documented):** no Background Sync on iOS Safari, so the queue flushes when the
  app is next open + online, not in the background. No data loss either way. **Siri Shortcut
  capture is online-only** (HTTP POST can't queue) — offline capture is a PWA-only capability.
- Not exercised end-to-end in a browser here (needs a virtual authenticator + network toggle):
  **device test** = install PWA, airplane mode, capture (see "pending"), re-enable (it syncs).

### iPhone Shortcut — hand-built + iCloud link (file delivery abandoned)
- **DEAD END, do not rebuild:** generating a `.shortcut` file for tap-to-install does not
  work. **iOS only imports Apple-signed shortcut files** — the old "Allow Untrusted
  Shortcuts" escape hatch is gone — and signing requires a working Mac (see below). The
  generator, the `/shortcut` route and the plist files were all removed as dead weight.
- **The path that works:** build it by hand once from `/setup` (which has tap-to-copy for
  the URL and token), then **⋯ → Share → Copy iCloud Link** — that link re-installs it on
  any device forever. This is strictly better than a hosted file anyway.
- Recipe: Dictate Text → Get Contents of URL (`POST {base}/api/capture`, header
  `Authorization: Bearer <capture token>`, body **JSON** with one text field `text` = the
  Dictated Text variable). Note iOS offers only JSON/File/Form for the body — no Text —
  which is why `/api/capture` accepts both raw text and `{text: ...}`.
- **Signing: ABANDONED — do not retry without new information.** `shortcuts sign` needs an
  iCloud-authenticated GUI session. Verified on camerons-mini: SSH works, GUI console
  session exists, iCloud is logged in (`cameron@tacklind.com`, `LoggedIn=1`), iCloud Drive
  is on (`MOBILE_DOCUMENTS enabled=1`), Shortcuts.app has run (containers exist) — yet
  **no Shortcuts service is registered** on the account, there is **no "Options…" button**
  next to iCloud Drive in System Preferences, and signing always fails with
  `WFCloudKitErrorDomain Code=2 "you must be signed into iCloud"`. A LaunchAgent running
  *inside* the GUI session hits the identical error, which rules out session/TCC/sudo as
  the cause. Signing is only needed for tap-a-web-link installs.
- **Working alternatives (either is better than more signing work):** (a) build it once by
  hand from `/setup`, then ⋯ → Share → **Copy iCloud Link** — installs anywhere, forever;
  (b) enable *Settings → Shortcuts → Allow Untrusted Shortcuts* on the phone and import
  `/shortcut` directly.
- The drop-folder signer LaunchAgent (ops `16a269f`, installed on the mini) is fine and
  proven end-to-end — it fires, runs, and reports errors atomically. It'll just work if the
  Mac's iCloud/Shortcuts state is ever fixed.
- **The Shortcut's internal wiring is UNTESTED** (no iOS device here). If import misbehaves,
  the hand-build steps on `/setup` are known-good.

### Device pairing: no token typed on the phone — PHASE 1 IN PROGRESS (2026-11-10)
Requested by Cameron 2026-11-10 (relayed by the ops mini-signing thread): "do both and start
with the pairing". Goal: installing the shortcut never asks for a token.

**Phase 1: first-run pairing (building now)**
- The public signed `/shortcut` has no import question and no token.
- First run: the shortcut makes a long random device ID (SHA-256 of four random numbers plus
  the time: 64 hex chars), saves it to iCloud Drive `Shortcuts/idj/device-id.txt`, and reads
  it on later runs. Every capture sends headers `X-Idj-Device-Id`, `X-Idj-Device-Name`
  (URL-encoded, since names like "Cameron’s iPhone" aren't ASCII and a non-ASCII header can
  make iOS drop the request), and `X-Idj-Device-Model`.
- Server, `devices` table: `id` (ulid), `idHash` (SHA-256 of the device ID, unique; the raw ID
  is never stored), name, model, `status` (pending/approved/rejected/revoked), first/last
  seen, decided-at. A capture from an unknown ID creates a pending device and is stored in
  `pending_captures` (text, or audio kept under `audio/pending/`), not rejected, so nothing
  is lost.
- **Approve** releases the device's pending captures into the inbox with their original
  timestamps as ordinary `item.created` events (so `db:rebuild` replays them; transcription,
  enrichment and dispatch follow as for any capture). **Reject** deletes them and the
  device stays refused. **Revoke** stops an approved device. Rejected or revoked IDs get 403.
- Abuse limits for unapproved IDs: at most 20 pending captures per device, 25 MB of pending
  audio per device, 20 pending devices in total, and 30 requests a minute per IP across
  unapproved IDs. Past those limits: 429, and nothing is stored. A stranger with the
  public file can only fill the pending list; nothing reaches the inbox.
- Visibility: a banner on the inbox ("N captures waiting from a new device: review") plus a
  `/devices` page (name, model, first and last seen, pending count, Approve / Reject /
  Revoke).
- Token auth (`Authorization: Bearer`) keeps working unchanged; if both are sent, the
  token wins.
- The server answers with `message`, which the shortcut shows as its notification, so the
  wording ("Saved", "Saved; approve this phone at idj.isozilla.com/devices") is server-side.

**Phase 2 (later, not built): personal pre-signed download per device**
- Logged-in `/setup` "Install on this phone" creates an **already-approved** device, generates
  the shortcut with that device ID embedded (no first-run step), signs it, and serves it
  exactly once. Same server path and revoke as phase 1; the embedded ID is a credential.
- The hard part: firefly can't reach the mini (TSL LAN). Options:
  1. **Pull signer on the mini (recommended).** A LaunchAgent in the mini's GUI session
     long-polls `GET /api/sign/queue` on idj (agent-scoped token), signs locally, and posts
     the signed bytes back; the install page waits a few seconds, then downloads. Same shape
     as sentinel's whisper worker; all connections outbound; nothing exposed.
  2. Pull signer on sentinel relaying to the mini over the LAN (sentinel can reach the mini):
     one more hop, and still needs the mini.
  3. Expose the mini via a Cloudflare Tunnel with Access: inbound path to a GUI-session Mac;
     more attack surface. Not recommended.
  4. Pre-sign a pool of N device IDs ahead of time and hand them out: works while the mini is
     offline, but leaves unused credentials lying around. Not recommended.
  If the mini is offline, the page falls back to phase 1 (public file plus approval).
  Anything on ops or the mini needs Cameron's per-change approval.

### Installable signed shortcut — BUILT 2026-11-10 (`c5f2611`), signed on the Mac mini
**As built:** `scripts/gen-shortcut.ts` -> `build/record-to-idj.unsigned.shortcut`;
`scripts/sign-shortcut.sh` signs on `mini` over ssh pipes (scp from Git Bash + Windows
OpenSSH hangs) -> `public/record-to-idj.shortcut` (AEA1, committed, `*.shortcut binary` in
.gitattributes); `/shortcut` serves it as octet-stream; `/setup` step 2 links it. Signing on
the mini started working on its own (Apple ID credential renewal 2026-11-07, per the ops
thread; details in ops `plans/shortcut-signing-mini.md`). **Untested on the phone:** the
action plist was written from the known format, not copied from a working shortcut (the
phone's shortcuts haven't synced to the mini since June), so import or wiring may need fixes.

Original notes:
New information that reopens the signing dead end above: Cameron has a new **M1 Mac**. A fresh
macOS signed into his Apple ID shouldn't have the mini's broken Shortcuts/iCloud state.
Reuse ops `servers/camerons-mini/sign-shortcuts.sh` + `com.tacklind.shortcut-signer.plist`
(drop-folder LaunchAgent running in the GUI session; `shortcuts sign` can't run over plain SSH).
Plan: (1) M1 set up: Apple ID + iCloud Drive + Shortcuts iCloud Sync, Remote Login, stays
logged in; (2) prove `shortcuts sign` in its GUI session; (3) install the signer agent there
(ops, needs approval); (4) generator in idj for "Record to IDJ" (record-or-type, upload, notify)
with the capture token as an **import question**, so the signed file holds no secret;
(5) `/setup` serves the signed file; one tap installs it.
**Update 2026-11-10:** Cameron chose to fix the existing **Mac mini** instead (SSH alias `mini`,
10.255.2.207, macOS 12.7.6; `camerons-mini` alias fails host-key check). That work is in its own
thread: t3-thread://v2/ab3781d7-a1dd-4bbb-b3e9-6331e19b7569/mcp:fd2d4a5d-d2ae-4fa8-b740-99113645dfdc
(ops project). It reports back here when signing works; then steps (4)-(5) happen in idj.
Why: building shortcuts by tapping on the phone is slow and error-prone (empty header row,
2026-11-10), and a generated file is versioned with the API it calls.

### Voice capture: record audio + server-side Whisper — BUILT (idj side); Whisper host pending
Researched 2026-08-09 after the Math Camp dictation burst exposed both failure modes at once.
Decided 2026-11-10: transcription on `sentinel`. idj side built 2026-11-10:
- `POST /api/capture` takes a recording as the raw body (`audio/*`, `application/octet-stream`,
  magic-byte sniffed) or a multipart part. Saved to `<db dir>/audio/<itemId>.<ext>` (prod:
  `/srv/idj/data/audio`, on the `idj_app` volume), referenced from `item.created.payload.audio`.
- `src/server/transcribe.ts` posts it to `TRANSCRIBE_URL` (OpenAI-compatible
  `/v1/audio/transcriptions`) with a `Vocabulary: …` prompt (glossary env + top 30 tags), then
  appends `item.transcribed` and enqueues enrichment. A Nitro plugin
  (`src/server/plugins/workers.ts`) runs a retry sweep every 5 min. Unset URL = audio waits.
- `GET /api/items/:id/audio` (session cookie or agent token), byte ranges for Safari.
- Verified locally against a stub Whisper: raw/multipart/octet-stream uploads, 401 without
  token, 415 for non-audio, transcript parsed (`todo:`, `#tags`), download byte-identical,
  206 ranges, sweep picks up a recording after Whisper comes back, `db:rebuild` replay gives
  an identical projection.
- **Transcription runs on sentinel by PULL (2026-11-10, ops `1a8a390a`, approved).** firefly
  (DigitalOcean) can't reach sentinel (TSL LAN), so sentinel stack `idj-whisper` runs speaches
  0.8.3 (faster-whisper large-v3, GPU, nothing published) + a worker (idj image,
  `scripts/transcribe-worker.ts`) that long-polls `GET /api/transcribe/queue?wait=8`, fetches
  audio, transcribes, `POST /api/items/:id/transcript`. Agent token `sentinel-whisper`
  (prod token id `764caed7ee96`) in GitHub secret `SENTINEL_IDJ_AGENT_TOKEN`.
  `TRANSCRIBE_URL` (push mode) stays unset on firefly. Re-transcribe is queued
  (`item.transcription_requested`).

**Motivating evidence (real, from our own data).** Eight captures landed 18:32:16–18:34:21,
one continuous thought chopped into fragments by the dictation engine stopping on pauses:
"…two sets of tarps one for the shade pyramids" → "Some 10 by tens and some eight by tens"
→ "Those are all in a box". The 22- and 38-char items are pure artifacts of re-triggering.
Separately, domain nouns were mangled beyond recovery: "Just fall is" = *Tuzfal.isozilla*
(only decoded by grepping the ops repo for a matching server name), "shades structure tea
parts" = *shade structure T-parts*, and "the booze and late" is **permanently unrecoverable**
because we never kept the audio.

**The architectural argument.** Audio is the durable artifact; a transcript is a lossy
derivation. Storing only the derivation, produced by the weakest transcriber in the chain,
means transcription errors are permanent. Keeping the audio makes re-transcription a matter
of appending new events later — which is exactly the shape this codebase already has
(`item.created` → async worker → `item.transcribed` → existing `item.enriched`, all replayed
by `rebuildProjection`). Same fire-and-forget pattern as `src/server/enrich.ts`.

**Shortcuts support — verified by research, NOT on a device:**
- A `Record Audio` action exists and `Get Contents of URL` can send a file body, so the
  pipeline is buildable.
- **Siri-triggered `Record Audio` hangs** — since iOS 16.4 the record screen freezes when the
  shortcut is invoked by voice (developer.apple.com/forums/thread/727391). Same thread reports
  it working from the **Action button** on a 15 Pro. Our flow is Action-button-based so this
  may not bite, but "hey Siri, capture" is a dead end for audio.
- **Recording cannot start from a fully backgrounded state** (developer.apple.com/forums/thread/815725)
  — the shortcut must foreground. Fine for press-and-talk; rules out anything ambient.
- **iOS 18+ has a native on-device `Transcribe` action** — free and private, but reported
  flaky on long audio and offers no keyword biasing, so it fixes the cutoff and not "Just fall".
- **The cheap fix probably doesn't work:** `Dictate Text` → Stop Listening → *On Tap* is
  widely reported to stop on a pause anyway (discussions.apple.com/thread/255582634,
  talk.automators.fm/t/dictated-text-stops-prematurely/10946). Costs nothing to try; don't
  plan around it.

**Keyword biasing is a real, documented feature.** OpenAI's transcription endpoint takes a
`prompt` parameter to improve recognition of names/acronyms/domain vocabulary. Subtlety: it is
a *spelling/style exemplar*, not an instruction — feed it correct spellings, it will not obey
commands (cookbook.openai.com/examples/whisper_correct_misspelling). `whisper-1` caps at 224
tokens; `gpt-4o-transcribe` has more headroom. Glossary sources we already have: ops server
names (Tuzfal, Uberfall, Pokol, Beelzebub, Firefly, Jackson, Iris, Sentinel, Steamboat),
existing idj tags, and a hand-written Math Camp list (shade pyramids, T-parts, tarps, bins).

**Proposed shape (if we build it):**
1. `POST /api/capture` accepts multipart audio; store the file on disk under the existing
   `data` volume, append `item.created` referencing it with empty text.
2. Async transcriber worker (mirrors `enrich.ts`) → appends `item.transcribed` → fills
   body/first_capture. Enricher runs after, unchanged.
3. Server-side glossary builder generates the `prompt` per request.
4. Keep `Dictate Text` on the share sheet for one-liners (instant, no upload); Action button
   becomes the record-audio brain-dump path.

**Risk to design for:** a lost 3-minute recording is far worse than today's failed text POST.
The Shortcut should save to Files first and upload second, so a dead network never eats audio.

### Agent dispatch: idj capture -> T3 Code thread — BUILT 2026-11-10 (idj `b10b7ec`, ops `e65ec359`)
**As built:** idj POSTs `{event:"idj.capture", itemId, kind, voice, createdTs, url}` signed
`X-Idj-Signature: sha256=<hex HMAC>` to T3 webhook task "idj: dispatch captures to threads"
(`scheduled-task:170e6542-f298-4848-a8b7-7d22462439db`, project idea-du-jour, fresh session per
run; filters `body.event == idj.capture`, dedupe `{{body.itemId}}`, signature header
`x-idj-signature`). URL = `https://t3.isozilla.com/api/hooks/<task>/<token>` (token is not
shown by the T3 tool; read from `~/.t3/userdata/statev2.sqlite` `scheduled_tasks.webhook_token`).
Secrets: ops `FIREFLY_T3_DISPATCH_URL`, `FIREFLY_T3_DISPATCH_SECRET`. The task reads the item,
picks a project (or `scratch`), `t3_thread_launch` with `auto-accept-edits`, comments
`T3 thread: <link>` on the item, and skips items that already have a `t3-thread://` comment.
Only open items created in the last 24 h are sent; voice after transcription; sweep every 2 min.
Tested 2026-11-10: bad signature 401, wrong token 404, replay "duplicate", real delivery ->
thread + link-back in ~70 s (test thread archived).

**Original proposal (kept for the reasoning):**
Asked 2026-11-10: have T3 Code notice captures addressed to it and start or continue threads.

**What T3 Code offers (checked 2026-11-10):** `schedule_task` takes a trigger of
`interval` (min 60 s), `fixed_time`, `once`, or **`webhook`**. A webhook task gets a URL
(needs T3 Connect remote access on), can filter on `body.*` / `headers.*`, verify an HMAC
signature, dedupe and coalesce, and hold deliveries that arrive while the PC is offline
(`maxDeliveryAgeMinutes`). Each run is an agent turn that can call `t3_thread_launch` /
`t3_thread_send`. No scheduled tasks exist yet.

**Proposed shape (push, not poll):**
1. Addressing: none (decided 2026-11-10). Every capture is dispatched.
2. idj server: after capture, POST `{itemId, project?}` (no text) to
   the T3 webhook URL, HMAC-signed. Fire-and-forget like `enrich.ts`; failures are retried
   from a `dispatchedTs` column, never block capture.
3. T3 webhook task (filter `body.itemId exists`, dedupe on itemId): a dispatcher prompt
   fetches the item with the agent token, picks the project (`t3_project_list`), launches
   a thread (or `t3_thread_send` to one referenced in the capture), then comments the thread
   link back on the idj item so the phone shows where it went.
4. Fallback: a low-frequency `interval` task (e.g. hourly) that sweeps `/api/events?since=`
   for addressed items with no dispatch comment, in case a webhook was lost.

**No Connect needed (found 2026-11-10):** the T3 server itself serves webhooks at
`POST /api/hooks/<taskId>/<token>` on its own HTTP listener (`apps/server/src/scheduledTasks/
webhookRoute.ts` in `~/git/t3code`). Connect only supplies a public base URL
(`relayHookBaseUrl`); with Connect off the task still has `webhook.path`, just `url: null`.
**Network path: already there.** `t3.isozilla.com` is a Cloudflare Tunnel (`noook`) to this
desktop's T3 on `127.0.0.1:3773` (ops `cloudflare/config/isozilla/isozilla.com.yaml`), with no
Access gate in front. So idj POSTs straight to
`https://t3.isozilla.com/api/hooks/<taskId>/<token>`. No infra change, no bridge, no Connect.
The token in the path plus an HMAC secret are the auth; store both as idj env vars.

**Security:** this turns the write-only capture token into "can start an agent on the desktop".
Mitigations: webhook carries only an id (the text is fetched, and treated as the user's prompt
only because it came from an authenticated capture); HMAC on the webhook; launched threads
default to a non-full-access runtime mode; maybe require an addressed capture to come from a
token flagged `dispatch` rather than any capture token.

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
**SUPERSEDED (2026-07-22): migrated to the house runner pattern — see "Deploy v2" below.**
The stack shipped the first deploy but had no push-to-deploy; ops owns the pull, so an idj
push did nothing until an ops deploy ran. Rather than bolt on a cross-repo dispatch PAT, we
moved to the pattern the other 8 apps already use.

~~**Chosen pattern: ops-managed "stack"** (like `nginx-cache`), NOT the socket/runner pattern
(bins/camptool).~~ Firefly's `deploy.sh` iterates `servers/firefly/stacks/*/compose.yml`,
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

### Deploy v2 — house runner pattern (bins/camptool/smtp-bridge)
Why: consistency ("10 deploy patterns is a headache") + real push-to-deploy with **no
cross-repo token from idj**. ops holds a per-app PAT and registers a runner INTO the app
repo — the established mechanism (`servers/lib/ensure-github-runner.sh` documents it).

- **Shape:** one container on firefly = GH runner + the app. Push → `deploy.yml` runs on
  `[self-hosted, idj]` *inside* that container → build, stage `/srv/idj/releases/<sha>`,
  `ln -sfn current`, `touch restart` → supervisord restarts app → health check polls
  `/api/version` until it reports the pushed SHA. Releases pruned to last 5.
- **socat bridge (idj-only deviation):** bins binds its own unix socket via
  `Bun.serve({unix})`; idj is served by **Nitro**, whose listener takes only a TCP port
  (verified: node preset, bun preset, and srvx all lack unix support). socat maps
  `/run/idj/idj.sock` → `127.0.0.1:3000` inside the container, so the external contract
  (socket volume shared with Caddy, zero published ports) matches bins exactly.
- **SESSION_SECRET is generated once and REUSED** by `ensure-idj-runner.sh` (re-generating
  it would invalidate the passkey session cookie on every deploy).
- **Data migration built in:** `ensure-idj-runner.sh` copies `idj.db` from the retired
  stack's `idj_data` volume into `idj_app:/srv/idj/data` on first run, guarded so it never
  clobbers live data.
- **Retired:** `Dockerfile`, `.github/workflows/build.yml` (ghcr image deploys),
  `servers/firefly/stacks/idj/`, and the `OPS_DISPATCH_TOKEN` idea.
- **User setup required in ops:** environment `idj-runner` + secret `IDJ_RUNNER_PAT`
  (fine-grained PAT, Administration:RW on `cinderblock/idea-du-jour`). **DONE** — env created
  by Claude, PAT set by Cameron 2026-08-04.
- **SHIPPED 2026-08-04.** ops `ef7369d`; first self-deploy served `f52c7fb` with data intact
  (`hasUser:true`). Cutover gotchas hit and fixed:
  - every `containers/*` dir must ship `prepare-dependencies.sh` answering `--list` (returns
    `{}` here) or the build pipeline fails; and Windows drops exec bits — `git update-index
    --chmod=+x` the shell scripts to match bins.
  - the retired stack container came back up after `docker stop` (daemon restart +
    `unless-stopped`); it is no longer ops-managed, so it was `docker rm -f`'d by hand.
    `idj_data` volume + `~/idj-backups/*.tgz` on firefly retained as rollback.
  - prune step: `grep -v` exits 1 when it filters everything out, and `pipefail` turns that
    into a failed deploy on the first release — wrap in `{ ... || true; }`.

## Answers locked (2026-11-10)
1. **Transcription runs on `sentinel`** (self-hosted faster-whisper). Not the OpenAI API.
2. **Audio first**, agent dispatch second.
3. **Dispatch: no prefix.** Every capture goes to T3 and gets a thread; the agent works out
   what it is and which project. Sorting happens later, in the thread.
4. **Auto-started threads run with auto-accept edits**, not full access.
5. **Never T3 Connect.** idj talks to our own T3 server directly; fork changes are fine.

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
- [x] **LIVE at https://idj.isozilla.com** — public GitHub repo + ghcr image, ops stack/Caddy/DNS
      applied to firefly. Verified: `/api/auth/me` responds, `/` gates (307), TLS via Cloudflare.
- [x] Prod capture + agent tokens minted (via `docker exec idj bun -` over SSH); verified
      capture→read→scope end-to-end over HTTPS. Triage skill `.env.local` now points at prod.
- [x] Siri Shortcut recipe documented in README ("Capture to idj").
- [ ] **Create your passkey on prod to claim the inbox** — still `hasUser:false` (first
      registrant wins). Build the Siri Shortcut with the minted capture token.
- [ ] Dockerfile + compose; backups. Deploy to firefly (gated).
- [x] Voice capture endpoint + transcriber + playback (2026-11-10).
- [x] Shipped: idj `916e191` (ops `edcdfe27`), then `c53dbb9` (ops `1a8a390a`).
- [x] Pull worker + sentinel stack `idj-whisper` (idj `c53dbb9`, ops `1a8a390a`).
- [x] sentinel deploy verified; GPU transcription checked with real speech (glossary fixes
      "tusful" -> "Tuzfal").
- [x] Caddy 10 MB body cap on idj removed at user's request (ops `1b3c5c65`).
- [x] **Voice capture verified end to end 2026-11-10 4:52 PM PST (00:52Z):** Action button ->
      idj (96 KB m4a) -> sentinel worker -> "This is a test. Does it work?" in 3.0 s.
      Shortcut: Record Audio -> Save File -> Get Contents of URL (File body) -> Get Dictionary
      Value `id` -> If has any value: notification, Otherwise: Show Result.
- [x] idj -> T3 dispatch built and approved (idj `b10b7ec`, ops `e65ec359`).
- [x] Dispatch live on firefly (`b10b7ec` + ops `e65ec359`), env verified.
- [ ] Phone test of dispatch: one quick-tap typed capture + one voice capture -> threads.
- [x] Signing works on the mini (ops thread); generator + signed install shipped (`c5f2611`).
- [ ] User installs and tests both paths (record, quick-stop type); superseded by pairing.
- [ ] **Current:** device pairing phase 1 (section above).
- [ ] Device pairing phase 2: design only, waiting for Cameron's go-ahead.
- [x] Agent-maintained vocabulary (`916e191`): `glossary_versions` table, `GET/PUT /api/glossary`,
      `POST /api/items/:id/retranscribe`. T3 scheduled task "idj: maintain Whisper vocabulary"
      (`scheduled-task:11fa3070-f3d3-4d51-9503-8d9751c1abe1`, project idea-du-jour, daily 4:00 AM
      local, fresh session per run) reads transcripts, PUTs new versions, re-transcribes ≤10/run.
- [x] Pin for `916e191` approved and pushed.

## Findings / gotchas
- **iOS "The network connection was lost" from Get Contents of URL = an empty header row**
  (found 2026-11-10). The request never leaves the phone: idj, Cloudflare and even a
  non-Cloudflare URL on firefly all "fail" identically, and no server logs anything. Ruled out
  first, at length: Cloudflare (h1, h2, chunked, streamed uploads all fine), Caddy's body cap,
  the app. Check the shortcut's Headers list for a blank row before debugging servers.
- **Pushing idj `master` IS a deploy (since ops Renovate "App deploys").** Renovate follows
  idj's `:latest` and fast-forwards ops `master` (automerge, any time), which deploys. That is
  how the broken `be9bde7` reached prod: ops `3fa934d7`, 2026-11-07 9:31 AM PST (17:31Z),
  and idj answered 500 to everything until 2026-11-10 3:50 PM PST (23:50Z). Captures sent in
  that window were lost (the "Start threads for unhandled messages" thread is re-collecting
  them). So: never push idj `master` without booting the build and making a request first.
- **firefly can't reach sentinel**, and sentinel's services are LAN-only. Anything firefly
  needs from sentinel is a pull from sentinel's side.
- **SimpleWebAuthn 14 broke every request once bundled (found + fixed 2026-11-10, `cd4c7bb`).**
  The Renovate batch (`be9bde7`, merged 2026-11-06) built and typechecked fine, but the server
  answered 500 to everything, `/api/version` included: `tsyringe requires a reflect polyfill`.
  v14 pulls in `@peculiar/x509` (tsyringe); Nitro's bundle loses SimpleWebAuthn's
  `import 'reflect-metadata'`. Fix: `@simplewebauthn/server` is external in `vite.config.ts`.
  Lesson: CI build + typecheck doesn't prove the server boots; smoke-test a request.
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
- **First firefly deploy failed: `ghcr … denied` on the stack pull** — even though the image is
  public (anon `HEAD` = 200). Cause: `deploy.sh` only logged into ghcr AFTER the stacks loop, so
  the pull used a stale/expired `GITHUB_TOKEN` from a prior deploy → docker sends it instead of
  falling back to anonymous → denied. Fix (ops commit `fccb667`): `docker login ghcr.io` before
  the stacks loop, guarded on REGISTRY creds. Redeploy succeeded. General fix for any ghcr stack.
- **Applied ops changes via an isolated git worktree off `origin/master`** (the main ops checkout
  was on `ask-worker` with unrelated WIP). CF `bun run sync` is dry-run by default (`APPLY=1` to
  apply); it showed exactly `+ CNAME idj.isozilla.com (proxied)`, 0 deletes. Pushed
  `idj-deploy:master`; ops CI (Cloudflare + Server Deploys) applied it. Worktree cleaned up.
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

## Open questions for the user
1. ~~**Where does transcription run?**~~ Answered 2026-11-10: `sentinel`. (a) self-hosted faster-whisper on `sentinel` — no
   per-token cost, no audio leaves our infra, but that GPU has a documented habit of silently
   dying on NVIDIA driver upgrades (it has a `/health` probe for exactly this); survivable
   because transcription is async and retryable, so a dead GPU means untranscribed, not lost.
   (b) OpenAI API — low effort, negligible cost at ~2 min/day, but a new vendor and the audio
   leaves the building. *No recommendation yet — this is a values call, not a technical one.*
2. ~~**Device tests needed before any server work**~~ Answered 2026-11-10: Record Audio from
   the Action button + File body upload work (after removing an empty header row). (5 minutes, needs the phone): does
   `Get Contents of URL` cleanly post a `Record Audio` output as multipart, and how does
   `Record Audio` actually behave from *your* Action button on *your* iOS version?

3. ~~Agent dispatch network path~~ Answered 2026-11-10: push to `t3.isozilla.com` (exists).

## Things not to do
- Don't send shortcuts to Cameron by iMessage (BlueBubbles) for now: after those sends his
  iPhone showed "Messages not syncing to iCloud" prompts (under investigation in the ops
  thread). Install by Safari download from `/shortcut` instead.
- Don't use T3 Connect for anything (user refuses it).
- Don't wire audio capture to a **Siri voice trigger** — `Record Audio` hangs when invoked by
  Siri (iOS 16.4+). Action button only.
- Don't rely on `Dictate Text` → Stop Listening → *On Tap* to fix the early-cutoff problem;
  it's reported to stop on a pause regardless.
- Don't UPDATE/DELETE rows in `events` — the log is the source of truth.
- Don't give Siri shortcuts a read/agent token — capture scope only.
- Don't touch firefly / Caddy / DNS without explicit per-change authorization; work via ops repo.
- Don't commit real tokens or the SQLite data file.
