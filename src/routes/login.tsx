import { useEffect, useState } from 'react'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { getAuth } from '../server/webapi'

export const Route = createFileRoute('/login')({
  beforeLoad: async () => {
    const { userId } = await getAuth()
    if (userId) throw redirect({ to: '/' })
  },
  component: Login,
})

async function postJson(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return { ok: res.ok, data: await res.json().catch(() => ({})) }
}

function Login() {
  const navigate = useNavigate()
  const [hasUser, setHasUser] = useState<boolean | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((d) => setHasUser(!!d.hasUser))
      .catch(() => setHasUser(false))
  }, [])

  async function signIn() {
    setError(null)
    setPending(true)
    try {
      const opts = await postJson('/api/auth/login/options')
      const assertion = await startAuthentication({ optionsJSON: opts.data })
      const v = await postJson('/api/auth/login/verify', assertion)
      if (v.ok && v.data.verified) navigate({ to: '/' })
      else setError('Sign-in failed. Try again.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in cancelled.')
    } finally {
      setPending(false)
    }
  }

  async function createPasskey() {
    setError(null)
    setPending(true)
    try {
      const opts = await postJson('/api/auth/register/options', {})
      if (!opts.ok) {
        setError(opts.data.error ?? 'Registration is closed.')
        return
      }
      const attestation = await startRegistration({ optionsJSON: opts.data })
      const v = await postJson('/api/auth/register/verify', attestation)
      if (v.ok && v.data.verified) navigate({ to: '/' })
      else setError('Could not create passkey.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Registration cancelled.')
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="text-2xl font-bold tracking-tight">idea-du-jour</h1>
      <p className="mt-1 text-sm text-gray-500">
        {hasUser === false
          ? 'First run — create a passkey to claim this inbox.'
          : 'Unlock with your passkey.'}
      </p>

      <div className="mt-6 space-y-3">
        {hasUser !== false && (
          <button
            type="button"
            onClick={signIn}
            disabled={pending}
            className="w-full rounded-md bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition disabled:opacity-40 dark:bg-white dark:text-gray-900"
          >
            {pending ? '…' : 'Sign in with passkey'}
          </button>
        )}
        {hasUser === false && (
          <button
            type="button"
            onClick={createPasskey}
            disabled={pending}
            className="w-full rounded-md bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition disabled:opacity-40 dark:bg-white dark:text-gray-900"
          >
            {pending ? '…' : 'Create a passkey'}
          </button>
        )}
      </div>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
    </main>
  )
}
