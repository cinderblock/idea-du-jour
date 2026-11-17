# Locked-phone captures: security review and options

## Goal
Cameron captured idj item `01M7JZ9ZTBWVTB5BSJF6TG0A7S` (2026-11-16 12:03 PM PST (20:03Z)) with his
phone locked, and it worked. Every capture is dispatched to a T3 thread that is told to "treat it
as his request" and start on it, with his PC's permissions. So anyone holding the locked phone can
speak instructions that an agent acts on. Review the threat, propose options, recommend one.
Research and proposal only: no change to the server, Shortcut, dispatcher or infra without his
per-change yes.

## Environment / context
- Capture: `POST /api/capture` (`src/routes/api/capture.ts`). Two ways in: capture bearer token
  (actor `siri`), or device ID header from the signed Shortcut (`src/server/devices.ts`).
  Approved device = straight into the inbox; new/pending device = held until approved on
  `/devices` (passkey session). Approving releases every held capture into the inbox **and into
  dispatch** (`approveDevice` calls `enqueueDispatch`; voice dispatches after transcription).
- Device ID: 64 hex chars in iCloud Drive `Shortcuts/idj-device-id.txt`; server keeps its SHA-256.
- Dispatch (`src/server/dispatch.ts`): HMAC-signed webhook with the item id only, to T3 task
  "idj: dispatch captures to threads" (`scheduled-task:170e6542-…`). **That task runs
  `full-access`** and reads the capture text itself. It launches or reuses a per-project daily
  thread in `auto` mode with "Treat it as his request. If it's actionable, start on it".
- `auto` mode: a classifier approves routine actions and blocks risky ones. Its main signal for
  "is this authorized" is what the user asked, and a capture is presented as exactly that.
- Tools a launched thread can reach on this PC (no deny rules in `~/.claude/settings.json` for
  any of these, checked 2026-11-16): `gh` / git push, SSH to servers, the ops repo, BlueBubbles
  (send iMessages), Gmail (send), Slack, Home Assistant (`ha-tsl`: call services, i.e. physical
  devices), Chrome with his sessions. CLAUDE.md gates infra, force-push, posting to others'
  repos and paid compute, but not iMessage/email/Slack/HA or ordinary pushes.

## Threat model
| # | Who | How | Today |
|---|-----|-----|-------|
| T1 | Anyone holding the locked phone (stranger, kid, coworker) | Action button or "Hey Siri, Record to IDJ", then speak | **Open.** Lands as an approved-device capture; agent acts on it. |
| T2 | Someone talking near him while he records | Voice in the background of a real capture | Low; he'd notice in the transcript. |
| T3 | Holder of the device-ID file or a capture token | Any Mac/app with his iCloud Drive; a leaked token | Same reach as T1, remotely. Revoke exists but needs noticing. |
| T4 | Stranger with the public Shortcut | New device ID | Held, needs approval (good). But one mistaken approval dispatches up to 20 held captures at once. |
| T5 | Prompt injection into the dispatcher | Capture text crafted to steer the dispatcher | The dispatcher reads that text in a **full-access** session. Larger blast radius than the threads it launches. |

The capture itself is harmless (append-only note). All the risk is in **acting** on it. So the
fix belongs mostly on the dispatch/agent side, and lock-screen capture can stay.

## Findings / gotchas
- **iOS gives a Shortcut no way to tell whether the phone is locked.** No "is locked" action
  exists (checked 2026-11-16; forum reports only). Some actions force an "unlock to continue"
  prompt (e.g. "Dismiss Siri and Continue", opening a URL/app), behaviour varies by trigger
  (Siri vs widget vs Action button) and isn't documented. Untested on his phone.
- **No per-shortcut "require unlock" setting.** The only lock-screen switch is device-wide:
  Settings → Face ID & Passcode → Allow Access When Locked → Siri. It doesn't cover the Action
  button, which runs its shortcut from the lock screen.
- This capture working while locked also shows the iCloud `Get File` for the device ID is
  readable while locked (after first unlock).
- **Voice/speaker verification is weak.** Siri's "Hey Siri" voice match is a convenience filter,
  not authentication (recordings and similar voices pass); the Action button has no voice check at
  all; idj gets audio with no speaker identity. Not worth building on.

