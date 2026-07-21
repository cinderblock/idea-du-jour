import { createFileRoute } from '@tanstack/react-router'
import { listItems } from '../../server/events'
import { AuthError, authenticate } from '../../server/tokens'

export const Route = createFileRoute('/api/items')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          await authenticate(request, 'agent')
        } catch (e) {
          if (e instanceof AuthError) {
            return Response.json({ error: e.message }, { status: e.status })
          }
          throw e
        }

        const url = new URL(request.url)
        const status = url.searchParams.get('status') ?? undefined
        const kind = url.searchParams.get('kind') ?? undefined
        const limitParam = url.searchParams.get('limit')
        const limit = limitParam ? Number(limitParam) : undefined

        const rows = await listItems({ status, kind, limit })
        return Response.json({ items: rows })
      },
    },
  },
})
