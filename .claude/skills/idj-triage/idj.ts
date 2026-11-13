#!/usr/bin/env bun
/**
 * idj agent API helper, for the idj-triage skill and the T3 dispatcher.
 *
 *   bun idj.ts get <id>              item + history (JSON)
 *   bun idj.ts list [query]          GET /api/items?<query>, e.g. "status=open&limit=50"
 *   bun idj.ts comment <id> [text]   add a comment (text from the args, or stdin)
 *   bun idj.ts done <id>             mark done
 *   bun idj.ts reopen <id>           reopen
 *   bun idj.ts day [YYYY-MM-DD]      captures from one capture-day, with their T3 threads
 *
 * Why a script and not curl: one plain `bun idj.ts ...` command needs no shell
 * variables, quoting or heredocs, so agents in restricted permission modes can
 * run it without an approval prompt each time. It also never prints the token,
 * and doesn't depend on Git Bash's curl (which has failed here with
 * "(43) A libcurl function was given a bad argument").
 *
 * Config: IDJ_BASE_URL / IDJ_AGENT_TOKEN from the environment, else the
 * `.env.local` next to this file, else the one in the main checkout (worktrees
 * don't get the gitignored file).
 *
 * A capture-day runs 4:00 AM to 4:00 AM America/Los_Angeles, so a late-night
 * burst stays with the evening it belongs to.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const TZ = 'America/Los_Angeles'
const DAY_ROLLOVER_HOUR = 4

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

function envFileCandidates(): string[] {
  const here = dirname(Bun.main)
  const files = [join(here, '.env.local')]
  const git = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: here,
    encoding: 'utf8',
  })
  if (git.status === 0 && git.stdout.trim()) {
    const mainRoot = resolve(git.stdout.trim(), '..')
    files.push(join(mainRoot, '.claude', 'skills', 'idj-triage', '.env.local'))
  }
  return files
}

function loadConfig(): { base: string; token: string } {
  let base = process.env.IDJ_BASE_URL
  let token = process.env.IDJ_AGENT_TOKEN
  for (const file of envFileCandidates()) {
    if (base && token) break
    if (!existsSync(file)) continue
    const vars = parseEnvFile(file)
    base ||= vars.IDJ_BASE_URL
    token ||= vars.IDJ_AGENT_TOKEN
  }
  if (!token) {
    die(
      'No IDJ_AGENT_TOKEN. Copy .env.example to .env.local next to idj.ts and add a token ' +
        '(mint one with `bun run token:mint agent "<name>"` in the idj repo).',
    )
  }
  return { base: (base || 'https://idj.isozilla.com').replace(/\/+$/, ''), token: token! }
}

function die(msg: string): never {
  console.error(`idj: ${msg}`)
  process.exit(1)
}

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const { base, token } = loadConfig()
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) die(`${init.method ?? 'GET'} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Offset of `TZ` from UTC at instant `ts`, in ms (negative west of UTC). */
function tzOffset(ts: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(ts))
      .map((p) => [p.type, p.value]),
  )
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second)
  return asUtc - Math.floor(ts / 1000) * 1000
}

/** Epoch ms of a wall-clock time in `TZ`. */
function zonedTime(y: number, m: number, d: number, h: number): number {
  const guess = Date.UTC(y, m - 1, d, h)
  const first = guess - tzOffset(guess)
  return guess - tzOffset(first) // second pass settles DST edges
}

/** The capture-day (YYYY-MM-DD) an instant belongs to. */
export function captureDay(ts: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(
    new Date(ts - DAY_ROLLOVER_HOUR * 3600_000),
  )
}

function dayBounds(day: string): [number, number] {
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) die(`bad day "${day}", want YYYY-MM-DD`)
  const [y, mo, d] = [+m[1], +m[2], +m[3]]
  const next = new Date(Date.UTC(y, mo - 1, d + 1))
  return [
    zonedTime(y, mo, d, DAY_ROLLOVER_HOUR),
    zonedTime(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), DAY_ROLLOVER_HOUR),
  ]
}

function localTime(ts: number): string {
  const local = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(ts))
  return `${local} (${new Date(ts).toISOString().slice(11, 16)}Z)`
}

type Item = { id: string; createdTs: number; status: string; kind: string; firstCapture?: string; body?: string; audio?: unknown }
type Event = { type: string; ts: number; payload?: { text?: string } }

// Project names can hold parentheses: "(LibreHours (time-tracker))".
const THREAD_RE = /T3 thread:\s*<?(t3-thread:\/\/[^\s>]+)>?\s*(?:\((.*)\))?\s*$/m

async function day(dayArg?: string) {
  const d = dayArg ?? captureDay(Date.now())
  const [start, end] = dayBounds(d)
  const { items } = (await api('/api/items?limit=200')) as { items: Item[] }
  const inDay = items.filter((i) => i.createdTs >= start && i.createdTs < end).sort((a, b) => a.createdTs - b.createdTs)
  const out = []
  for (const it of inDay) {
    const { events } = (await api(`/api/items/${it.id}`)) as { events: Event[] }
    const threads = events
      .filter((e) => e.type === 'item.commented')
      .map((e) => e.payload?.text?.match(THREAD_RE))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      .map((m) => ({ link: m[1], threadId: m[1].split('/').pop()!, project: m[2] ?? null }))
      .reverse() // newest first: a later link supersedes an earlier one
    out.push({
      id: it.id,
      local: localTime(it.createdTs),
      status: it.status,
      voice: Boolean(it.audio),
      text: it.firstCapture || it.body || '',
      threads,
    })
  }
  console.log(JSON.stringify({ day: d, items: out }, null, 2))
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  return (await Bun.stdin.text()).trim()
}

const [cmd, ...args] = process.argv.slice(2)
const need = (i: number, what: string) => args[i] ?? die(`${cmd}: missing ${what}`)

switch (cmd) {
  case 'get':
    console.log(JSON.stringify(await api(`/api/items/${need(0, '<id>')}`), null, 2))
    break
  case 'list':
    console.log(JSON.stringify(await api(`/api/items${args[0] ? `?${args[0]}` : ''}`), null, 2))
    break
  case 'comment': {
    const id = need(0, '<id>')
    const text = args.slice(1).join(' ').trim() || (await readStdin())
    if (!text) die('comment: no text (pass it as arguments or on stdin)')
    console.log(
      JSON.stringify(
        await api(`/api/items/${id}/comment`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: text,
        }),
      ),
    )
    break
  }
  case 'done':
  case 'reopen':
    console.log(JSON.stringify(await api(`/api/items/${need(0, '<id>')}/${cmd}`, { method: 'POST' })))
    break
  case 'day':
    await day(args[0])
    break
  default:
    die('usage: bun idj.ts get <id> | list [query] | comment <id> [text] | done <id> | reopen <id> | day [YYYY-MM-DD]')
}
