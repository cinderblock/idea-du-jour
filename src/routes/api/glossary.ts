import { createFileRoute } from '@tanstack/react-router'
import {
  GlossaryError,
  MAX_TERMS,
  PROMPT_BUDGET,
  buildPrompt,
  currentGlossary,
  glossaryHistory,
  normaliseTerms,
  saveGlossary,
} from '../../server/glossary'
import { AuthError, authenticate } from '../../server/tokens'

function authFail(e: unknown) {
  if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status })
  throw e
}

/**
 * The Whisper vocabulary. GET shows the current list, the exact prompt it
 * produces, and (with `?history=N`) earlier versions. PUT replaces the whole
 * list with a new version: `{terms: [...], note: "why"}`, terms ordered most
 * important first (strings or `{term, note}`).
 */
export const Route = createFileRoute('/api/glossary')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          await authenticate(request, 'agent')
        } catch (e) {
          return authFail(e)
        }
        const url = new URL(request.url)
        const history = Number(url.searchParams.get('history') ?? 0)
        const current = await currentGlossary()
        return Response.json({
          current,
          prompt: await buildPrompt(),
          limits: { maxTerms: MAX_TERMS, promptBudgetChars: PROMPT_BUDGET },
          history: history > 0 ? await glossaryHistory(history) : undefined,
        })
      },
      PUT: async ({ request }) => {
        let tokenId: string
        try {
          tokenId = (await authenticate(request, 'agent')).id
        } catch (e) {
          return authFail(e)
        }
        const body = (await request.json().catch(() => null)) as {
          terms?: unknown
          note?: unknown
          actor?: unknown
        } | null
        if (!body) return Response.json({ error: 'expected JSON' }, { status: 400 })
        try {
          const terms = normaliseTerms(body.terms)
          const saved = await saveGlossary({
            terms,
            note: typeof body.note === 'string' ? body.note : null,
            actor: typeof body.actor === 'string' && body.actor ? body.actor : 'agent',
            tokenId,
          })
          return Response.json({ saved, prompt: await buildPrompt() })
        } catch (e) {
          if (e instanceof GlossaryError) {
            return Response.json({ error: e.message }, { status: 400 })
          }
          throw e
        }
      },
    },
  },
})
