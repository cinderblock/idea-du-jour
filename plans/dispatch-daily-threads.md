# Dispatch v2: daily threads, fewer approval prompts

## Goal
Captures auto-dispatched from idj to T3 Code threads kept stopping on permission prompts, and
each capture got its own thread even when several sent minutes apart were one train of thought
(Cameron, 2026-11-13). Fix both without losing the three captures from 2026-11-12, whose
threads he stopped.

## Environment / context
- Dispatcher: T3 webhook task "idj: dispatch captures to threads"
  (`scheduled-task:170e6542-f298-4848-a8b7-7d22462439db`), bound to thread
  `thread:project:d90bf685-…:a5b0a3ee-…` (worktree `~/.t3/worktrees/idea-du-jour/t3-2f66bc49`),
  fresh session per run. Runs are serialized through that bound thread (2026-11-12 launches
  were ~45-70 s apart, one at a time), so a later capture sees the earlier one's link comment.
- T3 runtime modes map to Claude permission modes (`~/git/t3code`
  `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`): `auto-accept-edits` ->
  `acceptEdits`, `auto` -> `auto` (classifier approves routine actions, blocks risky ones
  without prompting), `full-access` -> `bypassPermissions`.
- Helper: `.claude/skills/idj-triage/idj.ts` (bun, no deps). Globally reachable as
  `C:/Users/camer/.claude/skills/idj-triage/idj.ts` (a junction to the **main checkout**).

## Decisions already made (don't re-ask)
1. **Launched threads run in `auto`**, replacing "auto-accept edits" (decision 4 in
   `plans/idea-du-jour.md`). Why: acceptEdits prompted on nearly every shell command (curl
   with `$VARS` or heredocs "can't be checked before it runs"), and unattended threads sat
   blocked. `auto` still refuses risky actions, so it keeps the intent of not handing a
   capture token full access.
2. **One thread per project per capture-day.** A capture-day runs 4:00 AM to 4:00 AM
   Pacific, so a late-night burst stays with its evening. Scratch counts as one project.
   Follow-ups go to the existing thread with `t3_thread_send` (`mode: auto`).
3. Routing reads the day's other captures first; captures about idj itself (shortcut,
   recording, transcription, device approval) go to idea-du-jour.
4. A later `T3 thread:` comment on an item supersedes an earlier one (`day` lists newest first).

## Plan / steps
- [x] `idj.ts` helper: get / list / comment / done / reopen / day. Reads config from env,
      `.env.local` next to it, or the main checkout's (worktrees lack the gitignored file).
- [x] SKILL.md points at the helper.
- [x] Dispatcher prompt v2 (daily threads, `auto`, helper, routing hint), saved to the task
      2026-11-13 2:05 AM PST (10:05Z).
- [x] Replacement thread for 2026-11-12's three captures, in `auto`:
      t3-thread://v2/ab3781d7-a1dd-4bbb-b3e9-6331e19b7569/mcp:launch:de2c86e2ae1ba78b5019572cae69da5e5259cdbd8918aebc200431fced3a5b78
      All three items re-linked to it. It coordinates with the main idj thread
      (c0a1eb91), which already owns the device-ID and text-mode fixes.
- [x] Pushed as `013697c`. The main checkout only pulled it on 2026-11-15 ~3:40 PM PST
      (23:40Z, rebase to `2154486`); until then `idj.ts` was missing on the global skill path,
      and the "fall back to your own worktree's copy" line didn't help (the dispatcher runs in
      that same checkout).
- [x] First real captures (2026-11-15, 20 test captures): new daily thread, then reused all day,
      in order, including across 1–2 hour gaps.
- [x] `day --for <id>` adds a top-level `threads` summary with `minutesSinceLast` (`96c6c37`).
      Dispatcher prompt v3 copies that number, drops the useless fallback, and says to stop and
      report if `idj.ts` is missing. Saved to the task 2026-11-15 ~5:40 PM PST (01:40Z).

## Findings / gotchas
- Git Bash's curl (8.8.0, mingw64, Schannel) fails every HTTPS request with
  `curl: (43) A libcurl function was given a bad argument`, GET included (2026-11-13
  ~2 AM PST). It worked for a GET minutes earlier in the same session. Windows'
  `C:\Windows\System32\curl.exe` (8.22.0) works. The helper uses `fetch`, so idj calls don't
  depend on either.
- The 2026-11-12 "time recording shows negative time" capture was routed to LibreHours
  (time-tracker). It was about the shortcut's recording timer. Context from neighbouring
  captures, plus the idj routing hint, is the fix.
- The dispatcher worked out "It arrived N minutes after the previous one here" by clock
  arithmetic on the `local` strings and got it wrong (27 for a real 88 on item
  01M7GJNGVD9CDV2RV3HM3RK8N9). The helper now computes it.
- Editing the dispatcher task from a thread in `auto` mode fails with
  `runtime_mode_escalation_denied` (the task runs full-access). It needs a full-access thread
  or a hand edit in T3.
- Typecheck in a fresh worktree fails on `src/routes/setup.tsx` and `src/routes/shortcut.ts`
  (route tree not generated); pre-existing, unrelated to this change.

## Things not to do
- Don't send follow-ups to the stopped 2026-11-12 threads: they keep `auto-accept-edits`
  (modes stay with a thread), so they'd prompt again.
- Don't copy `idj.ts` into the main checkout by hand: an untracked copy would block that
  checkout's next pull/rebase.
