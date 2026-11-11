import { createHmac } from 'node:crypto'
import { env } from './env'
import { getItem, listUndispatched, markDispatched } from './events'

/**
 * Agent dispatch: hand every new capture to T3 Code, which starts a thread for
 * it in the right project and links the thread back as a comment.
 *
 * Push to a T3 webhook task (`T3_DISPATCH_URL`). The delivery carries only ids
 * and a link; the dispatcher reads the item itself with its own agent token,
 * so nothing private rides along in a URL or a log. Each body is signed with
 * `T3_DISPATCH_SECRET` (`X-Idj-Signature: sha256=<hex HMAC-SHA256>`), which
 * the task verifies.
 *
 * Like enrichment and transcription it never blocks or fails a capture: a
 * failed delivery is retried by the sweep, for up to a day. Older captures
 * are never dispatched, so turning this on (or a long outage) can't flood T3
 * with threads for the backlog.
 */

/** Only captures this recent are (re)tried. */
const DISPATCH_WINDOW_MS = 24 * 60 * 60 * 1000
const SWEEP_MS = 2 * 60 * 1000

const inFlight = new Set<string>()

export function dispatchEnabled(): boolean {
  return Boolean(env.t3DispatchUrl && env.t3DispatchSecret)
}

/** Fire-and-forget dispatch of one item. Never throws into the caller. */
export function enqueueDispatch(itemId: string): void {
  if (!dispatchEnabled()) return
  void dispatch(itemId).catch((err) => {
    console.error(`[dispatch] ${itemId}: ${err instanceof Error ? err.message : err}`)
  })
}

export function signBody(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

async function dispatch(itemId: string): Promise<boolean> {
  if (!dispatchEnabled() || inFlight.has(itemId)) return false
  inFlight.add(itemId)
  try {
    const data = await getItem(itemId)
    if (!data || data.item.dispatchedTs) return false
    const { item } = data
    if (item.status !== 'open') return false // done before it went out: nothing to do
    if (item.audio && !item.transcribedTs) return false // wait for the text
    if (item.createdTs < Date.now() - DISPATCH_WINDOW_MS) return false

    const body = JSON.stringify({
      event: 'idj.capture',
      itemId: item.id,
      kind: item.kind,
      voice: Boolean(item.audio),
      createdTs: item.createdTs,
      url: `${env.publicOrigin.replace(/\/+$/, '')}/items/${item.id}`,
    })
    const res = await fetch(env.t3DispatchUrl!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-idj-signature': signBody(body, env.t3DispatchSecret!),
      },
      body,
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`T3 answered ${res.status}: ${text.slice(0, 200)}`)
    let deliveryId: string | null = null
    try {
      deliveryId = (JSON.parse(text) as { deliveryId?: string }).deliveryId ?? null
    } catch {}
    await markDispatched({ itemId, target: 't3', deliveryId })
    return true
  } finally {
    inFlight.delete(itemId)
  }
}

/** Retry captures from the last day that T3 never accepted. */
export async function dispatchPending(): Promise<number> {
  if (!dispatchEnabled()) return 0
  let sent = 0
  for (const item of await listUndispatched(Date.now() - DISPATCH_WINDOW_MS)) {
    try {
      if (await dispatch(item.id)) sent++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[dispatch] sweep: ${item.id} still waiting (${msg})`)
      break // T3 is probably unreachable; the next sweep tries again
    }
  }
  return sent
}

let sweepTimer: ReturnType<typeof setInterval> | null = null

/** Start the periodic retry sweep (idempotent). */
export function startDispatchSweep(): void {
  if (sweepTimer || !dispatchEnabled()) return
  const tick = () => {
    void dispatchPending().catch((err) => console.error('[dispatch] sweep:', err))
  }
  sweepTimer = setInterval(tick, SWEEP_MS)
  sweepTimer.unref?.()
  tick()
}
