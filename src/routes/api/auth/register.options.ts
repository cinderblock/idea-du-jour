import { createFileRoute } from '@tanstack/react-router'
import { generateRegistrationOptions } from '@simplewebauthn/server'
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server'
import { ulid } from 'ulid'
import * as auth from '../../../server/auth'
import { env } from '../../../server/env'

export const Route = createFileRoute('/api/auth/register/options')({
  server: {
    handlers: {
      // Bootstrap the first passkey (no user yet), or add another passkey while
      // authenticated. Once a user exists, unauthenticated registration is closed.
      POST: async ({ request }) => {
        const sole = await auth.getSoleUser()
        const sessionUid = auth.userIdFromRequest(request)

        let userId: string
        let displayName: string
        if (!sole) {
          userId = ulid()
          const body = (await request.json().catch(() => ({}))) as {
            displayName?: string
          }
          displayName = body.displayName?.trim() || 'me'
        } else if (sessionUid && sessionUid === sole.id) {
          userId = sole.id
          displayName = sole.displayName
        } else {
          return Response.json({ error: 'registration closed' }, { status: 403 })
        }

        const existing = sole ? await auth.getUserCredentials(sole.id) : []
        const options = await generateRegistrationOptions({
          rpName: env.rpName,
          rpID: env.rpId,
          userName: displayName,
          userID: auth.encodeUserId(userId),
          attestationType: 'none',
          excludeCredentials: existing.map((c) => ({
            id: c.id,
            transports: (c.transports ?? undefined) as
              | AuthenticatorTransportFuture[]
              | undefined,
          })),
          authenticatorSelection: {
            residentKey: 'preferred',
            userVerification: 'preferred',
          },
        })

        return Response.json(options, {
          headers: {
            'set-cookie': auth.makeChallengeCookie({
              challenge: options.challenge,
              type: 'reg',
              uid: userId,
              displayName,
            }),
          },
        })
      },
    },
  },
})
