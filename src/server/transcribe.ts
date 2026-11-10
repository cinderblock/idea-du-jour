import { readAudio } from './audio'
import { enqueueEnrichment } from './enrich'
import { env } from './env'
import { getItem, listUntranscribed, transcribeItem } from './events'
import { buildPrompt } from './glossary'

/**
 * Async transcription of voice captures, shaped like `enrich.ts`: capture
 * stores the recording and returns at once; this module sends it to a Whisper
 * server in the background and appends `item.transcribed`, then hands the item
 * to the enricher.
 *
 * Failure is never loss. The recording is already on disk, so a dead or
 * unconfigured Whisper server just leaves the item untranscribed, and the sweep
 * (`startTranscribeSweep`) retries it later.
 */

const inFlight = new Set<string>()

/** Fire-and-forget transcription for one item. Never throws into the caller. */
export function enqueueTranscription(itemId: string): void {
  if (!env.transcribeUrl) return
  void runTranscription(itemId).catch((err) => {
    console.error(`[transcribe] failed for ${itemId}:`, err)
  })
}

/**
 * Transcribe a recording again with the current glossary (e.g. after an agent
 * added a name it mangled). Throws on failure; returns the new text.
 */
export async function retranscribe(itemId: string): Promise<string | null> {
  return runTranscription(itemId, { force: true })
}

/** Returns the transcript, or null when there was nothing to do. */
async function runTranscription(
  itemId: string,
  opts: { force?: boolean } = {},
): Promise<string | null> {
  if (!env.transcribeUrl || inFlight.has(itemId)) return null
  inFlight.add(itemId)
  try {
    const data = await getItem(itemId)
    if (!data?.item.audio) return null
    if (data.item.transcribedTs && !opts.force) return null
    const { audio } = data.item

    const prompt = await buildPrompt()
    const bytes = await readAudio(audio)
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: audio.mime }), audio.file)
    form.append('model', env.transcribeModel)
    form.append('response_format', 'json')
    if (env.transcribeLanguage) form.append('language', env.transcribeLanguage)
    if (prompt) form.append('prompt', prompt)

    const res = await fetch(endpoint(env.transcribeUrl), {
      method: 'POST',
      headers: env.transcribeApiKey
        ? { Authorization: `Bearer ${env.transcribeApiKey}` }
        : undefined,
      body: form,
      signal: AbortSignal.timeout(10 * 60 * 1000),
    })
    if (!res.ok) {
      throw new Error(`whisper answered ${res.status}: ${(await res.text()).slice(0, 300)}`)
    }
    const out = (await res.json()) as { text?: unknown }
    const text = typeof out.text === 'string' ? out.text.trim() : ''
    if (!text) {
      // Silence or a pocket recording. Record it, so the sweep stops retrying,
      // and leave a visible marker rather than an empty card.
      const none = '(no speech detected)'
      await transcribeItem({ itemId, text: none, model: env.transcribeModel, prompt })
      return none
    }

    await transcribeItem({ itemId, text, model: env.transcribeModel, prompt })
    enqueueEnrichment(itemId)
    return text
  } finally {
    inFlight.delete(itemId)
  }
}

/**
 * Accept either a base URL (`https://whisper.example`) or the full endpoint;
 * the OpenAI-compatible path is appended when it's missing.
 */
function endpoint(url: string): string {
  const u = url.replace(/\/+$/, '')
  return /\/audio\/transcriptions$|\/inference$/.test(u) ? u : `${u}/v1/audio/transcriptions`
}

/** Retry every untranscribed recording. Returns how many were transcribed. */
export async function transcribePending(limit = 20): Promise<number> {
  if (!env.transcribeUrl) return 0
  let done = 0
  for (const item of await listUntranscribed(limit)) {
    try {
      if ((await runTranscription(item.id)) !== null) done++
    } catch (err) {
      // One line, not a stack: while Whisper is down this repeats every sweep.
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[transcribe] sweep: ${item.id} still waiting (${msg})`)
      break // the server is probably down; the next sweep tries again
    }
  }
  return done
}

let sweepTimer: ReturnType<typeof setInterval> | null = null

/** Start the periodic retry sweep (idempotent). Runs once immediately too. */
export function startTranscribeSweep(): void {
  if (sweepTimer || !env.transcribeUrl || env.transcribeSweepMs <= 0) return
  const tick = () => {
    void transcribePending().catch((err) => console.error('[transcribe] sweep:', err))
  }
  sweepTimer = setInterval(tick, env.transcribeSweepMs)
  sweepTimer.unref?.()
  tick()
}
