import { useState } from 'react'
import {
  Link,
  createFileRoute,
  isRedirect,
  redirect,
  useRouter,
} from '@tanstack/react-router'
import {
  createToken,
  fetchTokens,
  getAuth,
  revokeTokenFn,
} from '../server/webapi'
import { wasAuthed } from '../ui/offline'
import { relativeTime } from '../ui/util'

export const Route = createFileRoute('/setup')({
  beforeLoad: async () => {
    try {
      const { userId } = await getAuth()
      if (!userId) throw redirect({ to: '/login' })
    } catch (e) {
      if (isRedirect(e)) throw e
      if (!wasAuthed()) throw redirect({ to: '/login' })
    }
  },
  loader: () => fetchTokens().catch(() => ({ tokens: [] })),
  component: Setup,
})

function Copyable({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
        } catch {
          return
        }
        setCopied(true)
        setTimeout(() => setCopied(false), 1800)
      }}
      className="w-full rounded-md border border-gray-200 bg-gray-50 p-2 text-left transition hover:border-gray-300 dark:border-gray-800 dark:bg-gray-950"
    >
      <span className="block text-xs text-gray-500">
        {copied ? '✓ copied' : `${label} — tap to copy`}
      </span>
      <code className="block break-all text-xs text-gray-800 dark:text-gray-200">
        {value}
      </code>
    </button>
  )
}

function Setup() {
  const { tokens } = Route.useLoaderData()
  const router = useRouter()
  const [fresh, setFresh] = useState<{ secret: string; label: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function mint(scope: 'capture' | 'agent', label: string) {
    setBusy(true)
    try {
      const t = await createToken({ data: { scope, label } })
      setFresh({ secret: t.secret, label: t.label })
      await router.invalidate()
    } finally {
      setBusy(false)
    }
  }

  const base =
    typeof window !== 'undefined' ? window.location.origin : 'https://idj.isozilla.com'

  return (
    <main className="mx-auto max-w-2xl px-4 pb-24 pt-6">
      <Link to="/" className="text-sm text-gray-500 hover:text-gray-800 dark:hover:text-gray-200">
        ← Inbox
      </Link>
      <h1 className="mt-3 text-2xl font-bold tracking-tight">Setup</h1>

      {/* 1. install */}
      <section className="mt-6">
        <h2 className="text-sm font-semibold">1. Install the app</h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          In Safari: <strong>Share → Add to Home Screen</strong>. The installed app runs
          fullscreen and keeps working offline — captures queue on the device and sync when
          you reconnect. You&rsquo;ll sign in with your passkey once inside it (installed apps
          get their own storage).
        </p>
      </section>

      {/* 2. shortcut */}
      <section className="mt-6">
        <h2 className="text-sm font-semibold">2. Voice memos (Action button)</h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Fastest path — tap to install the ready-made shortcut, then paste a capture token
          when it asks:
        </p>
        <a
          href="/shortcut"
          className="mt-2 inline-block rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-gray-900"
        >
          Get the “Memo to idj” shortcut
        </a>
        <details className="mt-3 text-sm text-gray-600 dark:text-gray-400">
          <summary className="cursor-pointer">…or build it by hand</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>
              Shortcuts → <strong>+</strong> → add <strong>Dictate Text</strong>
            </li>
            <li>
              Add <strong>Get Contents of URL</strong>, expand it, and set:
              <ul className="mt-1 list-disc space-y-1 pl-5">
                <li>
                  URL: <code className="text-xs">{base}/api/capture</code>
                </li>
                <li>
                  Method: <strong>POST</strong>
                </li>
                <li>
                  Headers: <code className="text-xs">Authorization</code> ={' '}
                  <code className="text-xs">Bearer &lt;token&gt;</code>
                </li>
                <li>
                  Request Body: <strong>JSON</strong>, one text field with key{' '}
                  <code className="text-xs">text</code>, value = the{' '}
                  <strong>Dictated Text</strong> variable
                </li>
              </ul>
            </li>
            <li>
              Name it, then <strong>Settings → Action Button → Shortcut</strong>
            </li>
          </ol>
        </details>
      </section>

      {/* 3. tokens */}
      <section className="mt-6">
        <h2 className="text-sm font-semibold">3. Tokens</h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          <strong>capture</strong> = write-only (safe for shortcuts — it can only add).{' '}
          <strong>agent</strong> = read + comment (for Claude).
        </p>

        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => mint('capture', 'shortcut')}
            className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-gray-900"
          >
            New capture token
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => mint('agent', 'claude')}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium disabled:opacity-40 dark:border-gray-700"
          >
            New agent token
          </button>
        </div>

        {fresh && (
          <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
            <p className="mb-2 text-xs font-medium text-amber-900 dark:text-amber-300">
              Copy this now — it is never shown again.
            </p>
            <Copyable value={fresh.secret} label={fresh.label} />
          </div>
        )}

        <ul className="mt-4 space-y-1">
          {tokens.map((t) => (
            <li
              key={t.id}
              className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm dark:border-gray-800"
            >
              <span className="font-medium">{t.label}</span>
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                {t.scope}
              </span>
              {t.revokedTs ? (
                <span className="text-xs text-red-600">revoked</span>
              ) : (
                <span className="text-xs text-gray-400">
                  {t.lastUsedTs ? `used ${relativeTime(t.lastUsedTs)}` : 'never used'}
                </span>
              )}
              {!t.revokedTs && (
                <button
                  type="button"
                  onClick={async () => {
                    await revokeTokenFn({ data: { id: t.id } })
                    await router.invalidate()
                  }}
                  className="ml-auto text-xs text-gray-400 hover:text-red-600"
                >
                  revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
