import { readFileSync } from 'node:fs'
import { createFileRoute } from '@tanstack/react-router'

/**
 * Serve the "Memo to idj" shortcut with headers that make iOS hand it to the
 * Shortcuts app. Static serving gives it `text/plain` (it's XML), which Safari
 * just renders on screen — useless for installing.
 *
 * Unauthenticated on purpose: the file contains no secret (the capture token is
 * an import question the user answers on their device).
 */
export const Route = createFileRoute('/shortcut')({
  server: {
    handlers: {
      GET: async () => {
        let body: Buffer
        try {
          body = readFileSync('.output/public/idj-memo.shortcut')
        } catch {
          try {
            body = readFileSync('public/idj-memo.shortcut') // dev
          } catch {
            return new Response('shortcut not built', { status: 404 })
          }
        }
        return new Response(new Uint8Array(body), {
          headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="idj-memo.shortcut"',
            'cache-control': 'no-cache',
          },
        })
      },
    },
  },
})
