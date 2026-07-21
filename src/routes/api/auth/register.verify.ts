import { createFileRoute } from '@tanstack/react-router'
import { verifyRegistrationResponse } from '@simplewebauthn/server'
import type { RegistrationResponseJSON } from '@simplewebauthn/server'
import * as auth from '../../../server/auth'
import { env } from '../../../server/env'

export const Route = createFileRoute('/api/auth/register/verify')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const chal = auth.challengeFromRequest(request)
        if (!chal || chal.type !== 'reg' || !chal.uid) {
          return Response.json({ error: 'no challenge' }, { status: 400 })
        }
        const response = (await request.json()) as RegistrationResponseJSON

        const verification = await verifyRegistrationResponse({
          response,
          expectedChallenge: chal.challenge,
          expectedOrigin: env.rpOrigin,
          expectedRPID: env.rpId,
          requireUserVerification: false,
        })
        if (!verification.verified || !verification.registrationInfo) {
          return Response.json({ error: 'verification failed' }, { status: 400 })
        }

        await auth.ensureUser(chal.uid, chal.displayName ?? 'me')
        const cred = verification.registrationInfo.credential
        await auth.saveCredential({
          id: cred.id,
          userId: chal.uid,
          publicKey: cred.publicKey,
          counter: cred.counter,
          transports: cred.transports,
        })

        const headers = new Headers()
        headers.append('set-cookie', auth.makeSessionCookie(chal.uid))
        headers.append('set-cookie', auth.clearChallengeCookie())
        return Response.json({ verified: true }, { headers })
      },
    },
  },
})
