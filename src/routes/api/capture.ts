import { createFileRoute } from '@tanstack/react-router'
import { enqueueEnrichment } from '../../server/enrich'
import { captureItem } from '../../server/events'
import { AuthError, authenticateSecret } from '../../server/tokens'

type CaptureBody = {
  token?: string
  text?: string
  kind?: string
  tags?: string[]
  ts?: number
  source?: string
}

export const Route = createFileRoute('/api/capture')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Body first, because the token may live in it (see below).
        // Forgiving body handling: accept JSON or a raw text/plain body so the
        // Siri Shortcut can be as simple as "POST the dictated text".
        const contentType = request.headers.get('content-type') ?? ''
        let text = ''
        let body: CaptureBody = {}
        if (contentType.includes('application/json')) {
          const parsed = (await request.json().catch(() => null)) as unknown
          if (parsed && typeof parsed === 'object') body = parsed as CaptureBody
          text = typeof body.text === 'string' ? body.text : ''
        } else {
          text = await request.text()
        }

        // Accept the token from the Authorization header OR the JSON body.
        // Shortcuts' headers UI is easy to get silently wrong; the body is the
        // part you're already filling in. A body token is no more exposed than
        // a header one (it isn't written to access logs the way a query string
        // would be).
        let tokenId: string
        try {
          const headerSecret = (request.headers.get('authorization') ?? '')
            .replace(/^Bearer\s+/i, '')
            .trim()
          const token = await authenticateSecret(
            headerSecret || body.token,
            'capture',
          )
          tokenId = token.id
        } catch (e) {
          if (e instanceof AuthError) {
            return Response.json({ error: e.message }, { status: e.status })
          }
          throw e
        }

        text = (text ?? '').trim()
        if (!text) return Response.json({ error: 'empty capture' }, { status: 400 })

        const id = await captureItem({
          text,
          actor: body.source ?? 'siri',
          tokenId,
          kind: body.kind,
          tags: Array.isArray(body.tags) ? body.tags : undefined,
          ts: typeof body.ts === 'number' ? body.ts : undefined,
        })

        enqueueEnrichment(id)
        return Response.json({ id }, { status: 201 })
      },
    },
  },
})
