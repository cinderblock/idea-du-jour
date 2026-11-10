import { createFileRoute } from '@tanstack/react-router'
import { listUntranscribed } from '../../../server/events'
import { buildPrompt } from '../../../server/glossary'
import { waitForTranscriptionWork } from '../../../server/transcribeQueue'
import { AuthError, authenticate } from '../../../server/tokens'

/**
 * Work queue for a remote transcription worker (`scripts/transcribe-worker.ts`).
 *
 * Long-poll: with `?wait=<seconds>` (max 8, under the server's idle timeout)
 * an empty queue holds the request until a recording arrives or time runs out.
 * Each job carries the prompt to use, so the glossary logic stays here.
 *
 * Nothing is leased: a job stays queued until its transcript is posted, so a
 * worker that dies mid-job loses nothing. Built for one worker.
 */
export const Route = createFileRoute('/api/transcribe/queue')({
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
        const wait = Math.min(Math.max(Number(url.searchParams.get('wait') ?? 0) || 0, 0), 8)
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 5) || 5, 1), 20)

        let pending = await listUntranscribed(limit)
        if (!pending.length && wait > 0) {
          await waitForTranscriptionWork(wait * 1000, request.signal)
          pending = await listUntranscribed(limit)
        }
        const prompt = pending.length ? await buildPrompt() : ''
        const jobs = pending.flatMap((i) =>
          i.audio
            ? [
                {
                  id: i.id,
                  mime: i.audio.mime,
                  bytes: i.audio.bytes,
                  filename: i.audio.file,
                  audio: `/api/items/${i.id}/audio`,
                  transcript: `/api/items/${i.id}/transcript`,
                  prompt,
                },
              ]
            : [],
        )
        return Response.json({ jobs }, { headers: { 'cache-control': 'no-store' } })
      },
    },
  },
})
