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
- **Web auth:** Passkey / WebAuthn (Face ID). Single-user; first visit creates a passkey,
  after that the inbox is locked to it. Session is a signed cookie; web routes + server
  functions require it. *(Ceremony needs a real authenticator to exercise — see plan.)*
- **API auth:** bearer tokens — *capture* (write-only, for Siri) and *agent* (read + comment).
- **Agent enrichment:** captures are asynchronously classified/tagged/summarized by Claude
  (`claude-sonnet-5` via the Anthropic SDK) and written back as an `item.enriched` event —
  off when no `ANTHROPIC_API_KEY` is set. Never blocks or fails the capture path.
- **Hosting:** a container on `firefly` behind Caddy (HTTPS) at `idj.isozilla.com`. This
  repo's CI publishes `ghcr.io/cinderblock/idea-du-jour:<sha>` on push and stops there;
  **which build runs is pinned in the ops repo** (`cinderblock/ops`,
  `servers/firefly/stacks/idj/pin.json`), and only an ops push changes it.

## Capture (iPhone)

A Siri Shortcut POSTs dictated text to `/api/capture` with a *capture* bearer token. The
endpoint accepts raw `text/plain` or JSON `{text, kind?, tags?}`; leading `todo:`/`idea:`/
`rem:` set the kind, `#tags` are auto-extracted, and the raw text is kept verbatim.

### Shortcut recipe — "Capture to idj"

In the Shortcuts app, create a shortcut with these actions:

1. **Dictate Text** — captures speech and returns it as text. (For a typed note instead, use
   *Ask for Input → Text*. For share-sheet capture, skip this and use *Shortcut Input*.)
2. **Get Contents of URL**
   - **URL**: `https://idj.isozilla.com/api/capture`
   - **Method**: `POST`
   - **Headers**: `Authorization` = `Bearer <your capture token>`
   - **Request Body**: `Text` → the `Dictated Text` from step 1
     *(sent as `text/plain`; the endpoint parses keywords/tags and stores it)*
3. *(optional)* **Show Notification** / **Vibrate** to confirm it landed.

**Bind to the Action button:** Settings → Action Button → Shortcut → *Capture to idj*. Now
hold the Action button, speak, and it lands in your inbox.

**Share-sheet variant:** duplicate the shortcut, turn on *Show in Share Sheet* (accept Text +
URLs), delete the Dictate step, and set the Request Body to *Shortcut Input* — lets you send
selected text or a link to idj from any app.

### Voice capture — "Record to idj"

For anything longer than a sentence, record audio instead of dictating. Dictation stops
on a pause and mishears names; a recording keeps everything, and the server transcribes
it with Whisper, biased toward your own vocabulary (server names, your tags). The
recording is kept, so a bad transcript can always be redone.

1. **Record Audio** — Audio Quality *Normal*, Start Recording *Immediately*, Finish
   Recording *On Tap* (it never stops on a pause).
2. **Save File** — save the *Recorded Audio* to iCloud Drive (e.g. `Shortcuts/idj`), *Ask
   Where to Save* off. A dead network can then never lose a recording.
3. **Get Contents of URL** — `https://idj.isozilla.com/api/capture`, `POST`, header
   `Authorization` = `Bearer <capture token>`, **Request Body: File** → *Recorded Audio*.
4. *(optional)* **Show Notification** to confirm it landed.

**If it fails with "The network connection was lost":** look for an empty row in *Get
Contents of URL → Headers*. A header with a blank key or value makes iOS drop the request
before it leaves the phone, so no server ever sees it. (Duplicating a shortcut can carry
one over.) `/api/echo` is the place to point a misbehaving shortcut: it reports exactly
what arrived and saves nothing.

Bind it to the **Action button**. Don't trigger it with "Hey Siri": since iOS 16.4 *Record
Audio* freezes when a shortcut is started by voice.

The endpoint takes the recording as the raw body (`audio/*` or `application/octet-stream`)
or as a multipart form part, up to 50 MB (Caddy in front caps bodies at 10 MB, about
20 minutes at *Normal*). It answers `{"id": …, "audio": true}` at once; the item shows
"Transcribing…" until the transcript lands, then gets enriched like any other capture. If
the Whisper server is down or not configured, recordings wait and a sweep retries them
every 5 minutes; `bun run transcribe:pending` forces it.

