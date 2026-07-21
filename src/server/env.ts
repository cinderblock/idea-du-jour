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
}
