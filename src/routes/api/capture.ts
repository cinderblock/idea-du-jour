import { createFileRoute } from '@tanstack/react-router'
import { resolveAudioMime } from '../../server/audio'
import {
  DeviceError,
  clientIp,
  deviceActor,
  holdCapture,
  parseDeviceHeaders,
  resolveDevice,
} from '../../server/devices'
import { enqueueDispatch } from '../../server/dispatch'
import { enqueueEnrichment } from '../../server/enrich'
import { env } from '../../server/env'
import { captureAudioItem, captureItem } from '../../server/events'
import { enqueueTranscription } from '../../server/transcribe'
import { notifyTranscriptionQueued } from '../../server/transcribeQueue'
import { AuthError, authenticate } from '../../server/tokens'

type CaptureBody = {
  text?: string
  kind?: string
  tags?: string[]
  ts?: number
  source?: string
}

type Parsed =
  | { kind: 'audio'; bytes: Uint8Array; mime: string }
  | { kind: 'text'; text: string; body: CaptureBody }

/** Content types that mean "this body is a recording", not text. */
function isAudioType(contentType: string): boolean {
  const t = contentType.split(';')[0].trim().toLowerCase()
  return t.startsWith('audio/') || t === 'application/octet-stream' || t === 'video/mp4'
}

const json = (status: number, data: Record<string, unknown>) => Response.json(data, { status })

/**
 * Read the body: a recording (raw, as Shortcuts' "Request Body: File" sends it,
 * or a multipart part), or text (raw text/plain, or JSON {text, ...}).
 */
async function parseBody(request: Request): Promise<Parsed | Response> {
  const contentType = request.headers.get('content-type') ?? ''

  if (isAudioType(contentType) || contentType.includes('multipart/form-data')) {
    const declared = Number(request.headers.get('content-length') ?? 0)
    if (declared > env.audioMaxBytes) return json(413, { error: 'recording too large' })

    let bytes: Uint8Array
    let partType: string | null = contentType
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData().catch(() => null)
      const file = form ? [...form.values()].find((v): v is File => typeof v !== 'string') : undefined
      if (!file) return json(400, { error: 'no file in the form' })
      bytes = new Uint8Array(await file.arrayBuffer())
      partType = file.type || null
    } else {
      bytes = new Uint8Array(await request.arrayBuffer())
    }
    if (bytes.byteLength === 0) return json(400, { error: 'empty recording' })
    if (bytes.byteLength > env.audioMaxBytes) return json(413, { error: 'recording too large' })
    const mime = resolveAudioMime(partType, bytes)
    if (!mime) {
      return json(415, { error: `not a recognised audio file (${partType || 'no type'})` })
    }
    return { kind: 'audio', bytes, mime }
  }

  // Forgiving text handling: JSON {text} or a raw text/plain body.
  let text = ''
  let body: CaptureBody = {}
  if (contentType.includes('application/json')) {
    const parsed = (await request.json().catch(() => null)) as unknown
    if (parsed && typeof parsed === 'object') body = parsed as CaptureBody
    text = typeof body.text === 'string' ? body.text : ''
  } else {
    text = await request.text()
  }
  text = text.trim()
  if (!text) return json(400, { error: 'empty capture' })
  return { kind: 'text', text, body }
}

/** Store a capture in the inbox and start the background work it needs. */
async function accept(parsed: Parsed, actor: string, tokenId: string | null) {
  if (parsed.kind === 'audio') {
    const id = await captureAudioItem({ audio: parsed.bytes, mime: parsed.mime, actor, tokenId })
    enqueueTranscription(id)
    notifyTranscriptionQueued()
    return json(201, { id, audio: true, message: '🎙 Saved to idj' })
  }
  const { body } = parsed
  const id = await captureItem({
    text: parsed.text,
    actor: body.source ?? actor,
    tokenId,
    kind: body.kind,
    tags: Array.isArray(body.tags) ? body.tags : undefined,
    ts: typeof body.ts === 'number' ? body.ts : undefined,
  })
  enqueueEnrichment(id)
  enqueueDispatch(id)
  return json(201, { id, message: '✏️ Saved to idj' })
}

/**
 * POST /api/capture. Two ways in:
 *
 * - **Token:** `Authorization: Bearer <capture token>`, exactly as before.
 * - **Device:** `X-Idj-Device-Id` (+ `-Name`, `-Model`), sent by the installed
 *   shortcut. An approved device captures straight into the inbox. A new or
 *   pending one has its capture held until the device is approved on
 *   /devices; nothing is lost and nothing reaches the inbox unapproved.
 *
 * If both are sent, the token wins. Every answer has a `message` the shortcut
 * shows as its notification.
 */
export const Route = createFileRoute('/api/capture')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Authenticate before reading the body, so a refused upload never
        // touches disk.
        if (request.headers.get('authorization')) {
          let tokenId: string
          try {
            tokenId = (await authenticate(request, 'capture')).id
          } catch (e) {
            if (e instanceof AuthError) return json(e.status, { error: e.message })
            throw e
          }
          const parsed = await parseBody(request)
          if (parsed instanceof Response) return parsed
          return accept(parsed, 'siri', tokenId)
        }

        try {
          const info = parseDeviceHeaders(request)
          if (!info) return json(401, { error: 'missing bearer token or device id' })
          const device = await resolveDevice(info, clientIp(request))
          const parsed = await parseBody(request)
          if (parsed instanceof Response) return parsed

          if (device.status === 'approved') return accept(parsed, deviceActor(device), null)

          const id = await holdCapture(
            device,
            parsed.kind === 'audio' ? { audio: parsed.bytes, mime: parsed.mime } : { text: parsed.text },
          )
          const base = env.publicOrigin.replace(/\/+$/, '')
          return json(202, {
            id,
            pending: true,
            message: `Saved, but this phone isn't approved yet. Approve “${device.name}” at ${base}/devices and it will appear in your inbox.`,
          })
        } catch (e) {
          if (e instanceof DeviceError) return json(e.status, { error: e.message, message: e.message })
          throw e
        }
      },
    },
  },
})
