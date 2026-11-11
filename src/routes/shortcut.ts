import { readFileSync } from 'node:fs'
import { createFileRoute } from '@tanstack/react-router'

/**
 * Serve the signed "Record to idj" shortcut with headers that make iOS hand it
 * to the Shortcuts app instead of showing it in Safari.
 *
 * Unauthenticated on purpose: the file holds no secret (the capture token is an
 * import question answered on the phone). Built by `bun run shortcut:build`,
 * signed by `bun run shortcut:sign` (on the Mac mini), committed in public/.
 */
const FILE = 'record-to-idj.shortcut'

export const Route = createFileRoute('/shortcut')({
  server: {
    handlers: {
      GET: async () => {
        let body: Buffer
        try {
          body = readFileSync(`.output/public/${FILE}`)
        } catch {
          try {
            body = readFileSync(`public/${FILE}`) // dev
          } catch {
            return new Response('shortcut not built', { status: 404 })
          }
        }
        return new Response(new Uint8Array(body), {
          headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': `attachment; filename="Record to idj.shortcut"`,
            'cache-control': 'no-cache',
          },
        })
      },
    },
  },
})
