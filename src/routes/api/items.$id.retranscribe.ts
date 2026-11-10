import { createFileRoute } from '@tanstack/react-router'
import { getItem, requestTranscription } from '../../server/events'
import { enqueueTranscription } from '../../server/transcribe'
import { notifyTranscriptionQueued } from '../../server/transcribeQueue'
import { AuthError, authenticate } from '../../server/tokens'

/**
 * Queue a voice capture for transcription again with the current glossary,
 * e.g. after adding a name it mangled. Asynchronous: answers 202 at once; the
 * new `item.transcribed` lands when a transcriber gets to it (usually
 * seconds). The old transcript stays in the history. Body (optional):
 * `{reason}`.
 */
export const Route = createFileRoute('/api/items/$id/retranscribe')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        let tokenId: string
        try {
          tokenId = (await authenticate(request, 'agent')).id
        } catch (e) {
          if (e instanceof AuthError) {
            return Response.json({ error: e.message }, { status: e.status })
          }
          throw e
        }
        const data = await getItem(params.id)
        if (!data) return Response.json({ error: 'not found' }, { status: 404 })
        if (!data.item.audio) {
          return Response.json({ error: 'not a voice capture' }, { status: 400 })
        }
        const body = (await request.json().catch(() => null)) as { reason?: unknown } | null
        await requestTranscription({
          itemId: params.id,
          actor: 'agent',
          tokenId,
          reason: typeof body?.reason === 'string' ? body.reason : undefined,
        })
        enqueueTranscription(params.id)
        notifyTranscriptionQueued()
        return Response.json({ id: params.id, queued: true }, { status: 202 })
      },
    },
  },
})
