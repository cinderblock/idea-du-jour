import { createFileRoute } from '@tanstack/react-router'
import { env } from '../../server/env'
import { getItem } from '../../server/events'
import { retranscribe } from '../../server/transcribe'
import { AuthError, authenticate } from '../../server/tokens'

/**
 * Transcribe a voice capture again with the current glossary, e.g. after
 * adding a name it had mangled. Appends a new `item.transcribed`; the old
 * transcript stays in the history. Synchronous: answers with the new text.
 */
export const Route = createFileRoute('/api/items/$id/retranscribe')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          await authenticate(request, 'agent')
        } catch (e) {
          if (e instanceof AuthError) {
            return Response.json({ error: e.message }, { status: e.status })
          }
          throw e
        }
        if (!env.transcribeUrl) {
          return Response.json({ error: 'transcription is not configured' }, { status: 503 })
        }
        const data = await getItem(params.id)
        if (!data) return Response.json({ error: 'not found' }, { status: 404 })
        if (!data.item.audio) {
          return Response.json({ error: 'not a voice capture' }, { status: 400 })
        }
        try {
          const text = await retranscribe(params.id)
          return Response.json({ id: params.id, text })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          return Response.json({ error: msg }, { status: 502 })
        }
      },
    },
  },
})
