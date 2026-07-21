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
}
