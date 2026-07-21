import { createFileRoute } from '@tanstack/react-router'
import * as auth from '../../../server/auth'

export const Route = createFileRoute('/api/auth/me')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const userId = auth.userIdFromRequest(request)
        const sole = await auth.getSoleUser()
        return Response.json({ userId, hasUser: !!sole })
      },
    },
  },
})
