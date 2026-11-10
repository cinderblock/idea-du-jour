/**
 * Wakes long-polling transcription workers (`GET /api/transcribe/queue`) the
 * moment there is something to do, instead of making them wait out their poll.
 *
 * Kept on globalThis: the server bundle can contain more than one copy of a
 * module (one per route chunk), and the capture route and the queue route must
 * share the same waiters.
 */
type Waiters = Set<() => void>
const KEY = Symbol.for('idj.transcribeQueue.waiters')
const g = globalThis as unknown as Record<symbol, Waiters | undefined>
const waiters: Waiters = (g[KEY] ??= new Set())

/** Something was queued: wake every waiting worker. */
export function notifyTranscriptionQueued(): void {
  for (const wake of [...waiters]) wake()
}

/** Resolve when work is queued or after `ms`, whichever is first. */
export function waitForTranscriptionWork(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      waiters.delete(done)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    waiters.add(done)
    signal?.addEventListener('abort', done)
  })
}
