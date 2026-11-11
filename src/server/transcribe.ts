import { readAudio } from './audio'
import { enqueueDispatch } from './dispatch'
import { enqueueEnrichment } from './enrich'
import { env } from './env'
import { getItem, listUntranscribed, transcribeItem } from './events'
import { buildPrompt } from './glossary'
import { NO_SPEECH, callWhisper } from './whisper'

/**
 * Async transcription of voice captures, shaped like `enrich.ts`: capture
 * stores the recording and returns at once; this module sends it to a Whisper
 * server in the background and appends `item.transcribed`, then hands the item
 * to the enricher.
 *
 * There are two ways a recording gets transcribed:
 *  - push: this server calls TRANSCRIBE_URL itself (when it can reach one);
 *  - pull: a worker next to the GPU long-polls `GET /api/transcribe/queue`,
 *    transcribes, and posts `POST /api/items/:id/transcript`. Used when the
 *    GPU box can reach idj but not the other way round.
 * Both end in `recordTranscript`.
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

/** Returns the transcript, or null when there was nothing to do. */
async function runTranscription(itemId: string): Promise<string | null> {
  if (!env.transcribeUrl || inFlight.has(itemId)) return null
  inFlight.add(itemId)
  try {
    const data = await getItem(itemId)
    if (!data?.item.audio || data.item.transcribedTs) return null
    const { audio } = data.item

    const prompt = await buildPrompt()
    const text = await callWhisper({
      url: env.transcribeUrl,
      apiKey: env.transcribeApiKey,
      model: env.transcribeModel,
      language: env.transcribeLanguage,
      prompt,
      audio: await readAudio(audio),
      mime: audio.mime,
      filename: audio.file,
    })
    await recordTranscript({ itemId, text, model: env.transcribeModel, prompt })
    return text
  } finally {
    inFlight.delete(itemId)
  }
}

/**
 * Store a transcript, from whichever transcriber produced it (this server or a
 * remote worker), and hand the item on to enrichment.
 */
export async function recordTranscript(opts: {
  itemId: string
  text: string
  model: string
  prompt?: string
  actor?: string
}): Promise<void> {
  const text = opts.text.trim() || NO_SPEECH
  const first = !(await getItem(opts.itemId))?.item.transcribedTs
  await transcribeItem({ ...opts, text })
  if (text === NO_SPEECH) return
  enqueueEnrichment(opts.itemId)
  // A voice capture goes to the dispatcher once it has text, and only the
  // first time: a re-transcription isn't a new capture.
  if (first) enqueueDispatch(opts.itemId)
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
