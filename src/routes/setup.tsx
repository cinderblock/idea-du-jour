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
        <h2 className="text-sm font-semibold">2. Record to idj (Action button)</h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          One shortcut for everything: it records, and if you tap stop within two seconds
          it asks you to type instead. Recordings are saved to iCloud Drive (Shortcuts/idj)
          before uploading, and transcribed on the server.
        </p>

        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-gray-600 dark:text-gray-400">
          <li>
            Mint a <strong>capture</strong> token in step 3 below and tap{' '}
            <strong>Header value</strong> to copy it.
          </li>
          <li>
            On your iPhone, tap{' '}
            <a
              href="/shortcut"
              className="font-medium text-blue-600 underline dark:text-blue-400"
            >
              Install “Record to idj”
            </a>{' '}
            → <strong>Add Shortcut</strong>, and paste the header value when it asks.
          </li>
          <li>
            <strong>Settings → Action Button → Shortcut → Record to idj</strong>. (Not “Hey
            Siri”: recording freezes when a shortcut is started by voice.)
          </li>
        </ol>
        <p className="mt-2 text-xs text-gray-500">
          Re-install the same way to pick up updates or a new token. If it ever says “The
          network connection was lost”, look for an empty header row in its Get Contents of
          URL action.
        </p>
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
          <div className="mt-3 space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
            <p className="text-xs font-medium text-amber-900 dark:text-amber-300">
              Copy now — never shown again.
            </p>
            {/* The complete header value, Bearer prefix included, so there is
                nothing to assemble by hand. */}
            <Copyable
              value={`Bearer ${fresh.secret}`}
              label="Header value (paste whole)"
            />
            <details className="text-xs text-amber-900 dark:text-amber-300">
              <summary className="cursor-pointer">raw token (rarely needed)</summary>
              <div className="mt-2">
                <Copyable value={fresh.secret} label={fresh.label} />
              </div>
            </details>
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
