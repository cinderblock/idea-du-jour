/** Small presentation helpers shared across the triage UI. */

export function relativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts
  const s = Math.round(diff / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d ago`
  const w = Math.round(d / 7)
  if (w < 5) return `${w}w ago`
  return new Date(ts).toLocaleDateString()
}

const KIND_STYLE: Record<string, string> = {
  task: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  idea: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  memory: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
  note: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
}

export function KindBadge({ kind }: { kind: string }) {
  const cls = KIND_STYLE[kind] ?? KIND_STYLE.note
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}
    >
      {kind}
    </span>
  )
}

export function StatusDot({ status }: { status: string }) {
  const color =
    status === 'done'
      ? 'bg-green-500'
      : status === 'archived'
        ? 'bg-gray-400'
        : 'bg-blue-500'
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`}
      aria-label={status}
    />
  )
}

export function Tags({ tags }: { tags: string[] }) {
  if (!tags.length) return null
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <span
          key={t}
          className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400"
        >
          #{t}
        </span>
      ))}
    </div>
  )
}
