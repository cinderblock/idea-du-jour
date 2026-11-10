/**
 * One call to an OpenAI-compatible Whisper server
 * (`POST /v1/audio/transcriptions`, multipart). No database access, so it is
 * shared by the in-server transcriber and the standalone worker
 * (`scripts/transcribe-worker.ts`) that runs next to the GPU.
 */

/** The text that marks a recording with no speech in it. */
export const NO_SPEECH = '(no speech detected)'

/**
 * Accept either a base URL (`http://whisper:8000`) or the full endpoint; the
 * OpenAI-compatible path is appended when it's missing.
 */
export function whisperEndpoint(url: string): string {
  const u = url.replace(/\/+$/, '')
  return /\/audio\/transcriptions$|\/inference$/.test(u) ? u : `${u}/v1/audio/transcriptions`
}

export async function callWhisper(opts: {
  url: string
  apiKey?: string
  model: string
  language?: string
  prompt?: string
  audio: Uint8Array<ArrayBuffer>
  mime: string
  filename: string
}): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([opts.audio], { type: opts.mime }), opts.filename)
  form.append('model', opts.model)
  form.append('response_format', 'json')
  if (opts.language) form.append('language', opts.language)
  if (opts.prompt) form.append('prompt', opts.prompt)

  const res = await fetch(whisperEndpoint(opts.url), {
    method: 'POST',
    headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : undefined,
    body: form,
    signal: AbortSignal.timeout(10 * 60 * 1000),
  })
  if (!res.ok) {
    throw new Error(`whisper answered ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  const out = (await res.json()) as { text?: unknown }
  const text = typeof out.text === 'string' ? out.text.trim() : ''
  return text || NO_SPEECH
}
