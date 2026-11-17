import { createHash } from 'node:crypto'
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '../db/client'
import { deviceChanges, devices, pendingCaptures, settings, type Device } from '../db/schema'
import { deletePendingAudio, readPendingAudio, savePendingAudio } from './audio'
import { enqueueEnrichment } from './enrich'
import { captureAudioItem, captureItem, markDispatched } from './events'
import { enqueueTranscription } from './transcribe'
import { notifyTranscriptionQueued } from './transcribeQueue'

/**
 * Device pairing: capture without a token.
 *
 * The shortcut makes a long random device ID on first run and sends it with
 * every capture (`X-Idj-Device-Id`, plus name and model). Only its SHA-256 is
 * stored. An unknown ID is not refused: it becomes a pending device, and its
 * captures wait in `pending_captures` until someone signed in approves the
 * device (they are released into the inbox as ordinary events, with their
 * original timestamps) or rejects it (they are deleted).
 *
 * The signed shortcut is public, so anyone can make a device ID. Limits below
 * keep a stranger to filling the pending list, never the inbox.
 */

export const LIMITS = {
  pendingCapturesPerDevice: 20,
  pendingAudioBytesPerDevice: 25 * 1024 * 1024,
  pendingDevices: 20,
  /** Requests a minute, per IP, from devices that aren't approved. */
  unapprovedPerIpPerMinute: 30,
}

export type DeviceInfo = { deviceId: string; name: string; model: string | null }

export class DeviceError extends Error {
  constructor(
    public status: 400 | 403 | 429,
    message: string,
  ) {
    super(message)
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

function decodeHeader(v: string | null, max: number): string | null {
  if (!v) return null
  let out = v
  try {
    out = decodeURIComponent(v.replace(/\+/g, ' '))
  } catch {}
  out = out.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return out ? out.slice(0, max) : null
}

/** The device headers, or null when the request doesn't use device auth. */
export function parseDeviceHeaders(request: Request): DeviceInfo | null {
  const raw = request.headers.get('x-idj-device-id')
  if (raw === null) return null
  const deviceId = raw.trim()
  // Long and random; the shortcut sends 64 hex chars. Shorter is guessable.
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(deviceId)) {
    throw new DeviceError(400, 'device id must be 32-128 letters, digits, - or _')
  }
  const model = decodeHeader(request.headers.get('x-idj-device-model'), 40)
  return {
    deviceId,
    name: decodeHeader(request.headers.get('x-idj-device-name'), 80) ?? model ?? 'Unnamed device',
    model,
  }
}

/** The caller's IP as Cloudflare and Caddy pass it along. */
export function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-real-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  )
}

/**
 * New-device registration. Open until the first device is approved (so a
 * fresh install can pair), then closed: an unknown device ID gets 403 and
 * nothing is held. Signed in, you can open it for a short window to add a
 * device. A new phone on the same Apple ID doesn't need this: the device ID is
 * in iCloud Drive, so it is already the approved device.
 */
const REGISTRATION_KEY = 'deviceRegistrationOpenUntil'
export const REGISTRATION_WINDOW_MS = 30 * 60 * 1000

export async function registrationStatus(): Promise<{
  open: boolean
  /** Why: no device approved yet, or an open window until this time. */
  reason: 'no-approved-device' | 'window' | 'closed'
  openUntil: number | null
}> {
  const [{ approved }] = await db
    .select({ approved: count() })
    .from(devices)
    .where(eq(devices.status, 'approved'))
  const [row] = await db.select().from(settings).where(eq(settings.key, REGISTRATION_KEY)).limit(1)
  const until = typeof row?.value === 'number' ? row.value : null
  const openUntil = until && until > Date.now() ? until : null
  if (openUntil) return { open: true, reason: 'window', openUntil }
  if (approved === 0) return { open: true, reason: 'no-approved-device', openUntil: null }
  return { open: false, reason: 'closed', openUntil: null }
}

/** Open registration for a while (`open`), or close it now. */
export async function setRegistration(open: boolean): Promise<void> {
  const now = Date.now()
  const value = open ? now + REGISTRATION_WINDOW_MS : 0
  await db
    .insert(settings)
    .values({ key: REGISTRATION_KEY, value, updatedTs: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedTs: now } })
}

