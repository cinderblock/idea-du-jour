import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import { env } from './env'
import { enrichItem, getItem, listUnenriched } from './events'

/**
 * Async agent enrichment. A captured item is classified/tagged/summarized by
 * Claude and the result appended as an `item.enriched` event — never inline in
 * the capture path (capture must stay instant and never fail on the LLM).
 *
 * The enricher is decoupled: capture fires `enqueueEnrichment(id)` and returns;
 * this module talks to Claude in the background and writes back through the same
 * append-only log everything else uses.
 */

const Enrichment = z.object({
  kind: z
    .enum(['task', 'idea', 'note', 'memory'])
    .describe('Best-fit type for this captured text.'),
  title: z
    .string()
    .describe('A short (<=8 word) title. No trailing punctuation.'),
  tags: z
    .array(z.string())
    .describe('0-5 lowercase topic tags, no # prefix, single words or kebab-case.'),
  summary: z
    .string()
    .describe('One concise sentence capturing the gist. Empty string if trivial.'),
})

const SYSTEM = `You classify and enrich short personal captures (notes, todos, ideas, memories) for a triage inbox.
Preserve the author's intent. Do not invent facts, expand scope, or add task steps.
Prefer 'task' for anything actionable, 'idea' for proposals/possibilities, 'memory' for things to remember, 'note' otherwise.
Keep titles and summaries faithful and terse.`

let client: Anthropic | null = null
function getClient(): Anthropic | null {
  if (!env.anthropicApiKey) return null
  client ??= new Anthropic()
  return client
}

/** Fire-and-forget enrichment for one item. Never throws into the caller. */
export function enqueueEnrichment(itemId: string): void {
  if (!env.enrichEnabled) return
  void runEnrichment(itemId).catch((err) => {
    console.error(`[enrich] failed for ${itemId}:`, err)
  })
}

async function runEnrichment(itemId: string): Promise<void> {
  const c = getClient()
  if (!c) return // no key configured — skip silently (dev)

  const data = await getItem(itemId)
  if (!data || data.item.enrichedTs) return
  const { item } = data

  const res = await c.messages.parse({
    model: env.enrichModel,
    max_tokens: 1024,
    thinking: { type: 'disabled' }, // cheap classify task — no thinking needed
    output_config: { format: zodOutputFormat(Enrichment), effort: 'low' },
    system: SYSTEM,
    messages: [{ role: 'user', content: item.firstCapture }],
  })

  const out = res.parsed_output
  if (!out) return

  await enrichItem({ itemId, enrichment: out, model: env.enrichModel })
}

/** Catch-up sweep: enrich any items that never got processed (e.g. key added later). */
export async function enrichPending(limit = 20): Promise<number> {
  if (!env.enrichEnabled || !getClient()) return 0
  const pending = await listUnenriched(limit)
  for (const item of pending) {
    await runEnrichment(item.id)
  }
  return pending.length
}
