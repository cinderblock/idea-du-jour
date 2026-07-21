import { createFileRoute } from '@tanstack/react-router'
import { getItem } from '../../server/events'
import { AuthError, authenticate } from '../../server/tokens'

export const Route = createFileRoute('/api/items/$id')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          await authenticate(request, 'agent')
        } catch (e) {
          if (e instanceof AuthError) {
            return Response.json({ error: e.message }, { status: e.status })
          }
          throw e
        }

        const result = await getItem(params.id)
        if (!result) return Response.json({ error: 'not found' }, { status: 404 })
        return Response.json(result)
      },
    },
  },
})