// Per-IP limiter for unapproved devices. In memory: one server process, and a
// restart only resets the window.
const hits = new Map<string, number[]>()
function rateLimit(ip: string): void {
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => t > now - 60_000)
  if (recent.length >= LIMITS.unapprovedPerIpPerMinute) {
    throw new DeviceError(429, 'too many captures from unapproved devices; try again in a minute')
  }
  recent.push(now)
  hits.set(ip, recent)
  if (hits.size > 10_000) hits.clear() // never grows without bound
}

/**
 * Look up the device for this request, creating a pending one for a new ID.
 * Refreshes last-seen, name and model. Throws 403 for rejected or revoked
 * devices, 429 when unapproved traffic is over its limits.
 */
export async function resolveDevice(info: DeviceInfo, ip: string): Promise<Device> {
  const idHash = sha256(info.deviceId)
  const now = Date.now()
  const [found] = await db.select().from(devices).where(eq(devices.idHash, idHash)).limit(1)

  if (found) {
    if (found.status === 'rejected' || found.status === 'revoked') {
      throw new DeviceError(403, `this device was ${found.status}; re-pair it from idj`)
    }
    if (found.status !== 'approved') rateLimit(ip)
    const changes = (
      [
        ['name', found.name, info.name],
        ['model', found.model, info.model],
      ] as const
    )
      .filter(([, from, to]) => from !== to)
      .map(([field, fromValue, toValue]) => ({
        id: ulid(),
        deviceId: found.id,
        ts: now,
        field,
        fromValue,
        toValue,
        ip,
      }))
    if (changes.length) await db.insert(deviceChanges).values(changes)
    await db
      .update(devices)
      .set({ lastSeenTs: now, name: info.name, model: info.model })
      .where(eq(devices.id, found.id))
    return { ...found, lastSeenTs: now, name: info.name, model: info.model }
  }

  if (!(await registrationStatus()).open) {
    throw new DeviceError(403, 'idj is not accepting new devices; allow one on the devices page first')
  }
  rateLimit(ip)
  const [{ n }] = await db
    .select({ n: count() })
    .from(devices)
    .where(eq(devices.status, 'pending'))
  if (n >= LIMITS.pendingDevices) {
    throw new DeviceError(429, 'too many devices are waiting for approval')
  }
  const row = {
    id: ulid(),
    idHash,
    name: info.name,
    model: info.model,
    status: 'pending',
    firstSeenTs: now,
    lastSeenTs: now,
    decidedTs: null,
    firstIp: ip,
  }
  await db.insert(devices).values(row)
  return row
}

async function pendingUsage(deviceId: string) {
  const rows = await db
    .select({ audio: pendingCaptures.audio })
    .from(pendingCaptures)
    .where(eq(pendingCaptures.deviceId, deviceId))
  const bytes = rows.reduce((sum, r) => sum + (r.audio?.bytes ?? 0), 0)
  return { count: rows.length, bytes }
}

/**
 * Hold a capture from an unapproved device. Returns the pending capture's id
 * and how many of this device's captures are now waiting, this one included.
 */
export async function holdCapture(
  device: Device,
  capture: { text: string } | { audio: Uint8Array; mime: string },
): Promise<{ id: string; waiting: number }> {
  const usage = await pendingUsage(device.id)
  if (usage.count >= LIMITS.pendingCapturesPerDevice) {
    throw new DeviceError(429, 'this device has too many captures waiting for approval')
  }
  const id = ulid()
  const waiting = usage.count + 1
  if ('text' in capture) {
    await db.insert(pendingCaptures).values({ id, deviceId: device.id, ts: Date.now(), text: capture.text })
    return { id, waiting }
  }
  if (usage.bytes + capture.audio.byteLength > LIMITS.pendingAudioBytesPerDevice) {
    throw new DeviceError(429, 'this device has too much audio waiting for approval')
  }
  const audio = await savePendingAudio(id, capture.audio, capture.mime)
  await db.insert(pendingCaptures).values({ id, deviceId: device.id, ts: Date.now(), audio })
  return { id, waiting }
}

/** The actor recorded on events from a device. */
export const deviceActor = (d: Device) => `device:${d.name}`

