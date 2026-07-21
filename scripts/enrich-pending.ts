/**
 * Enrich any captured items that haven't been processed yet (e.g. captured
 * while ANTHROPIC_API_KEY was unset). Usage: bun run scripts/enrich-pending.ts
 */
import { client } from '../src/db/client'
import { enrichPending } from '../src/server/enrich'

const n = await enrichPending(100)
console.log(`enriched ${n} pending item(s)`)
client.close()
