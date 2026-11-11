import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AudioRef } from '../db/schema'
import { env } from './env'

/**
 * Voice-capture recordings on disk. A recording is written once, under a name
 * derived from the item id, and never modified: the event log references it and
 * every later transcription reads it again. Write-to-temp-then-rename means a
 * crash mid-write never leaves a truncated file at the real name.
 */

const EXT_BY_MIME: Record<string, string> = {
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/x-caf': 'caf',
}

/** Recognise a recording by its first bytes, for clients that label it vaguely. */
function sniffMime(bytes: Uint8Array): string | null {
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...bytes.subarray(from, to))
  if (bytes.length >= 12 && ascii(4, 8) === 'ftyp') return 'audio/mp4'
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE')
    return 'audio/wav'
  if (bytes.length >= 4 && ascii(0, 4) === 'caff') return 'audio/x-caf'
  if (bytes.length >= 4 && ascii(0, 4) === 'OggS') return 'audio/ogg'
  if (bytes.length >= 4 && ascii(0, 4) === 'fLaC') return 'audio/flac'
  if (bytes.length >= 3 && ascii(0, 3) === 'ID3') return 'audio/mpeg'
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf)
    return 'audio/webm'
  return null
}

/**
 * Settle on a MIME type. The declared one wins if it is a known audio type;
 * otherwise (octet-stream, empty, `audio/*` oddities) trust the file's magic.
 */
export function resolveAudioMime(declared: string | null, bytes: Uint8Array): string | null {
  const d = (declared ?? '').split(';')[0].trim().toLowerCase()
  if (d in EXT_BY_MIME) return d
  return sniffMime(bytes) ?? (d.startsWith('audio/') ? d : null)
}

export async function saveAudio(
  itemId: string,
  bytes: Uint8Array,
  mime: string,
): Promise<AudioRef> {
  const ext = EXT_BY_MIME[mime] ?? 'bin'
  const file = `${itemId}.${ext}`
  await mkdir(env.audioDir, { recursive: true })
  const final = join(env.audioDir, file)
  const tmp = `${final}.part`
  await writeFile(tmp, bytes)
  await rename(tmp, final)
  return {
    file,
    mime,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

export async function readAudio(ref: AudioRef): Promise<Uint8Array<ArrayBuffer>> {
  // `file` is always `<ulid>.<ext>` written by saveAudio; refuse anything else
  // so a tampered row can't read outside the audio dir.
  if (!/^[0-9A-Z]{26}\.[a-z0-9]+$/.test(ref.file)) {
    throw new Error(`refusing odd audio file name: ${ref.file}`)
  }
  return new Uint8Array(await readFile(join(env.audioDir, ref.file)))
}

/**
 * Recordings from a device nobody has approved yet live apart, under
 * `<audio dir>/pending/`, until the device is approved (the recording becomes
 * an item's, via saveAudio) or rejected (deleted).
 */
const PENDING = 'pending'

export async function savePendingAudio(
  pendingId: string,
  bytes: Uint8Array,
  mime: string,
): Promise<AudioRef> {
  const ext = EXT_BY_MIME[mime] ?? 'bin'
  const file = `${pendingId}.${ext}`
  const dir = join(env.audioDir, PENDING)
  await mkdir(dir, { recursive: true })
  const final = join(dir, file)
  await writeFile(`${final}.part`, bytes)
  await rename(`${final}.part`, final)
  return {
    file,
    mime,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

function pendingPath(ref: AudioRef): string {
  if (!/^[0-9A-Z]{26}\.[a-z0-9]+$/.test(ref.file)) {
    throw new Error(`refusing odd audio file name: ${ref.file}`)
  }
  return join(env.audioDir, PENDING, ref.file)
}

export async function readPendingAudio(ref: AudioRef): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await readFile(pendingPath(ref)))
}

export async function deletePendingAudio(ref: AudioRef): Promise<void> {
  await rm(pendingPath(ref), { force: true })
}
