/**
 * Runtime configuration, read from the environment with sensible local defaults.
 * DATABASE_URL is a libsql URL — a local file (`file:./data/idj.db`) in dev, or a
 * mounted volume path in the firefly container.
 */
export const env = {
  databaseUrl: process.env.DATABASE_URL ?? 'file:./data/idj.db',
  /** WebAuthn relying-party id — the site's registrable domain. */
  rpId: process.env.RP_ID ?? 'localhost',
  rpName: process.env.RP_NAME ?? 'idea-du-jour',
  /** Full origin the browser sees — must match exactly for WebAuthn verification. */
  rpOrigin: process.env.RP_ORIGIN ?? 'http://localhost:3000',
  /** HMAC secret for signing session + challenge cookies. MUST be set in prod. */
  sessionSecret:
    process.env.SESSION_SECRET ?? 'dev-insecure-session-secret-change-me',

  /**
   * Agent enrichment: a captured item is asynchronously classified/tagged by
   * Claude, appended as an `item.enriched` event. Off when no key is present so
   * dev works without credentials. The zero-arg SDK client also reads an
   * `ant auth login` profile, but we gate on the key to keep dev quiet.
   */
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  enrichModel: process.env.ENRICH_MODEL ?? 'claude-sonnet-5',
  enrichEnabled: (process.env.ENRICH_ENABLED ?? 'true') !== 'false',

  /**
   * Voice captures. Recordings are kept on disk; by default in an `audio/`
   * folder next to the SQLite file, so they share its volume and its backups.
   */
  audioDir: process.env.AUDIO_DIR ?? defaultAudioDir(),
  /** Largest recording accepted, in bytes. Caddy in front also caps the body. */
  audioMaxBytes: Number(process.env.AUDIO_MAX_BYTES ?? 50 * 1024 * 1024),

  /**
   * Transcription: an OpenAI-compatible `POST /v1/audio/transcriptions`
   * endpoint (faster-whisper via speaches, whisper.cpp's server with
   * `--inference-path`, or OpenAI itself). Unset = recordings are stored and
   * wait, untranscribed, until it is configured; nothing is lost.
   */
  transcribeUrl: process.env.TRANSCRIBE_URL,
  transcribeApiKey: process.env.TRANSCRIBE_API_KEY,
  transcribeModel: process.env.TRANSCRIBE_MODEL ?? 'Systran/faster-whisper-large-v3',
  transcribeLanguage: process.env.TRANSCRIBE_LANGUAGE ?? 'en',
  /**
   * Comma-separated words Whisper tends to mangle (server names, project
   * jargon). Sent as the prompt, together with the inbox's most-used tags.
   */
  transcribeGlossary:
    process.env.TRANSCRIBE_GLOSSARY ??
    'idj, Tuzfal, Uberfall, Pokol, Beelzebub, Firefly, Jackson, Iris, Sentinel, Steamboat, isozilla, Math Camp, shade pyramids, T-parts, tarps, bins',
  /**
   * Agent dispatch: every new capture is handed to a T3 Code webhook task,
   * which starts a thread for it. The URL is the task's full webhook address
   * (it carries the task's token); the secret signs each delivery
   * (`X-Idj-Signature: sha256=<hex HMAC of the body>`). Unset = off.
   */
  t3DispatchUrl: process.env.T3_DISPATCH_URL,
  t3DispatchSecret: process.env.T3_DISPATCH_SECRET,
  /** Public origin, for the item links sent along with a dispatch. */
  publicOrigin: process.env.PUBLIC_ORIGIN ?? process.env.RP_ORIGIN ?? 'http://localhost:3000',

  /** How often the retry sweep looks for untranscribed recordings. 0 = never. */
  transcribeSweepMs: Number(process.env.TRANSCRIBE_SWEEP_MS ?? 5 * 60 * 1000),
}

function defaultAudioDir(): string {
  const url = process.env.DATABASE_URL ?? 'file:./data/idj.db'
  const file = url.replace(/^file:/, '')
  const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return `${slash >= 0 ? file.slice(0, slash) : '.'}/audio`
}
