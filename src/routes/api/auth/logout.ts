import { createFileRoute } from '@tanstack/react-router'
import * as auth from '../../../server/auth'

export const Route = createFileRoute('/api/auth/logout')({
  server: {
    handlers: {
      POST: async () => {
        return Response.json(
          { ok: true },
          { headers: { 'set-cookie': auth.clearSessionCookie() } },
        )
      },
    },
  },
})
