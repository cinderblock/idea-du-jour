import { ulid } from 'ulid'
import { and, asc, desc, eq, gt, isNull } from 'drizzle-orm'
import { db } from '../db/client'
import { events, items, type Event, type Item } from '../db/schema'
import { parseCapture } from './capture'

export type Actor = string // 'siri' | 'web' | 'agent:claude' | ...

export type Status = 'open' | 'done' | 'archived'

/** Thrown when an operation targets an item id that doesn't exist. */
export class NotFoundError extends Error {}

const STATUS_EVENT: Record<Status, string> = {
  open: 'item.reopened',
  done: 'item.done',
  archived: 'item.archived',
}

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
    .orderBy(asc(events.seq))
    .limit(Math.min(limit, 1000))
}

/** Fetch one item plus its full event history (created, comments, status changes). */
export async function getItem(
  itemId: string,
): Promise<{ item: Item; events: Event[] } | null> {
  const [item] = await db
    .select()
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1)
  if (!item) return null
  const history = await db
    .select()
    .from(events)
    .where(eq(events.itemId, itemId))
    .orderBy(asc(events.seq))
  return { item, events: history }
}

async function requireItem(itemId: string): Promise<Item> {
  const [item] = await db
    .select()
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1)
  if (!item) throw new NotFoundError(`item ${itemId} not found`)
  return item
}

/** Append an `item.commented` event and bump the item's updated time. */
export async function commentItem(opts: {
  itemId: string
  text: string
  actor: Actor
  tokenId?: string | null
  ts?: number
}): Promise<string> {
  await requireItem(opts.itemId)
  const text = opts.text.trim()
  if (!text) throw new Error('empty comment')
  const ts = opts.ts ?? Date.now()
  const eventId = ulid()

  await db.transaction(async (tx) => {
    await tx.insert(events).values({
      id: eventId,
      ts,
      type: 'item.commented',
      itemId: opts.itemId,
      actor: opts.actor,
      tokenId: opts.tokenId ?? null,
      payload: { text },
    })
    await tx
      .update(items)
      .set({ updatedTs: ts })
      .where(eq(items.id, opts.itemId))
  })

  return eventId
}

/** Append a status-change event (done/reopen/archive) and update the projection. */
export async function setStatus(opts: {
  itemId: string
  status: Status
  actor: Actor
  tokenId?: string | null
  ts?: number
}): Promise<string> {
  await requireItem(opts.itemId)
  const ts = opts.ts ?? Date.now()
  const eventId = ulid()

  await db.transaction(async (tx) => {
    await tx.insert(events).values({
      id: eventId,
      ts,
      type: STATUS_EVENT[opts.status],
      itemId: opts.itemId,
      actor: opts.actor,
      tokenId: opts.tokenId ?? null,
      payload: { status: opts.status },
    })
    await tx
      .update(items)
      .set({ status: opts.status, updatedTs: ts })
      .where(eq(items.id, opts.itemId))
  })

  return eventId
}

export type Enrichment = {
  kind: string
  title: string
  tags: string[]
  summary: string
}

/**
 * Merge an agent's enrichment into an item. Human/keyword intent wins:
 * `kind` is only taken when the item is still the default `note`, `title`
 * only fills when empty, and AI `tags` are unioned with existing ones.
 * `summary` is AI-owned. Appended as an immutable `item.enriched` event.
 */
export async function enrichItem(opts: {
  itemId: string
  enrichment: Enrichment
  model: string
  actor?: Actor
  ts?: number
}): Promise<string> {
  const item = await requireItem(opts.itemId)
  const ts = opts.ts ?? Date.now()
  const eventId = ulid()
  const e = opts.enrichment

  const kind = item.kind === 'note' ? e.kind : item.kind
  const title = item.title ?? e.title
  const tags = [...new Set([...item.tags, ...e.tags])]

  await db.transaction(async (tx) => {
    await tx.insert(events).values({
      id: eventId,
      ts,
      type: 'item.enriched',
      itemId: opts.itemId,
      actor: opts.actor ?? 'agent:claude',
      tokenId: null,
      payload: { ...e, model: opts.model },
    })
    await tx
      .update(items)
      .set({ kind, title, tags, summary: e.summary, enrichedTs: ts, updatedTs: ts })
      .where(eq(items.id, opts.itemId))
  })

  return eventId
}

/** Items awaiting their first enrichment (oldest first), for the sweep worker. */
export async function listUnenriched(limit = 20) {
  return db
    .select()
    .from(items)
    .where(isNull(items.enrichedTs))
    .orderBy(asc(items.createdTs))
    .limit(limit)
}

/**
 * Rebuild the entire `items` projection by replaying the append-only log.
 * Proves the log is the source of truth — the projection is disposable.
 */
export async function rebuildProjection(): Promise<number> {
  const log = await db.select().from(events).orderBy(asc(events.seq))
  const byItem = new Map<string, Item>()

  for (const ev of log) {
    const p = ev.payload as Record<string, unknown>
    switch (ev.type) {
      case 'item.created':
        byItem.set(ev.itemId, {
          id: ev.itemId,
          createdTs: ev.ts,
          updatedTs: ev.ts,
          kind: (p.kind as string) ?? 'note',
          title: (p.title as string | null) ?? null,
          body: (p.body as string) ?? '',
          status: 'open',
          tags: (p.tags as string[]) ?? [],
          firstCapture: (p.raw as string) ?? '',
          summary: null,
          enrichedTs: null,
        })
        break
      case 'item.edited': {
        const cur = byItem.get(ev.itemId)
        if (cur) {
          if (typeof p.body === 'string') cur.body = p.body
          if ('title' in p) cur.title = (p.title as string | null) ?? null
          if (Array.isArray(p.tags)) cur.tags = p.tags as string[]
          if (typeof p.kind === 'string') cur.kind = p.kind
          cur.updatedTs = ev.ts
        }
        break
      }
      case 'item.commented': {
        const cur = byItem.get(ev.itemId)
        if (cur) cur.updatedTs = ev.ts
        break
      }
      case 'item.enriched': {
        const cur = byItem.get(ev.itemId)
        if (cur) {
          if (cur.kind === 'note' && typeof p.kind === 'string') cur.kind = p.kind
          if (!cur.title && typeof p.title === 'string') cur.title = p.title
          if (Array.isArray(p.tags)) {
            cur.tags = [...new Set([...cur.tags, ...(p.tags as string[])])]
          }
          if (typeof p.summary === 'string') cur.summary = p.summary
          cur.enrichedTs = ev.ts
          cur.updatedTs = ev.ts
        }
        break
      }
      case 'item.done':
      case 'item.reopened':
      case 'item.archived': {
        const cur = byItem.get(ev.itemId)
        if (cur) {
          cur.status = (p.status as string) ?? 'open'
          cur.updatedTs = ev.ts
        }
        break
      }
      case 'item.deleted':
        byItem.delete(ev.itemId)
        break
    }
  }

  const rows = [...byItem.values()]
  await db.transaction(async (tx) => {
    await tx.delete(items)
    if (rows.length) await tx.insert(items).values(rows)
  })
  return rows.length
}
