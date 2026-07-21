import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { env } from '../server/env'
import * as schema from './schema'

// For a local file: URL, make sure the parent directory exists before opening.
if (env.databaseUrl.startsWith('file:')) {
  const path = env.databaseUrl.slice('file:'.length)
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    // directory already exists or path has no dir component — fine.
  }
}

export const client = createClient({ url: env.databaseUrl })

// WAL improves concurrency for the single-writer + multiple-reader access pattern
// (Siri writes, web + agents read). Best-effort; ignored by non-file backends.
try {
  await client.execute('PRAGMA journal_mode=WAL')
} catch {
  // non-fatal
}

export const db = drizzle(client, { schema })
