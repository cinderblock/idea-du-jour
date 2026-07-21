import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold">idea-du-jour</h1>
      <p className="mt-3 text-gray-600 dark:text-gray-300">
        Personal capture &amp; triage. Hold the Action button, dictate, and it lands here.
      </p>
      <p className="mt-6 text-sm text-gray-500">
        Capture endpoint: <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">POST /api/capture</code>.
        Triage UI coming next.
      </p>
    </main>
  )
}
