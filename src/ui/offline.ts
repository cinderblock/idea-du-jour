/**
 * Client-only offline support (localStorage-backed). Lets the installed PWA keep
 * working with no network: captures queue locally and flush when back online, and
 * the last inbox is cached for offline reads.
 *
 * iOS note: Safari has no Background Sync, so the queue flushes when the app is
 * next open + online (on mount and on the `online` event), not in the background.
 * Nothing is lost either way.
 */
import type { Item } from '../db/schema'
import { parseCapture } from '../server/capture'

const PENDING_KEY = 'idj:pending'
const INBOX_KEY = 'idj:inbox'
const AUTHED_KEY = 'idj:authed'

const hasLS = () => typeof localStorage !== 'undefined'

function read<T>(key: string, fallback: T): T {
  if (!hasLS()) return fallback
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, val: unknown): void {
  if (!hasLS()) return
  try {
    localStorage.setItem(key, JSON.stringify(val))
  } catch {
    // quota / private mode — best effort
  }
}

export type PendingCapture = { localId: string; text: string; ts: number }

export function getPending(): PendingCapture[] {
  return read<PendingCapture[]>(PENDING_KEY, [])
}

export function enqueueCapture(text: string): void {
  const item: PendingCapture = {
    localId: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    ts: Date.now(),
  }
  write(PENDING_KEY, [...getPending(), item])
}

function removePending(localId: string): void {
  write(
    PENDING_KEY,
    getPending().filter((p) => p.localId !== localId),
  )
}

/** Attempt to POST each queued capture in order; stop at the first failure. */
export async function flushPending(
  send: (text: string) => Promise<void>,
): Promise<number> {
  let synced = 0
  for (const p of getPending()) {
    try {
      await send(p.text)
      removePending(p.localId)
      synced++
    } catch {
      break // still offline / server error — keep the rest queued
    }
  }
  return synced
}

/** Queued captures shaped like Items (parsed as the server would) for display. */
export function pendingItems(): Array<Item & { pending: true }> {
  return getPending()
    .map((p) => {
      const parsed = parseCapture(p.text)
      return {
        id: p.localId,
        createdTs: p.ts,
        updatedTs: p.ts,
        kind: parsed.kind,
        title: parsed.title,
        body: parsed.body,
        status: 'open',
        tags: parsed.tags,
        firstCapture: p.text,
        summary: null,
        enrichedTs: null,
        pending: true as const,
      }
    })
    .reverse() // newest first
}

export function cacheInbox(items: Item[]): void {
  write(INBOX_KEY, items)
}

export function cachedInbox(): Item[] {
  return read<Item[]>(INBOX_KEY, [])
}

/**
 * A durable "this browser has authenticated" marker. Used so route guards can
 * keep letting you into the app while offline (when the session check can't
 * reach the server) instead of bouncing to /login.
 */
export function setAuthed(v: boolean): void {
  if (!hasLS()) return
  if (v) localStorage.setItem(AUTHED_KEY, '1')
  else localStorage.removeItem(AUTHED_KEY)
}

export function wasAuthed(): boolean {
  return hasLS() && localStorage.getItem(AUTHED_KEY) === '1'
}
