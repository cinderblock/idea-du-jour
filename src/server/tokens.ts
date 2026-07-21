import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { tokens, type Token } from '../db/schema'

export type Scope = 'capture' | 'agent'

const PREFIX = 'idj'

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/**
 * Mint a new token. Returns the one-time secret (shown once) and the stored row.
 * Secret format: `idj_<scope>_<id>_<random>`; only `id` + SHA-256(secret) persist.
 */
export async function mintToken(scope: Scope, label: string) {
  const id = randomBytes(6).toString('hex') // 12-char lookup id
  const secretPart = randomBytes(24).toString('base64url')
  const secret = `${PREFIX}_${scope}_${id}_${secretPart}`
  const row = {
    id,
    hash: sha256(secret),
    scope,
    label,
    createdTs: Date.now(),
    lastUsedTs: null,
    revokedTs: null,
  }
  await db.insert(tokens).values(row)
  return { secret, token: row }
}

function parseBearer(request: Request): string | null {
  const h = request.headers.get('authorization') ?? ''
  const m = h.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}

/** capture-scope tokens may only capture; agent-scope may do everything. */
function scopeSatisfies(have: string, need: Scope): boolean {
  if (have === 'agent') return true
  return have === need
}

export class AuthError extends Error {
  constructor(
    public status: 401 | 403,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Authenticate a request for the required scope. Throws AuthError on failure.
 * Updates last_used_ts on success (best-effort).
 */
export async function authenticate(
  request: Request,
  need: Scope,
): Promise<Token> {
  const secret = parseBearer(request)
  if (!secret) throw new AuthError(401, 'missing bearer token')

  const parts = secret.split('_')
  if (parts.length < 4 || parts[0] !== PREFIX) {
    throw new AuthError(401, 'malformed token')
  }
  const id = parts[2]

  const [row] = await db.select().from(tokens).where(eq(tokens.id, id)).limit(1)
  if (!row || row.revokedTs) throw new AuthError(401, 'invalid token')
  if (row.hash !== sha256(secret)) throw new AuthError(401, 'invalid token')
  if (!scopeSatisfies(row.scope, need)) {
    throw new AuthError(403, `token scope '${row.scope}' cannot access '${need}'`)
  }

  // best-effort last-used stamp; don't block or fail the request on it
  Promise.resolve(
    db.update(tokens).set({ lastUsedTs: Date.now() }).where(eq(tokens.id, id)),
  ).catch(() => {})

  return row
}
