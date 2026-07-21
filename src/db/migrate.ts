import { migrate } from 'drizzle-orm/libsql/migrator'
import { client, db } from './client'

/** Apply pending migrations from ./drizzle. Run via `bun run db:migrate`. */
await migrate(db, { migrationsFolder: './drizzle' })
console.log('migrations applied')
client.close()
