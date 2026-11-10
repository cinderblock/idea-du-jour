import { createFileRoute } from '@tanstack/react-router'
import { getItem } from '../../server/events'
import { recordTranscript } from '../../server/transcribe'
import { AuthError, authenticate } from '../../server/tokens'

/**
 * A remote worker's transcript for a voice capture: `{text, model, prompt?}`.
 * Appends `item.transcribed` and starts enrichment.
 */
export const Route = createFileRoute('/api/items/$id/transcript')({
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
        const body = (await request.json().catch(() => null)) as {
          text?: unknown
          model?: unknown
          prompt?: unknown
        } | null
        if (!body || typeof body.text !== 'string' || typeof body.model !== 'string') {
          return Response.json({ error: 'expected {text, model}' }, { status: 400 })
        }
        const data = await getItem(params.id)
        if (!data) return Response.json({ error: 'not found' }, { status: 404 })
        if (!data.item.audio) {
          return Response.json({ error: 'not a voice capture' }, { status: 400 })
        }
        await recordTranscript({
          itemId: params.id,
          text: body.text,
          model: body.model,
          prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
          actor: 'agent:whisper-worker',
        })
        return Response.json({ id: params.id, ok: true })
      },
    },
  },
})
