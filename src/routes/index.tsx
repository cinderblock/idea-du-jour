import { useCallback, useEffect, useState } from 'react'
import {
  Link,
  createFileRoute,
  isRedirect,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import type { Item } from '../db/schema'
import { fetchItems, getAuth, webCapture } from '../server/webapi'
import {
  cacheInbox,
  cachedInbox,
  enqueueCapture,
  flushPending,
  pendingItems,
  setAuthed,
  wasAuthed,
} from '../ui/offline'
import { KindBadge, StatusDot, Tags, relativeTime } from '../ui/util'

type Filter = 'open' | 'all' | 'done'

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    try {
      const { userId } = await getAuth()
      if (!userId) throw redirect({ to: '/login' })
    } catch (e) {
      if (isRedirect(e)) throw e
      // Session check couldn't reach the server (offline). Stay in the app if
      // this browser has authenticated before; otherwise send to /login.
      if (!wasAuthed()) throw redirect({ to: '/login' })
    }
  },
  validateSearch: (search: Record<string, unknown>): { filter?: Filter } => {
    const f = search.filter
    return f === 'all' || f === 'done' ? { filter: f } : {}
  },
  loaderDeps: ({ search }) => ({ filter: search.filter ?? 'open' }),
  loader: async ({ deps }) => {
    try {
      const res = await fetchItems({
        data: { status: deps.filter === 'all' ? undefined : deps.filter },
      })
      cacheInbox(res.items)
      return { items: res.items, offline: false }
    } catch {
      // Offline — serve the last cached inbox.
      return { items: cachedInbox(), offline: true }
    }
  },
  component: Inbox,
})

function Inbox() {
  const { items, offline } = Route.useLoaderData()
  const filter: Filter = Route.useSearch().filter ?? 'open'
  const navigate = useNavigate({ from: Route.fullPath })
  const router = useRouter()

  const [pending, setPending] = useState<Array<Item & { pending: true }>>([])
  const [online, setOnline] = useState(true)

  const refreshPending = useCallback(() => setPending(pendingItems()), [])

  const flush = useCallback(async () => {
    const synced = await flushPending((text) =>
      webCapture({ data: { text } }).then(() => undefined),
    )
    refreshPending()
    if (synced > 0) await router.invalidate()
  }, [refreshPending, router])

  useEffect(() => {
    setAuthed(true) // reaching the inbox means we're authenticated
    refreshPending()
    setOnline(navigator.onLine)
    if (navigator.onLine) void flush()

    const goOnline = () => {
      setOnline(true)
      void flush()
    }
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [flush, refreshPending])

  const showOffline = offline || !online
  // pending captures aren't filtered/statused yet — show them on open/all only.
  const showPending = filter !== 'done'
  const visiblePending = showPending ? pending : []
  const empty = items.length === 0 && visiblePending.length === 0

  return (
    <main className="mx-auto min-h-screen max-w-2xl px-4 pb-24 pt-6">
      <header className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">idea-du-jour</h1>
          <p className="text-sm text-gray-500">Capture now, triage later.</p>
        </div>
        <button
          type="button"
          onClick={async () => {
            setAuthed(false)
            await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
            navigate({ to: '/login' })
          }}
          className="mt-1 text-xs text-gray-400 transition hover:text-gray-700 dark:hover:text-gray-200"
        >
          Sign out
        </button>
      </header>

      {(showOffline || pending.length > 0) && (
        <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
          {showOffline
            ? 'Offline — captures are saved on this device and sync when you reconnect.'
            : `Syncing ${pending.length} queued capture${pending.length > 1 ? 's' : ''}…`}
        </div>
      )}

      <QuickCapture
        onCaptured={async () => {
          await router.invalidate()
          void flush()
        }}
        onQueued={refreshPending}
      />

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

      {empty ? (
        <p className="mt-10 text-center text-sm text-gray-400">
          Nothing here. Capture something above.
        </p>
      ) : (
        <ul className="space-y-2">
          {visiblePending.map((item) => (
            <li key={item.id}>
              <div className="block rounded-lg border border-dashed border-amber-300 bg-white p-3 dark:border-amber-800/60 dark:bg-gray-900">
                <CardBody item={item} pending />
              </div>
            </li>
          ))}
          {items.map((item) => (
            <li key={item.id}>
              <Link
                to="/items/$id"
                params={{ id: item.id }}
                className="block rounded-lg border border-gray-200 bg-white p-3 transition hover:border-gray-300 hover:shadow-sm dark:border-gray-800 dark:bg-gray-900 dark:hover:border-gray-700"
              >
                <CardBody item={item} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

function CardBody({ item, pending }: { item: Item; pending?: boolean }) {
  return (
    <>
      <div className="mb-1 flex items-center gap-2">
        <StatusDot status={item.status} />
        <KindBadge kind={item.kind} />
        {pending && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            pending
          </span>
        )}
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
    </>
  )
}

function QuickCapture({
  onCaptured,
  onQueued,
}: {
  onCaptured: () => void | Promise<void>
  onQueued: () => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  async function submit() {
    const value = text.trim()
    if (!value || busy) return
    setBusy(true)
    setNote(null)
    try {
      await webCapture({ data: { text: value } })
      setText('')
      await onCaptured()
    } catch {
      // Offline or server unreachable — queue locally, never lose it.
      enqueueCapture(value)
      setText('')
      onQueued()
      setNote('Saved offline — will sync when you reconnect.')
    } finally {
      setBusy(false)
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
        <span className="text-xs text-gray-400">
          {note ?? '⌘/Ctrl + Enter'}
        </span>
        <button
          type="button"
          onClick={submit}
          disabled={!text.trim() || busy}
          className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white transition disabled:opacity-40 dark:bg-white dark:text-gray-900"
        >
          {busy ? 'Capturing…' : 'Capture'}
        </button>
      </div>
    </div>
  )
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n).trimEnd()}…` : s
}
