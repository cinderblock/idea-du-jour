---
name: idj-triage
description: Read and work through the idea-du-jour capture inbox with Claude — fetch open items, reason across the whole set (cluster, dedupe, surface next actions, spot stale items), and write back comments / done / reopen via the agent API. Use when the user says "triage my inbox", "process my idj items", "what's in my inbox", "go through my ideas", or similar.
---

# idea-du-jour triage

Work through the user's personal capture inbox (idea-du-jour) as a thinking partner —
not a dumb per-item classifier. Read the whole open set, reason across it, and take
actions the user confirms. This runs on the user's Claude subscription (you, here),
so lean into whole-inbox reasoning that the server-side per-item enricher can't do.

## 1. Load config

Read the base URL and agent token, in this order:

1. Env vars `IDJ_BASE_URL` and `IDJ_AGENT_TOKEN`.
2. Otherwise `.claude/skills/idj-triage/.env.local` (KEY=value lines) — this is the usual
   place; it's gitignored. If it's missing, tell the user to copy `.env.example` to
   `.env.local` and mint a token with `bun run token:mint agent "claude-triage"` (from the
   idj repo), then paste it in.

Defaults: `IDJ_BASE_URL=http://localhost:3000` (local dev) — production is
`https://idj.isozilla.com` once deployed.

> Dev note: the Vite dev server binds IPv6 only. If `http://localhost:3000` is refused by
> curl, use `http://[::1]:3000`. Production over HTTPS has no such issue.

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