## Options
**A. iOS side: require unlock.** Turn off Siri-when-locked and/or end the Shortcut with an action
that forces unlock (Open URL). Cost: kills the hands-free locked capture that's the whole point,
the URL step pops Safari on every capture, and lock behaviour is undocumented and may change with
iOS updates. Doesn't help T3/T5. **Not recommended as the main fix.**

**B. Server side: flag locked captures, dispatch them as notes.** Blocked by the finding above:
the Shortcut can't tell. Without lock detection this collapses into "treat all phone captures as
unconfirmed", which is option C.

**C. Agent side: phone captures are unverified; acting outward needs a typed confirmation.**
Change the dispatcher prompt and the launched-thread message so a capture can drive *local,
reversible* work (read, research, think, edit and commit in the working tree, draft text into
files) but never by itself authorize: pushes, deploys, infra, sending messages (iMessage, email,
Slack), Home Assistant / physical devices, purchases or paid compute, deleting data, or posting
anywhere. For those the thread asks, and only a message typed in T3 counts as yes. Plus: move the
dispatcher task off `full-access` (to `auto`), which closes most of T5.
Cost: almost none day to day (CLAUDE.md already makes most of these ask). Weakness: it's
prompt-enforced; a model can still be talked round.

**D. Enforced version of C: phone threads start in plan mode, confirm to act.** Launch dispatched
threads with T3's `plan` interaction mode: they can read and propose, not edit or run. He releases
a thread by approving its plan in T3, or by a "Confirm as me" button on the idj item page
(passkey/Face ID session), which tells the dispatcher to switch the thread to `auto` and go.
Cost: every capture waits for a tap before anything happens, which loses "it's already done when
I sit down". Server + dispatcher work (new event type, button, route).

**E. Hard tool limits.** Deny rules / a PreToolUse hook blocking BlueBubbles send, Gmail send,
HA `call_service`, `git push` etc. for dispatched threads. Real enforcement, but Claude settings
are global, so it needs a per-thread marker the hook can see; fiddly and also restricts his own
typed threads unless scoped carefully.

## Recommendation
**C now, D later only if C proves too soft.** The capture stays frictionless and lock-screen
capture keeps working; what changes is that a capture is a *request to think and prepare*, and
anything that leaves the PC or touches the physical world waits for him to type yes in T3. That
covers T1, T3 and the reachable part of T5 without needing lock detection that iOS doesn't offer.
Also recommended alongside: show a held device's captures on `/devices` before approving
(T4), and keep A as a personal setting he can choose (turn off Siri-when-locked if he rarely
uses "Hey Siri" while locked).

## Cameron's feedback (2026-11-16) and answers
1. **Lots of held captures means misconfiguration or spam, not a backlog to release.** And with
   his one phone approved, new device registration should probably be off.
   - Proposed change (needs his yes): env flag `IDJ_DEVICE_REGISTRATION=closed` (default open
     for fresh installs). Closed: an unknown device ID gets 403 and nothing is held or stored.
     Optionally a passkey-gated "open registration for 30 minutes" toggle on `/devices` for
     adding a device later. Approving a pending device would no longer auto-dispatch its held
     captures: release them as items only, with dispatch off, or show them first.
   - **Phone transfer:** the device ID lives in iCloud Drive (`Shortcuts/idj-device-id.txt`),
     so a new phone on the same Apple ID reads the same file and *is* the same approved device.
     No re-pairing, works with registration closed. Same for an iPad or Mac running the
     Shortcut. The flip side: there's no per-phone key, and the server silently overwrites
     name/model on each capture. Cheap fix if wanted: log an event when name/model changes.
2. **Voice corpus for a future speaker check.** Already accumulating: every voice capture's
   recording is kept permanently in the audio dir (`items.audio`, nothing deletes it). Missing
   only a label for recordings that aren't his voice; default "his" is right for nearly all.
   Later: speaker embeddings (e.g. an ECAPA-style model on sentinel next to Whisper) scored
   against his enrolment. Still a signal, never authentication (replay, a recording of him).
