/**
 * Runtime configuration, read from the environment with sensible local defaults.
 * DATABASE_URL is a libsql URL — a local file (`file:./data/idj.db`) in dev, or a
 * mounted volume path in the firefly container.
 */
export const env = {
  databaseUrl: process.env.DATABASE_URL ?? 'file:./data/idj.db',
  /** WebAuthn relying-party id — the site's registrable domain (auth phase). */
  rpId: process.env.RP_ID ?? 'localhost',
  rpName: process.env.RP_NAME ?? 'idea-du-jour',

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
