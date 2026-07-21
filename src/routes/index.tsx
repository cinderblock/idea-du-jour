import { useState } from 'react'
import { Link, createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { fetchItems, webCapture } from '../server/webapi'
import { KindBadge, StatusDot, Tags, relativeTime } from '../ui/util'

type Filter = 'open' | 'all' | 'done'

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): { filter?: Filter } => {
    const f = search.filter
    return f === 'all' || f === 'done' ? { filter: f } : {}
  },
  loaderDeps: ({ search }) => ({ filter: search.filter ?? 'open' }),
  loader: ({ deps }) =>
    fetchItems({
      data: { status: deps.filter === 'all' ? undefined : deps.filter },
    }),
  component: Inbox,
})

function Inbox() {
  const { items } = Route.useLoaderData()
  const filter: Filter = Route.useSearch().filter ?? 'open'
  const navigate = useNavigate({ from: Route.fullPath })

  return (
    <main className="mx-auto min-h-screen max-w-2xl px-4 pb-24 pt-6">
      <header className="mb-4">
        <h1 className="text-2xl font-bold tracking-tight">idea-du-jour</h1>
        <p className="text-sm text-gray-500">Capture now, triage later.</p>
      </header>

      <QuickCapture />

      <nav className="mb-3 mt-6 flex gap-1 text-sm">
        {(['open', 'all', 'done'] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => navigate({ search: { filter: f } })}
            className={`rounded-full px-3 py-1 capitalize transition ${
              filter === f
                ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900'
                : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
            }`}
          >
            {f}
          </button>
        ))}
      </nav>

      {items.length === 0 ? (
        <p className="mt-10 text-center text-sm text-gray-400">
          Nothing here. Capture something above.
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                to="/items/$id"
                params={{ id: item.id }}
                className="block rounded-lg border border-gray-200 bg-white p-3 transition hover:border-gray-300 hover:shadow-sm dark:border-gray-800 dark:bg-gray-900 dark:hover:border-gray-700"
              >
                <div className="mb-1 flex items-center gap-2">
                  <StatusDot status={item.status} />
                  <KindBadge kind={item.kind} />
                  <span className="ml-auto text-xs text-gray-400">
                    {relativeTime(item.createdTs)}
                  </span>
                </div>
                <p
                  className={`whitespace-pre-wrap break-words text-sm ${
                    item.status === 'done'
                      ? 'text-gray-400 line-through'
                      : 'text-gray-800 dark:text-gray-200'
                  }`}
                >
                  {truncate(item.body, 240)}
                </p>
                {item.tags.length > 0 && (
                  <div className="mt-2">
                    <Tags tags={item.tags} />
                  </div>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

function QuickCapture() {
  const router = useRouter()
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)

  async function submit() {
    const value = text.trim()
    if (!value || pending) return
    setPending(true)
    try {
      await webCapture({ data: { text: value } })
      setText('')
      await router.invalidate()
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit()
        }}
        rows={2}
        placeholder="todo: … · idea: … · or just a note. #tags welcome."
        className="w-full resize-y bg-transparent text-sm outline-none placeholder:text-gray-400"
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-gray-400">⌘/Ctrl + Enter</span>
        <button
          type="button"
          onClick={submit}
          disabled={!text.trim() || pending}
          className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white transition disabled:opacity-40 dark:bg-white dark:text-gray-900"
        >
          {pending ? 'Capturing…' : 'Capture'}
        </button>
      </div>
    </div>
  )
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n).trimEnd()}…` : s
}
