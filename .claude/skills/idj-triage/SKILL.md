---
name: idj-triage
description: Read the user's idea-du-jour (idj) capture inbox and work through it with Claude — fetch open items, reason across the whole set (cluster, dedupe, surface next actions, spot stale items), pull out feature requests for a project, and write back comments / done / reopen via the agent API. Use when the user says "check idj", "check for idj entries", "read my idj notes", "what did I capture", "find <project> features in idj", "triage my inbox", "process my idj items", "go through my ideas", or similar.
---

# idea-du-jour triage

Work through the user's personal capture inbox (idea-du-jour) as a thinking partner —
not a dumb per-item classifier. Read the whole open set, reason across it, and take
actions the user confirms. This runs on the user's Claude subscription (you, here),
so lean into whole-inbox reasoning that the server-side per-item enricher can't do.

## 1. Load config

Read the base URL and agent token, in this order:

1. Env vars `IDJ_BASE_URL` and `IDJ_AGENT_TOKEN`.
2. Otherwise the `.env.local` file **in the same directory as this SKILL.md** (KEY=value
   lines; gitignored). That works whether the skill was loaded from the idj repo
   (`.claude/skills/idj-triage/.env.local`) or from the global link
   (`~/.claude/skills/idj-triage/.env.local` — a junction/symlink back into the repo, so
   it is the same file). If it's missing, tell the user to copy `.env.example` to
   `.env.local` next to it and mint a token with `bun run token:mint agent "claude-triage"`
   (from the idj repo), then paste it in.

Defaults: `IDJ_BASE_URL=https://idj.isozilla.com` (production — where real captures
live). Use `http://localhost:3000` only when explicitly working against a local dev
instance.

> Dev note: the Vite dev server binds IPv6 only. If `http://localhost:3000` is refused by
> curl, use `http://[::1]:3000`. Production over HTTPS has no such issue.

> Comments: send the body as `text/plain`. Building the JSON form by hand breaks on
> embedded quotes, and the endpoint accepts raw text anyway.

## 2. Fetch the inbox

```
GET  {base}/api/items?status=open        Authorization: Bearer {token}
```

Optionally also pull recent activity to see what changed since last time:

```
GET  {base}/api/events?since=0           # or a cursor the user remembers
```

Each item has: `id`, `kind` (task/idea/note/memory), `title`, `body`, `tags`, `summary`
(AI enrichment, may be null), `createdTs`, `updatedTs`, `status`, `firstCapture` (verbatim).

## 3. Reason across the whole set — this is the point

Don't just list them back. Actually think:

- **Cluster** related captures (by topic, tag, or obvious theme) and name each cluster.
- **Dedupe / merge** — call out near-duplicates or notes that belong together.
- **Find the real next action** for anything actionable; a vague `todo:` often hides a
  concrete first step — name it.
- **Surface stale items** (old `createdTs`, still open) and ask if they're dead.
- **Link** an idea/note to the project or task it clearly relates to.
- Keep it tight: lead with the 2–3 things worth acting on now, then the rest grouped.

## 4. Take actions (confirm first)

Propose actions, then apply the confirmed ones. Available write endpoints:

```
POST {base}/api/items/{id}/comment   {"text": "..."}   # add a note/decision to an item
POST {base}/api/items/{id}/done                          # mark complete
POST {base}/api/items/{id}/reopen                        # reopen
```

Rules:
- **Confirm before any bulk or destructive-feeling action** (closing several items,
  marking something done the user didn't clearly finish). Single obvious follow-ups can be
  applied and reported.
- Prefer a comment recording your reasoning/decision over silently changing state.
- There is **no delete** (by design — the log is append-only) and **no retag/kind-edit
  endpoint yet**: you can comment and change status, but not rewrite tags/kind via the API.
  If the user wants richer edits, note it as a gap to add (`item.edited` endpoint).

## 5. Wrap up

End with a short summary of what changed (items closed, comments added) and what you'd
tackle next session. If you pulled events, tell the user the latest `seq` so they can pass
it as `?since=` next time.