/** Devices for the management page, newest activity first, with waiting counts. */
export async function listDevices() {
  const rows = await db.select().from(devices).orderBy(desc(devices.lastSeenTs))
  const counts = await db
    .select({ deviceId: pendingCaptures.deviceId, n: count() })
    .from(pendingCaptures)
    .groupBy(pendingCaptures.deviceId)
  const byDevice = new Map(counts.map((c) => [c.deviceId, c.n]))
  const history = await db.select().from(deviceChanges).orderBy(desc(deviceChanges.ts))
  const changesBy = new Map<string, typeof history>()
  for (const c of history) {
    const list = changesBy.get(c.deviceId) ?? []
    list.push(c)
    changesBy.set(c.deviceId, list)
  }
  return rows.map(({ idHash: _h, ...d }) => ({
    ...d,
    pendingCount: byDevice.get(d.id) ?? 0,
    /** Name and model changes, newest first. */
    changes: changesBy.get(d.id) ?? [],
  }))
}

/** For the inbox banner: devices waiting, and captures held for them. */
export async function waitingSummary() {
  const [{ devicesWaiting }] = await db
    .select({ devicesWaiting: count() })
    .from(devices)
    .where(eq(devices.status, 'pending'))
  const [{ captures }] = await db
    .select({ captures: count() })
    .from(pendingCaptures)
    .innerJoin(devices, eq(devices.id, pendingCaptures.deviceId))
    .where(eq(devices.status, 'pending'))
  return { devicesWaiting, captures }
}

async function requireDevice(id: string): Promise<Device> {
  const [d] = await db.select().from(devices).where(eq(devices.id, id)).limit(1)
  if (!d) throw new Error('no such device')
  return d
}

async function heldFor(deviceId: string) {
  return db
    .select()
    .from(pendingCaptures)
    .where(eq(pendingCaptures.deviceId, deviceId))
    .orderBy(asc(pendingCaptures.ts))
}

/**
 * Approve a device and release everything it captured while waiting into the
 * inbox, oldest first, with the original capture times. Each becomes a normal
 * `item.created` event, so a projection rebuild replays it like any other.
 *
 * Released captures are never dispatched to agents: they were sent before
 * anyone vouched for the device, and a pile of them more likely means a
 * misconfiguration or a stranger than a backlog. They are marked dispatched
 * (target `held`) before transcription can trigger a dispatch.
 */
export async function approveDevice(id: string): Promise<{ released: number }> {
  const device = await requireDevice(id)
  await db
    .update(devices)
    .set({ status: 'approved', decidedTs: Date.now() })
    .where(eq(devices.id, id))
  const approved = { ...device, status: 'approved' }

  let released = 0
  for (const p of await heldFor(id)) {
    if (p.audio) {
      const bytes = await readPendingAudio(p.audio)
      const itemId = await captureAudioItem({
        audio: bytes,
        mime: p.audio.mime,
        actor: deviceActor(approved),
        ts: p.ts,
      })
      await markDispatched({ itemId, target: 'held' })
      enqueueTranscription(itemId)
      notifyTranscriptionQueued()
      await deletePendingAudio(p.audio)
    } else if (p.text) {
      const itemId = await captureItem({ text: p.text, actor: deviceActor(approved), ts: p.ts })
      await markDispatched({ itemId, target: 'held' })
      enqueueEnrichment(itemId)
    }
    await db.delete(pendingCaptures).where(eq(pendingCaptures.id, p.id))
    released++
  }
  return { released }
}

/** Refuse a device and drop whatever it was holding. */
export async function rejectDevice(id: string): Promise<{ dropped: number }> {
  await requireDevice(id)
  await db
    .update(devices)
    .set({ status: 'rejected', decidedTs: Date.now() })
    .where(eq(devices.id, id))
  const held = await heldFor(id)
  for (const p of held) if (p.audio) await deletePendingAudio(p.audio)
  if (held.length) {
    await db.delete(pendingCaptures).where(
      inArray(
        pendingCaptures.id,
        held.map((p) => p.id),
      ),
    )
  }
  return { dropped: held.length }
}

/** Stop an approved device. Its past captures stay; new ones get 403. */
export async function revokeDevice(id: string): Promise<void> {
  const d = await requireDevice(id)
  if (d.status !== 'approved') throw new Error('only an approved device can be revoked')
  await db
    .update(devices)
    .set({ status: 'revoked', decidedTs: Date.now() })
    .where(and(eq(devices.id, id), eq(devices.status, 'approved')))
}

