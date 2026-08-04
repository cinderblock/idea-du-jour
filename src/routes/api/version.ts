import { readFileSync } from 'node:fs'
import { createFileRoute } from '@tanstack/react-router'

/**
 * Reports the release this process is serving. The deploy workflow polls this
 * after flipping `current` + touching the restart sentinel, to prove the
 * supervisor actually restarted into the NEW release (a plain 200 could just be
 * the old process still serving).
 *
 * BUILD_SHA is written into the release tree by CI; missing in dev.
 */
let cached: string | null = null

function buildSha(): string {
  if (cached !== null) return cached
  try {
    cached = readFileSync('BUILD_SHA', 'utf8').trim()
  } catch {
    cached = 'dev'
  }
  return cached
}

export const Route = createFileRoute('/api/version')({
  server: {
    handlers: {
      // Unauthenticated on purpose: it exposes only a commit SHA, and the
      // deploy health check runs before any session exists.
      GET: async () => Response.json({ sha: buildSha() }),
    },
  },
})
