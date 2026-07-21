import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * events — the append-only source of truth. NEVER UPDATE or DELETE a row here.
 * Every capture, edit, comment, completion, or deletion is a new immutable row.
 * `seq` is the monotonic cursor agents page through; `id` is a sortable ULID.
 */
export const events = sqliteTable('events', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  ts: integer('ts').notNull(),
  type: text('type').notNull(),
  itemId: text('item_id').notNull(),
  actor: text('actor').notNull(),
  tokenId: text('token_id'),
  payload: text('payload', { mode: 'json' })
    .notNull()
    .$type<Record<string, unknown>>(),
})

/**
 * items — a projection of `events`, rebuildable at any time by replaying the log.
 * Fast reads for the triage UI and agent queries. Not a source of truth.
 */
export const items = sqliteTable('items', {
  id: text('id').primaryKey(),
  createdTs: integer('created_ts').notNull(),
  updatedTs: integer('updated_ts').notNull(),
  kind: text('kind').notNull().default('note'),
  title: text('title'),
  body: text('body').notNull(),
  status: text('status').notNull().default('open'),
  tags: text('tags', { mode: 'json' })
    .notNull()
    .$type<string[]>()
    .default(sql`'[]'`),
  firstCapture: text('first_capture').notNull(),
})

/**
 * tokens — bearer API tokens. Two scopes:
 *   capture = write-only (Siri shortcuts hold these)
 *   agent   = read + comment (Claude skill holds these)
 * Only a SHA-256 hash of the secret is stored; `id` is the lookup prefix.
 */
export const tokens = sqliteTable('tokens', {
  id: text('id').primaryKey(),
  hash: text('hash').notNull(),
  scope: text('scope').notNull(),
  label: text('label').notNull(),
  createdTs: integer('created_ts').notNull(),
  lastUsedTs: integer('last_used_ts'),
  revokedTs: integer('revoked_ts'),
})

/** users — single-user for now, but modeled as a table for WebAuthn (later). */
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  createdTs: integer('created_ts').notNull(),
})

/** credentials — WebAuthn passkeys bound to a user (wired up in the auth phase). */
export const credentials = sqliteTable('credentials', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  publicKey: text('public_key').notNull(),
  counter: integer('counter').notNull().default(0),
  transports: text('transports', { mode: 'json' }).$type<string[]>(),
  createdTs: integer('created_ts').notNull(),
})

export type Event = typeof events.$inferSelect
export type Item = typeof items.$inferSelect
export type Token = typeof tokens.$inferSelect
