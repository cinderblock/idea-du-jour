/**
 * Lenient parsing of a raw captured string into a structured item. The raw text
 * is always preserved verbatim by the caller (stored as `first_capture`); this
 * only *derives* convenient fields. Never throws on odd input.
 *
 * v1 keyword grammar (leading, case-insensitive):
 *   todo: / t:   -> task
 *   idea:        -> idea
 *   memory: / rem: -> memory
 * `#tags` are extracted from anywhere in the text (and left in the body).
 */
export type ParsedCapture = {
  kind: string
  body: string
  title: string | null
  tags: string[]
}

const KEYWORD_KIND: Record<string, string> = {
  todo: 'task',
  t: 'task',
  idea: 'idea',
  memory: 'memory',
  rem: 'memory',
}

const KEYWORD_RE = /^\s*(todo|t|idea|memory|rem)\s*:\s*/i
const TAG_RE = /#([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu

export function parseCapture(raw: string): ParsedCapture {
  const text = raw.replace(/\r\n/g, '\n').trim()

  let kind = 'note'
  let body = text

  const kw = text.match(KEYWORD_RE)
  if (kw) {
    kind = KEYWORD_KIND[kw[1].toLowerCase()] ?? 'note'
    body = text.slice(kw[0].length).trim()
  }

  const tags = [
    ...new Set(
      [...body.matchAll(TAG_RE)].map((m) => m[1].toLowerCase()),
    ),
  ]

  const firstLine = body.split('\n', 1)[0].trim()
  const title =
    body.includes('\n') || firstLine.length > 80
      ? firstLine.slice(0, 80).trim() || null
      : null

  return { kind, body, title, tags }
}
