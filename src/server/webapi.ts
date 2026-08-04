import { createServerFn } from '@tanstack/react-start'
import { currentUserId, requireUserId } from './auth'
import { listTokens, mintToken, revokeToken, type Scope } from './tokens'
import { enqueueEnrichment } from './enrich'
import {
  captureItem,
  commentItem,
  getItem,
  listItems,
  setStatus,
  type Status,
} from './events'

/**
 * Server functions for the first-party web UI. These call the domain layer
 * directly on the server — no bearer token needed (the public token API is for
 * Siri + external agents). Every one requires a valid WebAuthn session
 * (`requireUserId` throws if the ambient request has none), so the RPC endpoints
 * are guarded even independently of the route-level redirect.
 */

export const fetchItems = createServerFn({ method: 'GET' })
  .inputValidator((data: { status?: string; kind?: string } | undefined) => data ?? {})
  .handler(async ({ data }) => {
    requireUserId()
    const items = await listItems({ status: data.status, kind: data.kind })
    return { items }
  })

export const fetchItem = createServerFn({ method: 'GET' })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    requireUserId()
    return getItem(data.id)
  })

export const webCapture = createServerFn({ method: 'POST' })
  .inputValidator((data: { text: string }) => data)
  .handler(async ({ data }) => {
    requireUserId()
    const text = (data.text ?? '').trim()
    if (!text) throw new Error('empty capture')
    const id = await captureItem({ text, actor: 'web' })
    enqueueEnrichment(id)
    return { id }
  })

export const addComment = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; text: string }) => data)
  .handler(async ({ data }) => {
    requireUserId()
    const id = await commentItem({
      itemId: data.id,
      text: data.text,
      actor: 'web',
    })
    return { id }
  })

export const setItemStatus = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; status: Status }) => data)
  .handler(async ({ data }) => {
    requireUserId()
    const id = await setStatus({
      itemId: data.id,
      status: data.status,
      actor: 'web',
    })
    return { id }
  })

/** Ambient session check for route guards — returns the user id or null. */
export const getAuth = createServerFn({ method: 'GET' }).handler(async () => {
  return { userId: currentUserId() }
})

/**
 * Mint an API token from the settings UI. The secret is returned ONCE and never
 * stored in plaintext (only a hash), so the caller must copy it immediately.
 */
export const createToken = createServerFn({ method: 'POST' })
  .inputValidator((data: { scope: Scope; label: string }) => data)
  .handler(async ({ data }) => {
    requireUserId()
    const label = data.label.trim() || 'unnamed'
    if (data.scope !== 'capture' && data.scope !== 'agent') {
      throw new Error('invalid scope')
    }
    const { secret, token } = await mintToken(data.scope, label)
    return { secret, id: token.id, scope: token.scope, label: token.label }
  })

/** Existing tokens (metadata only — secrets are never retrievable). */
export const fetchTokens = createServerFn({ method: 'GET' }).handler(async () => {
  requireUserId()
  return { tokens: await listTokens() }
})

/** Revoke a token by id. */
export const revokeTokenFn = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    requireUserId()
    await revokeToken(data.id)
    return { ok: true }
  })
