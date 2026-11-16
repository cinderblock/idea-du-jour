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

## Decisions already made (don't re-ask)
- Research and proposal first; no change without a per-change yes (Cameron, 2026-11-16).

## Progress log
- [x] Read plans, capture/device/dispatch code, the live dispatcher prompt (read-only from
      `~/.t3/userdata/statev2.sqlite`).
- [x] Threat model, options, recommendation (this doc).
- [ ] Cameron picks an option.
- [ ] If C: draft the exact dispatcher-prompt and thread-message wording, show it, then apply in a
      full-access thread or by hand (auto threads can't edit the task: `runtime_mode_escalation_denied`).

## Open questions for the user
1. Go with C (prompt rules + dispatcher off full-access)? Recommended.
2. Want D's "Confirm as me" button too, or only if C turns out too soft? Recommend: later.
3. Turn off Siri-when-locked on the phone (A, your setting)? Recommend: your call; C makes it optional.

## Things not to do
- Don't rely on voice match or anything in the transcript ("this is Cameron") as authentication.
- Don't try to detect lock state from timing or action failures; undocumented and brittle.
- Don't edit the dispatcher task from an `auto` thread; it fails with escalation denied.
