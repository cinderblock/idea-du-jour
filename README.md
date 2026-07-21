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
- **Stack:** TanStack Start (React, SSR) on Bun — one deployable serving the PWA and the API.
- **Store:** SQLite, **append-only event log** as source of truth + a rebuildable `items`
  projection for fast reads.
- **Web auth:** Passkey / WebAuthn (Face ID).
- **API auth:** bearer tokens — *capture* (write-only, for Siri) and *agent* (read + comment).
- **Hosting:** Docker on `firefly` behind Caddy (HTTPS). *(later; infra changes are gated)*

## Capture (iPhone)
A Siri Shortcut POSTs dictated text to `/api/capture` with a *capture* bearer token, bound to
the Action button. Recipe lives here once the endpoint exists.

## Development
_TBD — scaffold in progress._
