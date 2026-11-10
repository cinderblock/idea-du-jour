/**
 * Transcribe voice captures that never got a transcript — e.g. ones recorded
 * before TRANSCRIBE_URL was set. The server's own sweep does this every few
 * minutes; this is the manual "do it now".
 *
 *   bun run transcribe:pending
 *   docker exec idj bun run transcribe:pending
 */
import { transcribePending } from '../src/server/transcribe'

const n = await transcribePending(100)
console.log(`transcribed ${n} recording(s)`)
