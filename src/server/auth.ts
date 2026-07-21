import { createHmac, timingSafeEqual } from 'node:crypto'
import { getCookie } from '@tanstack/react-start/server'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '../db/client'
import { credentials, users, type Token } from '../db/schema'
import { env } from './env'

/**
 * Single-user passkey auth for the first-party web UI. The token API (`/api/*`,
 * except `/api/auth/*`) is unrelated — that's bearer tokens for Siri/agents.
 *
 * Sessions and WebAuthn challenges are carried in HMAC-signed cookies (stateless,
 * no server-side session store). Cookie WRITES happen only in the auth route
 * handlers (set on the returned Response); READS use the ambient `getCookie`.
 */

const SESSION_COOKIE = 'idj_session'
const CHALLENGE_COOKIE = 'idj_webauthn'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const CHALLENGE_TTL_MS = 5 * 60 * 1000 // 5 minutes

const isHttps = env.rpOrigin.startsWith('https')

// --- signed tokens: base64url(json).base64url(hmac) -------------------------

function sign(payload: string): string {
  return createHmac('sha256', env.sessionSecret).update(payload).digest('base64url')
}

function signToken(obj: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${payload}.${sign(payload)}`
}

function verifyToken<T = Record<string, unknown>>(token: string | undefined): T | null {
  if (!token) return null
  const dot = token.indexOf('.')
  if (dot <= 0) return null
  const payload = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = sign(payload)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      exp?: number
    }
    if (typeof obj.exp !== 'number' || obj.exp < Date.now()) return null
    return obj as T
  } catch {
    return null
  }
}

// --- session ---------------------------------------------------------------

export function makeSessionCookie(userId: string): string {
  const token = signToken({ uid: userId, exp: Date.now() + SESSION_TTL_MS })
  const maxAge = Math.floor(SESSION_TTL_MS / 1000)
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps ? '; Secure' : ''}`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps ? '; Secure' : ''}`
}

/** Current user id from the ambient request (server functions / loaders). */
export function currentUserId(): string | null {
  const t = verifyToken<{ uid: string }>(getCookie(SESSION_COOKIE))
  return t?.uid ?? null
}

/** Read the session from a raw Request (route handlers). */
export function userIdFromRequest(request: Request): string | null {
  const cookie = request.headers.get('cookie') ?? ''
  const m = cookie.match(new RegExp(`(?:^|; )${SESSION_COOKIE}=([^;]+)`))
  return verifyToken<{ uid: string }>(m?.[1])?.uid ?? null
}

export class UnauthorizedError extends Error {}

/** Throw if the ambient request has no valid session. Returns the user id. */
export function requireUserId(): string {
  const uid = currentUserId()
  if (!uid) throw new UnauthorizedError('not authenticated')
  return uid
}

// --- webauthn challenge (short-lived, signed) ------------------------------

type ChallengePayload = {
  challenge: string
  type: 'reg' | 'auth'
  uid?: string
  displayName?: string
  exp: number
}

export function makeChallengeCookie(
  data: Omit<ChallengePayload, 'exp'>,
): string {
  const token = signToken({ ...data, exp: Date.now() + CHALLENGE_TTL_MS })
  return `${CHALLENGE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${CHALLENGE_TTL_MS / 1000}${isHttps ? '; Secure' : ''}`
}

export function clearChallengeCookie(): string {
  return `${CHALLENGE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps ? '; Secure' : ''}`
}

export function challengeFromRequest(request: Request): ChallengePayload | null {
  const cookie = request.headers.get('cookie') ?? ''
  const m = cookie.match(new RegExp(`(?:^|; )${CHALLENGE_COOKIE}=([^;]+)`))
  return verifyToken<ChallengePayload>(m?.[1])
}

// --- users & credentials ---------------------------------------------------

export async function getSoleUser() {
  const [u] = await db.select().from(users).limit(1)
  return u ?? null
}

export async function createUser(displayName: string, id = ulid()) {
  const row = { id, displayName, createdTs: Date.now() }
  await db.insert(users).values(row)
  return row
}

export async function ensureUser(id: string, displayName: string) {
  const [existing] = await db.select().from(users).where(eq(users.id, id)).limit(1)
  if (existing) return existing
  return createUser(displayName, id)
}

export async function getUserCredentials(userId: string) {
  return db.select().from(credentials).where(eq(credentials.userId, userId))
}

export async function getCredential(id: string) {
  const [c] = await db.select().from(credentials).where(eq(credentials.id, id)).limit(1)
  return c ?? null
}

export async function saveCredential(row: {
  id: string
  userId: string
  publicKey: Uint8Array
  counter: number
  transports?: string[]
}) {
  await db.insert(credentials).values({
    id: row.id,
    userId: row.userId,
    publicKey: Buffer.from(row.publicKey).toString('base64url'),
    counter: row.counter,
    transports: row.transports ?? null,
    createdTs: Date.now(),
  })
}

export async function bumpCredentialCounter(id: string, counter: number) {
  await db.update(credentials).set({ counter }).where(eq(credentials.id, id))
}

/** Decode a stored credential's public key back to bytes for verification.
 * `Uint8Array.from` yields an ArrayBuffer-backed array (not ArrayBufferLike),
 * which is what SimpleWebAuthn's `WebAuthnCredential.publicKey` type wants. */
export function decodePublicKey(base64url: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(base64url, 'base64url'))
}

/** UTF-8 encode a string to an ArrayBuffer-backed Uint8Array (for `userID`). */
export function encodeUserId(id: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(id, 'utf8'))
}

// re-export so route handlers can narrow token-auth errors alongside auth ones
export type { Token }
