import { useState } from 'react'
import {
  Link,
  createFileRoute,
  isRedirect,
  redirect,
  useRouter,
} from '@tanstack/react-router'
import type { Event } from '../db/schema'
import { addComment, fetchItem, getAuth, setItemStatus } from '../server/webapi'
import { wasAuthed } from '../ui/offline'
import { KindBadge, StatusDot, Tags, relativeTime } from '../ui/util'

export const Route = createFileRoute('/items/$id')({
  beforeLoad: async () => {
    try {
      const { userId } = await getAuth()
      if (!userId) throw redirect({ to: '/login' })
    } catch (e) {
      if (isRedirect(e)) throw e
      if (!wasAuthed()) throw redirect({ to: '/login' })
    }
  },
  loader: ({ params }) =>
    fetchItem({ data: { id: params.id } }).catch(() => null),
  component: ItemDetail,
})

function ItemDetail() {
  const data = Route.useLoaderData()
  const router = useRouter()

  if (!data) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <BackLink />
        <p className="mt-8 text-center text-sm text-gray-400">Item not found.</p>
      </main>
    )
  }

  const { item, events } = data
  const comments = events.filter((e) => e.type === 'item.commented')

  async function toggleStatus() {
    await setItemStatus({
      data: { id: item.id, status: item.status === 'done' ? 'open' : 'done' },
    })
    await router.invalidate()
  }

  return (
    <main className="mx-auto max-w-2xl px-4 pb-24 pt-6">
      <BackLink />

      <article className="mt-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
        <div className="mb-2 flex items-center gap-2">
          <StatusDot status={item.status} />
          <KindBadge kind={item.kind} />
          <span className="text-xs capitalize text-gray-500">{item.status}</span>
          <span className="ml-auto text-xs text-gray-400">
            {relativeTime(item.createdTs)}
          </span>
        </div>

        <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-gray-800 dark:text-gray-100">
          {item.body}
        </p>

        {item.summary && (
          <p className="mt-3 border-l-2 border-amber-300 pl-3 text-sm italic text-gray-500 dark:border-amber-700 dark:text-gray-400">
            {item.summary}
          </p>
        )}

        {item.tags.length > 0 && (
          <div className="mt-3">
            <Tags tags={item.tags} />
          </div>
        )}

        <div className="mt-4 flex gap-2 border-t border-gray-100 pt-3 dark:border-gray-800">
          <button
            type="button"
            onClick={toggleStatus}
            className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white transition dark:bg-white dark:text-gray-900"
          >
            {item.status === 'done' ? 'Reopen' : 'Mark done'}
          </button>
        </div>
      </article>

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-semibold text-gray-500">
          Activity{comments.length ? ` · ${comments.length} comment${comments.length > 1 ? 's' : ''}` : ''}
        </h2>
        <ol className="space-y-2">
          {events.map((ev) => (
            <ActivityRow key={ev.seq} ev={ev} />
          ))}
        </ol>
      </section>

      <CommentBox itemId={item.id} />
    </main>
  )
}

function ActivityRow({ ev }: { ev: Event }) {
  if (ev.type === 'item.commented') {
    const text = (ev.payload as { text?: string }).text ?? ''
    return (
      <li className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900">
        <div className="mb-1 flex items-center gap-2 text-xs text-gray-400">
          <span className="font-medium text-gray-600 dark:text-gray-300">
            {ev.actor}
          </span>
          <span>{relativeTime(ev.ts)}</span>
        </div>
        <p className="whitespace-pre-wrap break-words text-sm text-gray-800 dark:text-gray-200">
          {text}
        </p>
      </li>
    )
  }

  const label: Record<string, string> = {
    'item.created': 'captured',
    'item.done': 'marked done',
    'item.reopened': 'reopened',
    'item.archived': 'archived',
    'item.edited': 'edited',
    'item.deleted': 'deleted',
  }
  return (
    <li className="flex items-center gap-2 px-1 text-xs text-gray-400">
      <span className="h-1 w-1 rounded-full bg-gray-300 dark:bg-gray-600" />
      <span>
        {label[ev.type] ?? ev.type} · {ev.actor} · {relativeTime(ev.ts)}
      </span>
    </li>
  )
}

function CommentBox({ itemId }: { itemId: string }) {
  const router = useRouter()
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)

  async function submit() {
    const value = text.trim()
    if (!value || pending) return
    setPending(true)
    try {
      await addComment({ data: { id: itemId, text: value } })
      setText('')
      await router.invalidate()
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit()
        }}
        rows={2}
        placeholder="Add a comment…"
        className="w-full resize-y bg-transparent text-sm outline-none placeholder:text-gray-400"
      />
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={submit}
          disabled={!text.trim() || pending}
          className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white transition disabled:opacity-40 dark:bg-white dark:text-gray-900"
        >
          {pending ? 'Posting…' : 'Comment'}
        </button>
      </div>
    </div>
  )
}

function BackLink() {
  return (
    <Link
      to="/"
      className="text-sm text-gray-500 transition hover:text-gray-800 dark:hover:text-gray-200"
    >
      ← Inbox
    </Link>
  )
}
