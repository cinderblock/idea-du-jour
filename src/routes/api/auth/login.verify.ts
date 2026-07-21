import { createFileRoute } from '@tanstack/react-router'
import { verifyAuthenticationResponse } from '@simplewebauthn/server'
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/server'
import * as auth from '../../../server/auth'
import { env } from '../../../server/env'

export const Route = createFileRoute('/api/auth/login/verify')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const chal = auth.challengeFromRequest(request)
        if (!chal || chal.type !== 'auth') {
          return Response.json({ error: 'no challenge' }, { status: 400 })
        }
        const response = (await request.json()) as AuthenticationResponseJSON

        const cred = await auth.getCredential(response.id)
        if (!cred) {
          return Response.json({ error: 'unknown credential' }, { status: 401 })
        }

        const verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge: chal.challenge,
          expectedOrigin: env.rpOrigin,
          expectedRPID: env.rpId,
          credential: {
            id: cred.id,
            publicKey: auth.decodePublicKey(cred.publicKey),
            counter: cred.counter,
            transports: (cred.transports ?? undefined) as
              | AuthenticatorTransportFuture[]
              | undefined,
          },
          requireUserVerification: false,
        })
        if (!verification.verified) {
          return Response.json({ error: 'verification failed' }, { status: 401 })
        }

        await auth.bumpCredentialCounter(
          cred.id,
          verification.authenticationInfo.newCounter,
        )

        const headers = new Headers()
        headers.append('set-cookie', auth.makeSessionCookie(cred.userId))
        headers.append('set-cookie', auth.clearChallengeCookie())
        return Response.json({ verified: true }, { headers })
      },
    },
  },
})