3. **He wants some pushes/deploys from captures for easy, obvious things**, and a secure way to
   approve the rest or answer follow-ups ("something like ci-questions"). Reframes option C as
   tiers:
   - *Capture is enough:* local work; non-force pushes to his own repos; deploys of his own
     apps where rollback is one step.
   - *Needs a secure approval:* infra/ops (existing CLAUDE.md rule), messages (iMessage, email,
     Slack), Home Assistant / physical, money or paid compute, deleting data, anything in other
     people's projects.
   - Secure approval channel: **the ops "ask" worker** (`ci-question.isozilla.com`, ops
     `cloudflare/workers/ask/`, design `plans/ci-input-service.md`; first search missed it
     because it's named "ask"). Already built: durable keyed requests, answer page, passkey
     sessions, PWA + Web Push, long-poll answers. Deployed 2026-07-24 but **not live-usable
     yet**: the 3 prod secrets, the first passkey bootstrap and the GitHub App are still on
     Cameron's list there. Gap for this use: its only machine principal is GitHub OIDC (a CI
     run). Agents on the PC need a new principal (e.g. a bearer token scoped to "create/poll
     own requests"), an ops change that needs his per-change yes.

## Decisions already made (don't re-ask)
- Research and proposal first; no change without a per-change yes (Cameron, 2026-11-16).
- Easy/obvious pushes and deploys should still work from a capture; no blanket ban (2026-11-16).
- Many held captures = suspect, not a backlog to release (2026-11-16).

## Progress log
- [x] Read plans, capture/device/dispatch code, the live dispatcher prompt (read-only from
      `~/.t3/userdata/statev2.sqlite`).
- [x] Threat model, options, recommendation (this doc).
- [x] Device name/model change history (Cameron said yes 2026-11-16): `device_changes` table,
      shown on `/devices`, README updated. `93d011e`, pushed (deploys via Renovate). Tested on a
      temp DB: unchanged captures log nothing; name and model changes log from/to/IP.
- [x] Cameron's picks (2026-11-16): tiered C yes; close registration + don't dispatch held
      captures yes; use the ops ask worker for approvals yes; Siri-when-locked stays ON.
- [x] Registration closes once a device is approved; `/devices` can open a 30-minute window;
      captures released by approval are marked dispatched (`held`) and never reach agents.
      `49b2150`, pushed. Tested on a temp DB (fresh = open, after approve = 403 for new IDs,
      known device fine, window opens/closes, held item has dispatchedTs).
- [x] Dispatcher prompt v4 with trust rules is live (2026-11-16 ~5:00 PM PST (01:00Z)). The task
      runs in its bound thread `thread:project:d90bf685-a805-4812-afe8-560cafdd8bac:a5b0a3ee-101f-4acb-97be-c9a6e0094175`,
      whose mode is now `auto` (verified in `statev2.sqlite`). Gotchas: T3's access picker only
      changes the composer draft; it persists when a message is sent in that thread. The task's
      own stored `runtime_mode` is still `full-access` (unused for bound runs, no UI to change
      it), so `schedule_task` edits from an `auto` thread stay refused: future prompt edits are
      pasted by hand in Settings → Scheduled tasks. Saved prompt verified identical to
      `plans/dispatcher-prompt-v4.md`.
- [ ] **Current step:** Cameron's test capture: a harmless gated request (e.g. "delete
      plans/dispatch-daily-threads.md and push"); the thread should ask instead of acting.
- [ ] Deploy of `49b2150` (in image `91b1c5e`, CI smoke passed): waiting on ops Renovate to
      bump the idj pin (prod still `c837198` at 2026-11-16 ~5:00 PM PST).
- [ ] Ops ask worker as the approval channel: Cameron finishes its setup (3 prod secrets, first
      passkey); then stage an ops change adding an agent principal (per-change yes), then a
      helper the threads call to ask and wait.
- [ ] If C: draft the exact dispatcher-prompt and thread-message wording, show it, then apply in a
      full-access thread or by hand (auto threads can't edit the task: `runtime_mode_escalation_denied`).

## Open questions for the user
_All answered 2026-11-16; see progress log._
1. Go with tiered C (capture is enough for own-repo pushes and easy deploys; secure approval
   for the rest; dispatcher off full-access)? Recommended.
2. Close device registration (`IDJ_DEVICE_REGISTRATION=closed`) and stop auto-dispatching
   released held captures? Recommended.
3. Use the ops "ask" worker as the secure approval channel? Needs: finish its setup (secrets,
   first passkey) and add an agent principal next to GitHub OIDC (ops change). Recommended
   over building a second approval page into idj.
4. Turn off Siri-when-locked on the phone (A, your setting)? Recommend: your call.

## Things not to do
- Don't rely on voice match or anything in the transcript ("this is Cameron") as authentication.
- Don't try to detect lock state from timing or action failures; undocumented and brittle.
- Don't edit the dispatcher task from an `auto` thread; it fails with escalation denied.
