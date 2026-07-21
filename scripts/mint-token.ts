/**
 * Mint an API token and print the one-time secret.
 * Usage: bun run scripts/mint-token.ts <capture|agent> "<label>"
 */
import { client } from '../src/db/client'
import { mintToken, type Scope } from '../src/server/tokens'

const scope = process.argv[2] as Scope
const label = process.argv[3] ?? 'unnamed'

if (scope !== 'capture' && scope !== 'agent') {
  console.error('usage: bun run scripts/mint-token.ts <capture|agent> "<label>"')
  process.exit(1)
}

const { secret, token } = await mintToken(scope, label)
console.log(`\nMinted ${scope} token "${label}" (id ${token.id})`)
console.log('Secret (shown once — copy it now):\n')
console.log(`  ${secret}\n`)
client.close()
