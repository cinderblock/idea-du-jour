import { createFileRoute } from '@tanstack/react-router'
import { resolveAudioMime } from '../../server/audio'
import { enqueueEnrichment } from '../../server/enrich'
import { env } from '../../server/env'
import { captureAudioItem, captureItem } from '../../server/events'
import { enqueueTranscription } from '../../server/transcribe'
import { AuthError, authenticate } from '../../server/tokens'

type CaptureBody = {
  text?: string
  kind?: string
  tags?: string[]
  ts?: number
  source?: string
}

/** Content types that mean "this body is a recording", not text. */
function isAudioType(contentType: string): boolean {
  const t = contentType.split(';')[0].trim().toLowerCase()
  return t.startsWith('audio/') || t === 'application/octet-stream' || t === 'video/mp4'
}

export const Route = createFileRoute('/api/capture')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Auth is the Authorization header, strictly `Bearer <token>` — one way
        // to do it. /setup hands you the exact string to paste. Checked before
        // the body is read, so an unauthenticated upload never touches disk.
        let tokenId: string
        try {
          const token = await authenticate(request, 'capture')
          tokenId = token.id
        } catch (e) {
          if (e instanceof AuthError) {
            return Response.json({ error: e.message }, { status: e.status })
          }
          throw e
        }

        const contentType = request.headers.get('content-type') ?? ''

        // Voice capture: a recording, either as the raw body (Shortcuts'
        // "Request Body: File") or as a multipart form part.
        if (isAudioType(contentType) || contentType.includes('multipart/form-data')) {
          const declared = Number(request.headers.get('content-length') ?? 0)
          if (declared > env.audioMaxBytes) {
            return Response.json({ error: 'recording too large' }, { status: 413 })
          }

          let bytes: Uint8Array
          let partType: string | null = contentType
          if (contentType.includes('multipart/form-data')) {
            const form = await request.formData().catch(() => null)
            const file = form
              ? [...form.values()].find((v): v is File => typeof v !== 'string')
              : undefined
            if (!file) {
              return Response.json({ error: 'no file in the form' }, { status: 400 })
            }
            bytes = new Uint8Array(await file.arrayBuffer())
            partType = file.type || null
          } else {
            bytes = new Uint8Array(await request.arrayBuffer())
          }

          if (bytes.byteLength === 0) {
            return Response.json({ error: 'empty recording' }, { status: 400 })
          }
          if (bytes.byteLength > env.audioMaxBytes) {
            return Response.json({ error: 'recording too large' }, { status: 413 })
          }
          const mime = resolveAudioMime(partType, bytes)
          if (!mime) {
            return Response.json(
              { error: `not a recognised audio file (${partType || 'no type'})` },
              { status: 415 },
            )
          }

          const id = await captureAudioItem({ audio: bytes, mime, actor: 'siri', tokenId })
          enqueueTranscription(id)
          return Response.json({ id, audio: true }, { status: 201 })
        }

        // Text capture. Forgiving body handling: accept JSON or a raw
        // text/plain body so the Siri Shortcut can be as simple as "POST the
        // dictated text".
        let text = ''
        let body: CaptureBody = {}
        if (contentType.includes('application/json')) {
          const parsed = (await request.json().catch(() => null)) as unknown
          if (parsed && typeof parsed === 'object') body = parsed as CaptureBody
          text = typeof body.text === 'string' ? body.text : ''
        } else {
          text = await request.text()
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
