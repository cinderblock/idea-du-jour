import { definePlugin } from 'nitro'
import { startTranscribeSweep } from '../transcribe'

/**
 * Background workers that live as long as the server does. Registered in
 * vite.config.ts (`nitro({ plugins })`).
 *
 * The transcription sweep retries voice captures that never got a transcript:
 * the Whisper server was down, or not configured yet when they arrived.
 */
export default definePlugin(() => {
  startTranscribeSweep()
})
