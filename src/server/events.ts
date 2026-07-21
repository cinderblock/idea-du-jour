import { ulid } from 'ulid'
import { and, desc, eq, gt } from 'drizzle-orm'
import { db } from '../db/client'
import { events, items } from '../db/schema'
import { parseCapture } from './capture'

export type Actor = string // 'siri' | 'web' | 'agent:claude' | ...

/**
 * Append an `item.created` event and project it into `items`, atomically.
 * The raw text is stored verbatim; derived fields come from parseCapture.
 * Returns the new item id.
 */
export async function captureItem(opts: {
  text: string
  actor: Actor
  tokenId?: string | null
  ts?: number
  kind?: string
  tags?: string[]
}): Promise<string> {
  const raw = opts.text
  const parsed = parseCapture(raw)
  const kind = opts.kind ?? parsed.kind
  const tags = [...new Set([...(opts.tags ?? []), ...parsed.tags])]
  const ts = opts.ts ?? Date.now()
  const itemId = ulid()
  const eventId = ulid()

  await db.transaction(async (tx) => {
    await tx.insert(events).values({
      id: eventId,
      ts,
      type: 'item.created',
      itemId,
      actor: opts.actor,
      tokenId: opts.tokenId ?? null,
      payload: { raw, kind, tags, title: parsed.title, body: parsed.body },
    })

    await tx.insert(items).values({
      id: itemId,
      createdTs: ts,
      updatedTs: ts,
      kind,
      title: parsed.title,
      body: parsed.body,
      status: 'open',
      tags,
      firstCapture: raw,
    })
  })

  return itemId
}

/** List items for the triage UI / agent queries. */
export async function listItems(opts: {
  status?: string
  kind?: string
  limit?: number
} = {}) {
  const limit = Math.min(opts.limit ?? 100, 500)
  const conds = []
  if (opts.status) conds.push(eq(items.status, opts.status))
  if (opts.kind) conds.push(eq(items.kind, opts.kind))

  return db
    .select()
    .from(items)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(items.createdTs))
    .limit(limit)
}

/** Raw append-only feed for agents to catch up from a cursor. */
export async function listEventsSince(sinceSeq: number, limit = 200) {
  return db
    .select()
    .from(events)
    .where(gt(events.seq, sinceSeq))
    .orderBy(events.seq)
    .limit(Math.min(limit, 1000))
}
