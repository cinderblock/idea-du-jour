import { createFileRoute } from '@tanstack/react-router'
import { NotFoundError, setStatus } from '../../server/events'
import { AuthError, authenticate } from '../../server/tokens'

export const Route = createFileRoute('/api/items/$id/done')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        let tokenId: string
        try {
          const token = await authenticate(request, 'agent')
          tokenId = token.id
        } catch (e) {
          if (e instanceof AuthError) {
            return Response.json({ error: e.message }, { status: e.status })
          }
          throw e
        }

        try {
          const id = await setStatus({
            itemId: params.id,
            status: 'done',
            actor: 'agent',
            tokenId,
          })
          return Response.json({ id }, { status: 201 })
        } catch (e) {
          if (e instanceof NotFoundError) {
            return Response.json({ error: 'not found' }, { status: 404 })
          }
          throw e
        }
      },
    },
  },
})
