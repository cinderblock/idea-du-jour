import { useState } from 'react'
import { Link, createFileRoute, isRedirect, redirect, useRouter } from '@tanstack/react-router'
import { decideDevice, fetchDevices, getAuth } from '../server/webapi'
import { relativeTime } from '../ui/util'

/**
 * Paired devices: phones running the "Record to idj" shortcut, which sends a
 * device ID instead of a token. A new phone shows up here as pending, with its
 * captures held; approving it releases them into the inbox.
 */
export const Route = createFileRoute('/devices')({
  beforeLoad: async () => {
    try {
      const { userId } = await getAuth()
      if (!userId) throw redirect({ to: '/login' })
    } catch (e) {
      if (isRedirect(e)) throw e
      throw redirect({ to: '/login' })
    }
  },
  loader: () => fetchDevices(),
  component: Devices,
})

type Row = Awaited<ReturnType<typeof fetchDevices>>['devices'][number]

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  approved: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  rejected: 'bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  revoked: 'bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
}

function Devices() {
  const { devices } = Route.useLoaderData()
  const pending = devices.filter((d) => d.status === 'pending')
  const rest = devices.filter((d) => d.status !== 'pending')

  return (
    <main className="mx-auto max-w-2xl px-4 pb-24 pt-6">
      <Link to="/" className="text-sm text-gray-500 hover:text-gray-800 dark:hover:text-gray-200">
        ← Inbox
      </Link>
      <h1 className="mt-4 text-xl font-bold tracking-tight">Devices</h1>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        Phones running the “Record to idj” shortcut. A new phone waits here until you approve
        it; whatever it captured meanwhile is held, then released into your inbox. Approve
        only devices you recognise.
      </p>

      {pending.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold">Waiting for approval</h2>
          <ul className="mt-2 space-y-2">
            {pending.map((d) => (
              <DeviceRow key={d.id} d={d} />
            ))}
          </ul>
        </section>
      )}

      <section className="mt-6">
        <h2 className="text-sm font-semibold">All devices</h2>
        {rest.length === 0 ? (
          <p className="mt-2 text-sm text-gray-400">None yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {rest.map((d) => (
              <DeviceRow key={d.id} d={d} />
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}

function DeviceRow({ d }: { d: Row }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  async function act(action: 'approve' | 'reject' | 'revoke') {
    if (action !== 'approve' && !window.confirm(confirmText(action, d))) return
    setBusy(true)
    try {
      const r = await decideDevice({ data: { id: d.id, action } })
      setNote(
        action === 'approve'
          ? `Approved. ${r.released} capture${r.released === 1 ? '' : 's'} released into your inbox.`
          : action === 'reject'
            ? `Rejected. ${r.dropped} held capture${r.dropped === 1 ? '' : 's'} deleted.`
            : 'Revoked.',
      )
      await router.invalidate()
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-center gap-2">
        <span className="font-medium">{d.name}</span>
        {d.model && <span className="text-xs text-gray-500">{d.model}</span>}
        <span className={`ml-auto rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_STYLE[d.status] ?? ''}`}>
          {d.status}
        </span>
      </div>
      <p className="mt-1 text-xs text-gray-500">
        First seen {relativeTime(d.firstSeenTs)}
        {d.firstIp ? ` from ${d.firstIp}` : ''} · last seen {relativeTime(d.lastSeenTs)}
        {d.pendingCount > 0 && (
          <strong className="text-amber-700 dark:text-amber-400">
            {' '}
            · {d.pendingCount} capture{d.pendingCount === 1 ? '' : 's'} waiting
          </strong>
        )}
      </p>
      <div className="mt-2 flex gap-2">
        {d.status === 'pending' && (
          <>
            <Button onClick={() => act('approve')} disabled={busy} primary>
              Approve
            </Button>
            <Button onClick={() => act('reject')} disabled={busy}>
              Reject
            </Button>
          </>
        )}
        {d.status === 'approved' && (
          <Button onClick={() => act('revoke')} disabled={busy}>
            Revoke
          </Button>
        )}
      </div>
      {note && <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">{note}</p>}
    </li>
  )
}

function confirmText(action: 'reject' | 'revoke', d: Row): string {
  return action === 'reject'
    ? `Reject “${d.name}”? Its ${d.pendingCount} held capture(s) will be deleted, and it won't be able to capture.`
    : `Revoke “${d.name}”? It will stop being able to capture. Past captures stay.`
}

function Button({
  children,
  onClick,
  disabled,
  primary,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  primary?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        primary
          ? 'rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-gray-900'
          : 'rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300'
      }
    >
      {children}
    </button>
  )
}
