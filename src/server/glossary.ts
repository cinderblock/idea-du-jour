import { desc } from 'drizzle-orm'
import { db } from '../db/client'
import { glossaryVersions, items, type GlossaryTerm } from '../db/schema'
import { env } from './env'

/**
 * The vocabulary Whisper is primed with. Stored as append-only versions; an
 * agent (a scheduled T3 task) reads it, studies recent transcripts for mangled
 * names, and writes a new version. Until the first version exists, the
 * TRANSCRIBE_GLOSSARY env default is used.
 */

export const MAX_TERMS = 200
export const MAX_TERM_LEN = 60
/** Character budget for the prompt. Whisper reads at most ~224 tokens of it. */
export const PROMPT_BUDGET = 600

export async function currentGlossary() {
  const [row] = await db
    .select()
    .from(glossaryVersions)
    .orderBy(desc(glossaryVersions.seq))
    .limit(1)
  if (row) return { ...row, source: 'stored' as const }
  const terms = env.transcribeGlossary
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((term) => ({ term }))
  return {
    seq: 0,
    ts: null,
    actor: 'env:TRANSCRIBE_GLOSSARY',
    tokenId: null,
    terms,
    note: null,
    source: 'default' as const,
  }
}

export async function glossaryHistory(limit = 20) {
  return db
    .select()
    .from(glossaryVersions)
    .orderBy(desc(glossaryVersions.seq))
    .limit(Math.min(limit, 200))
}

export class GlossaryError extends Error {}

/** Validate and normalise an incoming list: strings or {term, note}. */
export function normaliseTerms(input: unknown): GlossaryTerm[] {
  if (!Array.isArray(input)) throw new GlossaryError('terms must be an array')
  const seen = new Set<string>()
  const out: GlossaryTerm[] = []
  for (const raw of input) {
    const t =
      typeof raw === 'string'
        ? { term: raw }
        : raw && typeof raw === 'object' && typeof (raw as GlossaryTerm).term === 'string'
          ? (raw as GlossaryTerm)
          : null
    if (!t) throw new GlossaryError('each term must be a string or {term, note?}')
    const term = t.term.replace(/\s+/g, ' ').trim()
    if (!term) continue
    if (term.length > MAX_TERM_LEN) {
      throw new GlossaryError(`term too long (max ${MAX_TERM_LEN}): ${term.slice(0, 80)}`)
    }
    if (/[,\n]/.test(term)) throw new GlossaryError(`terms can't contain commas: ${term}`)
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const note = typeof t.note === 'string' && t.note.trim() ? t.note.trim().slice(0, 300) : undefined
    out.push(note ? { term, note } : { term })
  }
  if (out.length > MAX_TERMS) throw new GlossaryError(`too many terms (max ${MAX_TERMS})`)
  return out
}

export async function saveGlossary(opts: {
  terms: GlossaryTerm[]
  note?: string | null
  actor: string
  tokenId?: string | null
}) {
  const [row] = await db
    .insert(glossaryVersions)
    .values({
      ts: Date.now(),
      actor: opts.actor,
      tokenId: opts.tokenId ?? null,
      terms: opts.terms,
      note: opts.note?.trim() || null,
    })
    .returning()
  return row
}

/**
 * The Whisper prompt: glossary terms (most important first), then the inbox's
 * most-used tags, cut to the budget at a term boundary.
 */
export async function buildPrompt(): Promise<string> {
  const glossary = (await currentGlossary()).terms.map((t) => t.term)

  const recent = await db
    .select({ tags: items.tags })
    .from(items)
    .orderBy(desc(items.createdTs))
    .limit(200)
  const counts = new Map<string, number>()
  for (const row of recent) for (const t of row.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  const tags = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([t]) => t.replace(/-/g, ' '))

  const seen = new Set<string>()
  const kept: string[] = []
  let length = 0
  for (const w of [...glossary, ...tags]) {
    const key = w.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (length + w.length + 2 > PROMPT_BUDGET) break
    kept.push(w)
    length += w.length + 2
  }
  return kept.length ? `Vocabulary: ${kept.join(', ')}.` : ''
}
