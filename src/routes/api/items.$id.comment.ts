import { createFileRoute } from '@tanstack/react-router'
import { NotFoundError, commentItem } from '../../server/events'
import { AuthError, authenticate } from '../../server/tokens'

export const Route = createFileRoute('/api/items/$id/comment')({
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

        const contentType = request.headers.get('content-type') ?? ''
        let text = ''
        let actor = 'agent'
        if (contentType.includes('application/json')) {
          const body = (await request.json().catch(() => null)) as
            | { text?: string; actor?: string }
            | null
          text = typeof body?.text === 'string' ? body.text : ''
          if (typeof body?.actor === 'string') actor = body.actor
        } else {
          text = await request.text()
        }

        text = (text ?? '').trim()
        if (!text) return Response.json({ error: 'empty comment' }, { status: 400 })

        try {
          const id = await commentItem({ itemId: params.id, text, actor, tokenId })
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
