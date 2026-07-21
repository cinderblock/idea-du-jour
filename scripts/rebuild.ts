/**
 * Rebuild the items projection from the append-only event log.
 * Usage: bun run scripts/rebuild.ts
 */
import { client } from '../src/db/client'
import { rebuildProjection } from '../src/server/events'

const n = await rebuildProjection()
console.log(`rebuilt items projection: ${n} item(s)`)
client.close()
