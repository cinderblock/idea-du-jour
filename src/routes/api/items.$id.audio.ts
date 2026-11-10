import { createFileRoute } from '@tanstack/react-router'
import { readAudio } from '../../server/audio'
import { userIdFromRequest } from '../../server/auth'
import { getItem } from '../../server/events'
import { AuthError, authenticate } from '../../server/tokens'

/**
 * A voice capture's original recording. Readable by the signed-in web UI (its
 * session cookie, so an <audio> tag just works) or by an agent token.
 *
 * Honours single byte ranges: Safari's audio player refuses to play a source
 * that doesn't answer `Range` with 206.
 */
export const Route = createFileRoute('/api/items/$id/audio')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!userIdFromRequest(request)) {
          try {
            await authenticate(request, 'agent')
          } catch (e) {
            if (e instanceof AuthError) {
              return Response.json({ error: e.message }, { status: e.status })
            }
            throw e
          }
        }

        const data = await getItem(params.id)
        const ref = data?.item.audio
        if (!ref) return Response.json({ error: 'no recording' }, { status: 404 })

        const bytes = await readAudio(ref)
        const headers: Record<string, string> = {
          'content-type': ref.mime,
          'accept-ranges': 'bytes',
          // The file never changes once written.
          'cache-control': 'private, max-age=31536000, immutable',
          etag: `"${ref.sha256}"`,
        }

        const range = request.headers.get('range')?.match(/^bytes=(\d*)-(\d*)$/)
        if (range && (range[1] || range[2])) {
          const size = bytes.byteLength
          let start = range[1] ? Number(range[1]) : size - Number(range[2])
          let end = range[1] && range[2] ? Number(range[2]) : size - 1
          start = Math.max(0, start)
          end = Math.min(end, size - 1)
          if (start > end) {
            return new Response(null, {
              status: 416,
              headers: { 'content-range': `bytes */${size}` },
            })
          }
          return new Response(bytes.slice(start, end + 1), {
            status: 206,
            headers: {
              ...headers,
              'content-range': `bytes ${start}-${end}/${size}`,
              'content-length': String(end - start + 1),
            },
          })
        }

        return new Response(bytes, {
          headers: { ...headers, 'content-length': String(bytes.byteLength) },
        })
      },
    },
  },
})
