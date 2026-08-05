import { createFileRoute } from '@tanstack/react-router'

/**
 * Diagnostic mirror: reports exactly what the server received. Point a Shortcut
 * (or curl) at it and add a "Show Result" action to see whether your headers
 * actually arrived — Shortcuts' headers UI fails silently, and a redirect
 * (typing http:// or omitting the scheme) makes clients drop Authorization.
 *
 * Deliberately unauthenticated: it only reflects what the caller already sent,
 * and it must work precisely when auth is what's broken. The token value is
 * NEVER echoed — only whether it parsed, plus its id prefix and length, which
 * is enough to spot a truncated or mis-pasted paste without leaking the secret.
 */
export const Route = createFileRoute('/api/echo')({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        const url = new URL(request.url)
        const headerNames: string[] = []
        request.headers.forEach((_v, k) => headerNames.push(k))
        headerNames.sort()

        const auth = request.headers.get('authorization')
        let authReport: Record<string, unknown>
        if (!auth) {
          authReport = {
            present: false,
            hint: 'No Authorization header arrived. In Shortcuts, expand "Get Contents of URL" → Headers → add a row with Key "Authorization" and Value "Bearer <token>", and make sure the URL starts with https:// (a redirect drops the header).',
          }
        } else {
          const m = auth.match(/^(\S+)\s+(.*)$/)
          const scheme = m ? m[1] : '(no scheme)'
          const value = m ? m[2] : auth
          const parts = value.split('_')
          authReport = {
            present: true,
            scheme,
            looksLikeBearer: /^bearer$/i.test(scheme),
            tokenLength: value.length,
            tokenIdPrefix: parts.length >= 4 ? `${parts[0]}_${parts[1]}_${parts[2]}` : null,
            wellFormed: parts.length >= 4 && parts[0] === 'idj',
          }
        }

        const contentType = request.headers.get('content-type') ?? null
        const raw = await request.text().catch(() => '')
        let jsonKeys: string[] | null = null
        try {
          const parsed = JSON.parse(raw) as unknown
          if (parsed && typeof parsed === 'object') {
            jsonKeys = Object.keys(parsed as Record<string, unknown>)
          }
        } catch {
          jsonKeys = null
        }

        return Response.json(
          {
            ok: true,
            method: request.method,
            path: url.pathname,
            // If this says http, a redirect happened and headers were likely
            // dropped — use an https:// URL in the Shortcut.
            forwardedProto: request.headers.get('x-forwarded-proto') ?? null,
            authorization: authReport,
            contentType,
            bodyBytes: raw.length,
            jsonKeys,
            headersReceived: headerNames,
          },
          { headers: { 'cache-control': 'no-store' } },
        )
      },
    },
  },
})
