/**
 * Transcription worker: runs next to the GPU, pulls voice captures from idj,
 * transcribes them with a local Whisper server, and posts the text back.
 *
 * Pull, not push: the GPU box (sentinel) can reach idj over HTTPS, but idj
 * (firefly) can't reach it, and doesn't need to. Every connection is outbound
 * from here.
 *
 *   IDJ_BASE_URL       https://idj.isozilla.com
 *   IDJ_AGENT_TOKEN    agent-scope token (reads the queue + audio, posts text)
 *   WHISPER_URL        OpenAI-compatible server, e.g. http://whisper:8000
 *   WHISPER_API_KEY    optional
 *   TRANSCRIBE_MODEL   default Systran/faster-whisper-large-v3
 *   TRANSCRIBE_LANGUAGE default en
 *
 *   bun run scripts/transcribe-worker.ts
 */
import { callWhisper } from '../src/server/whisper'

const base = need('IDJ_BASE_URL').replace(/\/+$/, '')
const token = need('IDJ_AGENT_TOKEN')
const whisperUrl = need('WHISPER_URL').replace(/\/+$/, '')
const whisperKey = process.env.WHISPER_API_KEY || undefined
const model = process.env.TRANSCRIBE_MODEL || 'Systran/faster-whisper-large-v3'
const language = process.env.TRANSCRIBE_LANGUAGE ?? 'en'

const auth = { Authorization: `Bearer ${token}` }

type Job = {
  id: string
  mime: string
  bytes: number
  filename: string
  audio: string
  transcript: string
  prompt: string
}

function need(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`[worker] ${name} is required`)
    process.exit(2)
  }
  return v
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function log(msg: string) {
  console.log(`${new Date().toISOString()} [worker] ${msg}`)
}

/**
 * speaches only serves models it has downloaded; `POST /v1/models/<id>` fetches
 * one (a no-op once it's there). Other servers may not have the route, so a 404
 * or 405 is fine: the first transcription will say if the model is missing.
 */
async function ensureModel(): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`${whisperUrl}/v1/models/${model}`, {
        method: 'POST',
        headers: whisperKey ? { Authorization: `Bearer ${whisperKey}` } : undefined,
        signal: AbortSignal.timeout(30 * 60 * 1000), // first download is ~3 GB
      })
      // Any answer means the server is up. A failure here isn't fatal: the
      // first transcription reports the real problem, and backs off.
      const detail = res.ok ? '' : ` ${(await res.text()).replace(/\s+/g, ' ').slice(0, 160)}`
      log(`model ${model}: ${res.status}${detail}`)
      return
    } catch (e) {
      log(`whisper not reachable yet (${(e as Error).message}); retrying`)
    }
    await sleep(10_000)
  }
}

async function fetchJobs(): Promise<Job[]> {
  const res = await fetch(`${base}/api/transcribe/queue?wait=8&limit=5`, {
    headers: auth,
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`queue answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return ((await res.json()) as { jobs: Job[] }).jobs
}

async function runJob(job: Job): Promise<void> {
  const started = Date.now()
  const res = await fetch(`${base}${job.audio}`, { headers: auth, signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`audio ${job.id} answered ${res.status}`)
  const audio = new Uint8Array(await res.arrayBuffer())

  const text = await callWhisper({
    url: whisperUrl,
    apiKey: whisperKey,
    model,
    language: language || undefined,
    prompt: job.prompt || undefined,
    audio,
    mime: job.mime,
    filename: job.filename,
  })

  const post = await fetch(`${base}${job.transcript}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model, prompt: job.prompt }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!post.ok) throw new Error(`transcript ${job.id} answered ${post.status}: ${(await post.text()).slice(0, 200)}`)
  log(`${job.id}: ${audio.byteLength} bytes in ${Date.now() - started} ms: ${JSON.stringify(text.slice(0, 80))}`)
}

let stopping = false
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log(`${sig}: stopping after the current job`)
    stopping = true
  })
}

log(`idj ${base}, whisper ${whisperUrl}, model ${model}`)
await ensureModel()

let backoff = 0
while (!stopping) {
  try {
    const jobs = await fetchJobs()
    for (const job of jobs) {
      if (stopping) break
      await runJob(job)
    }
    backoff = 0
  } catch (e) {
    // Whisper down, idj deploying, network blip: wait and try again. A job
    // isn't removed from the queue until its transcript is posted.
    backoff = Math.min(backoff ? backoff * 2 : 5_000, 120_000)
    log(`${(e as Error).message}; retrying in ${backoff / 1000}s`)
    await sleep(backoff)
  }
}
process.exit(0)
