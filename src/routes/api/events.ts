import { createFileRoute } from '@tanstack/react-router'
import { listEventsSince } from '../../server/events'
import { AuthError, authenticate } from '../../server/tokens'

export const Route = createFileRoute('/api/events')({
  server: {
    handlers: {
      // Cursor feed: pass ?since=<seq> to get events after that seq, ascending.
      // The `nextCursor` in the response is the seq to pass on the next poll.
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
        const since = Number(url.searchParams.get('since') ?? '0') || 0
        const limitParam = url.searchParams.get('limit')
        const limit = limitParam ? Number(limitParam) : undefined

        const rows = await listEventsSince(since, limit)
        const nextCursor = rows.length ? rows[rows.length - 1].seq : since
        return Response.json({ events: rows, nextCursor })
      },
    },
  },
})