**Where transcription runs.** Two modes, same result:
- *Pull (production):* `bun run transcribe:worker` (`scripts/transcribe-worker.ts`) runs on
  the GPU box (sentinel) next to a [speaches](https://github.com/speaches-ai/speaches)
  (faster-whisper) container. It long-polls `/api/transcribe/queue` over HTTPS, transcribes
  locally, and posts the text back, so the GPU box needs no inbound access. New captures
  wake it at once. Env: `IDJ_BASE_URL`, `IDJ_AGENT_TOKEN`, `WHISPER_URL`, optional
  `TRANSCRIBE_MODEL` / `TRANSCRIBE_LANGUAGE` / `WHISPER_API_KEY`.
- *Push:* set `TRANSCRIBE_URL` on the idj server and it calls Whisper itself.

**The vocabulary is agent-maintained.** Whisper is primed with a word list (`/api/glossary`,
versioned, append-only) plus your most-used tags. A scheduled T3 Code task reads recent
voice transcripts, spots names Whisper got wrong, updates the list with a note saying why,
and re-transcribes the affected recordings. Until the first version is saved, the
`TRANSCRIBE_GLOSSARY` env default is used.

> The capture token is **write-only** (it can only append), so a shortcut leaking it can't
> read your inbox. Mint one against prod with
> `docker exec idj bun run token:mint capture "siri"` (or the settings UI, once built).

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
external agents. The web UI is passkey-gated (WebAuthn).

**Offline:** the installed PWA keeps working with no network — captures queue locally
(`localStorage`) and sync when you reconnect (on the `online` event / next open), the last
inbox is cached for offline reads, and queued items show as "pending". iOS has no Background
Sync, so syncing happens when the app is next open + online (nothing is lost). Note that
**Siri Shortcut capture needs a live connection** — offline capture is a PWA-only feature.

## Token API (Siri + agents)

| Method + path | Scope | Purpose |
|---|---|---|
| `POST /api/capture` | capture | Append an item (raw text, JSON, or an audio recording). |
| `GET /api/items?status=&kind=&limit=` | agent | List/query items. |
| `GET /api/items/:id` | agent | One item + its full event history. |
| `GET /api/items/:id/audio` | agent | A voice capture's original recording (also the web session). |
| `POST /api/items/:id/retranscribe` | agent | Queue a recording to be transcribed again with the current glossary (202). |
| `GET /api/transcribe/queue?wait=8` | agent | Long-poll work queue for a remote transcription worker. |
| `POST /api/items/:id/transcript` | agent | A worker's transcript: `{text, model, prompt?}`. |
| `GET /api/glossary?history=N` | agent | Whisper vocabulary, the prompt it produces, past versions. |
| `PUT /api/glossary` | agent | New vocabulary version: `{terms, note}`, most important first. |
| `POST /api/items/:id/comment` | agent | Add a comment (raw text or `{text}`). |
| `POST /api/items/:id/done` · `/reopen` | agent | Change status. |
| `GET /api/events?since=<seq>` | agent | Append-only cursor feed (`nextCursor`). |

## Development

See scripts: `bun run dev` · `typecheck` · `build` · `db:migrate` · `db:generate` ·
`db:rebuild` (replay log → projection) · `token:mint <capture|agent> "<label>"` ·
`icons:gen` (regenerate PWA icons) · `enrich:pending` (enrich items captured before a key existed) ·
`transcribe:pending` (transcribe recordings that are still waiting).

### Every capture starts a T3 Code thread (agent dispatch)

When `T3_DISPATCH_URL` and `T3_DISPATCH_SECRET` are set, each new open capture is handed
to a T3 Code webhook task ("idj: dispatch captures to threads", project idea-du-jour). Text
captures go at once; voice captures go once transcribed. The task reads the item with its
own agent token, picks the project (or a scratch thread when none fits), starts a thread
with `auto-accept-edits`, and comments `T3 thread: <link>` back on the item.

- The delivery is `POST {itemId, kind, voice, createdTs, url}`, signed
  `X-Idj-Signature: sha256=<hex HMAC-SHA256 of the body>`. No capture text rides along.
- `T3_DISPATCH_URL` is the task's own webhook (`https://t3.isozilla.com/api/hooks/<task>/<token>`),
  served by T3 itself through its Cloudflare tunnel; T3 Connect isn't involved.
- A failed delivery is retried every 2 minutes for a day. Older captures, and items
  already marked done, are never sent, so switching it on can't flood T3. T3 also
  dedupes on the item id.

### Reading the inbox with Claude (the `idj-triage` skill)

`.claude/skills/idj-triage/` is a Claude Code skill for reading and working through the
inbox — say "check idj", "read my idj notes", "what did I capture this week", or "triage my
inbox" and Claude reads your open items via the agent API, reasons across the whole set
(cluster, dedupe, next actions, stale items), and writes back comments / done / reopen.
Runs on your Claude subscription (no API bill).

**Install it once, use it from any project.** The skill only auto-loads while Claude's
working directory is this repo; linking it into `~/.claude/skills/` makes it load
everywhere. It's a link, not a copy, so the token and the skill text have one home.

```sh
bun run token:mint agent "claude-triage"          # prints a one-time agent token
cp .claude/skills/idj-triage/.env.example .claude/skills/idj-triage/.env.local
#   -> paste the token into .env.local (IDJ_BASE_URL is already production)
bun run skill:install                             # links ~/.claude/skills/idj-triage
```

`bun run skill:install` is idempotent (re-running reports "already linked") and refuses
to overwrite anything that isn't a link back to this repo; `bun run skill:install
--remove` unlinks. Under the hood it is a directory junction on Windows and a symlink
elsewhere — the manual equivalents, if you'd rather not run the script:

```powershell
# Windows (PowerShell) — no admin or developer mode needed for a junction
New-Item -ItemType Junction -Path "$HOME\.claude\skills\idj-triage" -Target "$PWD\.claude\skills\idj-triage"
```

```sh
# macOS / Linux
mkdir -p ~/.claude/skills && ln -s "$PWD/.claude/skills/idj-triage" ~/.claude/skills/idj-triage
```

Then start (or restart) Claude Code anywhere and ask it to check idj. The token file
is gitignored; the *capture* token stays write-only, so an agent token is the only one
that can read.

### Layout
- `src/db/` — Drizzle schema (`events`, `items`, `tokens`, `users`, `credentials`),
  libsql client, migrator.
- `src/server/` — `events.ts` (append + project + rebuild), `tokens.ts` (bearer
  auth/scopes), `capture.ts` (keyword/tag parsing), `webapi.ts` (web server functions),
  `env.ts`.
- `src/routes/` — web UI (`index.tsx`, `items.$id.tsx`) + `api/` token endpoints.
- `src/ui/` — presentation helpers. `scripts/` — token mint, projection rebuild, icon gen.
- `public/` — PWA manifest, service worker, icons.
