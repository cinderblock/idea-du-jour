import { createFileRoute } from '@tanstack/react-router'
import { generateAuthenticationOptions } from '@simplewebauthn/server'
import * as auth from '../../../server/auth'
import { env } from '../../../server/env'

export const Route = createFileRoute('/api/auth/login/options')({
  server: {
    handlers: {
      // No allowCredentials → rely on discoverable (resident) passkeys; the
      // credential is identified by id on verify.
      POST: async () => {
        const options = await generateAuthenticationOptions({
          rpID: env.rpId,
          userVerification: 'preferred',
        })
        return Response.json(options, {
          headers: {
            'set-cookie': auth.makeChallengeCookie({
              challenge: options.challenge,
              type: 'auth',
            }),
          },
        })
      },
    },
  },
})
