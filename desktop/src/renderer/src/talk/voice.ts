/** Talk to Orcha (GH-409): the microphone and the speaker for the master chat.
 *
 *  - Listener: the microphone stays open while voice is on and WAITS for the owner — however
 *    long. An utterance starts when they speak and ends after a natural pause (PAUSE_MS of
 *    quiet), or when they tap the orb; it can run for minutes. Frames are ignored while Orcha
 *    speaks (no hearing itself) — tap the orb to interrupt. Audio is 16 kHz mono WAV.
 *  - Speaker: a reply is rendered sentence by sentence (the first plays while the next renders)
 *    and stops at once on interrupt.
 *  - voiceLevel: live loudness 0..1 for the orb (mic while listening, voice while speaking). */
import { Resampler, encodeWav, floatToPcm16, levelFromRms, rms, startCapture, type Capture } from '../dictation/audio'

export const voiceLevel = { value: 0 }

export const RATE = 16000
/** quiet after speech that ends the owner's turn (long enough to think mid-sentence) */
export const PAUSE_MS = 1700
export const MAX_UTTERANCE_MS = 5 * 60_000
const SPEECH_RMS = 0.018
/** loud frames needed before it counts as speech (a click or a cough isn't) */
const START_MS = 140
/** audio kept from just before speech started, so the first syllable isn't cut */
const PREROLL_MS = 350

export function splitSentences(text: string, minChars = 24): string[] {
  const parts = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=\S)/)
  const out: string[] = []
  for (const p of parts) {
    if (!p) continue
    if (out.length && (out[out.length - 1].length < minChars || p.length < minChars / 2)) out[out.length - 1] += ' ' + p
    else out.push(p)
  }
  return out
}

/** The voice-activity rule, pure (talk/voice.test.ts): feed frame loudness + time, get events. */
export class Vad {
  private loudSince: number | null = null
  private quietSince: number | null = null
  speaking = false
  private startedAt = 0

  /** → 'start' when speech begins, 'end' when it has ended, else null */
  push(loud: boolean, t: number): 'start' | 'end' | null {
    if (!this.speaking) {
      if (!loud) {
        this.loudSince = null
        return null
      }
      this.loudSince ??= t
      if (t - this.loudSince < START_MS) return null
      this.speaking = true
      this.startedAt = t
      this.quietSince = null
      return 'start'
    }
    if (loud) this.quietSince = null
    else this.quietSince ??= t
    if ((this.quietSince !== null && t - this.quietSince >= PAUSE_MS) || t - this.startedAt >= MAX_UTTERANCE_MS) {
      this.reset()
      return 'end'
    }
    return null
  }

  reset(): void {
    this.speaking = false
    this.loudSince = null
    this.quietSince = null
  }
}

export interface ListenerEvents {
  /** the owner started talking */
  onSpeechStart(): void
  /** a finished utterance (16 kHz WAV) */
  onUtterance(wav: Blob): void
}

export class Listener {
  private cap: Capture | null = null
  private resampler: Resampler | null = null
  private vad = new Vad()
  private pre: Int16Array[] = []
  private chunks: Int16Array[] = []
  private muted = false
  private opening: Promise<void> | null = null
  /** push-to-talk: everything is recorded while held, released = the utterance */
  private held = false
  /** hands-free: an utterance starts and ends by itself (off = push-to-talk only) */
  private auto = true

  constructor(private readonly ev: ListenerEvents) {}

  get open(): boolean {
    return this.cap !== null
  }

  /** Open the microphone once (macOS asks the first time). */
  start(): Promise<void> {
    if (this.cap) return Promise.resolve()
    this.opening ??= (async () => {
      try {
        const cap = await startCapture({
          onLevel: (l) => {
            if (!this.muted) voiceLevel.value = l
          },
          onFrame: (frame) => this.frame(frame)
        })
        this.resampler = new Resampler(cap.sampleRate, RATE)
        this.cap = cap
      } finally {
        this.opening = null
      }
    })()
    return this.opening
  }

  stop(): void {
    this.cap?.stop()
    this.cap = null
    this.resampler = null
    this.discard()
    voiceLevel.value = 0
  }

  /** Ignore the microphone (while Orcha speaks); unmuting starts fresh. */
  mute(on: boolean): void {
    this.muted = on
    if (on) this.discard()
  }

  /** End the current utterance now (tap the orb while talking). */
  finish(): void {
    if (this.vad.speaking) this.emit()
  }

  /** Hands-free listening on or off (off: only push-to-talk records). */
  setAuto(on: boolean): void {
    this.auto = on
    if (!on && !this.held) this.discard()
  }

  /** Push-to-talk: press starts an utterance at once (with the preroll), release ends it. */
  hold(on: boolean): void {
    if (on === this.held) return
    this.held = on
    if (on) {
      this.muted = false
      this.vad.reset()
      this.chunks = [...this.pre]
      this.pre = []
      this.ev.onSpeechStart()
    } else this.emit()
  }

  get hearing(): boolean {
    return this.held || this.vad.speaking
  }

  private discard(): void {
    this.vad.reset()
    this.pre = []
    this.chunks = []
  }

  private frame(frame: Float32Array): void {
    if ((this.muted && !this.held) || !this.resampler) return
    const pcm = floatToPcm16(this.resampler.push(frame))
    if (this.held) {
      this.chunks.push(pcm)
      return
    }
    const ev = this.auto ? this.vad.push(rms(frame) > SPEECH_RMS, performance.now()) : null
    if (!this.vad.speaking && ev !== 'end') {
      this.pre.push(pcm)
      let n = this.pre.reduce((s, c) => s + c.length, 0)
      while (this.pre.length > 1 && n - this.pre[0].length > (RATE * PREROLL_MS) / 1000) n -= this.pre.shift()!.length
      return
    }
    if (ev === 'start') {
      this.chunks = [...this.pre, pcm]
      this.pre = []
      this.ev.onSpeechStart()
      return
    }
    this.chunks.push(pcm)
    if (ev === 'end') this.emit()
  }

  private emit(): void {
    const total = this.chunks.reduce((n, c) => n + c.length, 0)
    const pcm = new Int16Array(total)
    let o = 0
    for (const c of this.chunks) {
      pcm.set(c, o)
      o += c.length
    }
    this.discard()
    if (total > RATE / 4) this.ev.onUtterance(encodeWav(pcm, RATE))
  }
}

export class Speaker {
  private abort: AbortController | null = null
  private audio: HTMLAudioElement | null = null
  private finish: (() => void) | null = null
  private ctx: AudioContext | null = null

  constructor(private readonly render: (sentence: string) => Promise<ArrayBuffer>) {}

  stop(): void {
    this.abort?.abort()
    this.abort = null
    if (this.audio) {
      this.audio.pause()
      this.audio.src = ''
      this.audio = null
    }
    const f = this.finish
    this.finish = null
    f?.()
  }

  /** Resolves when everything was spoken, or as soon as `stop()` is called. */
  async speak(text: string): Promise<void> {
    this.stop()
    const sentences = splitSentences(text.replace(/^- /gm, ''))
    if (!sentences.length) return
    const ctl = new AbortController()
    this.abort = ctl
    const fetchOne = (s: string): Promise<ArrayBuffer> => this.render(s)
    let next: Promise<ArrayBuffer> | null = fetchOne(sentences[0])
    for (let i = 0; i < sentences.length; i++) {
      if (ctl.signal.aborted || !next) return
      let buf: ArrayBuffer
      try {
        buf = await next
      } catch {
        return // speech failed: the text is on screen anyway
      }
      next = i + 1 < sentences.length ? fetchOne(sentences[i + 1]) : null
      next?.catch(() => undefined)
      if (ctl.signal.aborted) return
      await this.play(new Blob([buf], { type: 'audio/wav' }), ctl.signal)
    }
    if (this.abort === ctl) this.abort = null
  }

  private play(blob: Blob, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve()
      const url = URL.createObjectURL(blob)
      const a = new Audio(url)
      this.audio = a
      const unmeter = this.meter(a)
      const done = (): void => {
        unmeter()
        URL.revokeObjectURL(url)
        if (this.audio === a) this.audio = null
        if (this.finish === done) this.finish = null
        resolve()
      }
      this.finish = done
      a.onended = done
      a.onerror = done
      a.play().catch(done)
    })
  }

  /** Meter what plays, for the orb (only through a running AudioContext). */
  private meter(a: HTMLAudioElement): () => void {
    try {
      this.ctx ??= new AudioContext()
      if (this.ctx.state !== 'running') {
        void this.ctx.resume().catch(() => undefined)
        return () => undefined
      }
      const ctx = this.ctx
      const src = ctx.createMediaElementSource(a)
      const an = ctx.createAnalyser()
      an.fftSize = 512
      src.connect(an)
      an.connect(ctx.destination)
      const buf = new Float32Array(an.fftSize)
      let raf = 0
      const tick = (): void => {
        an.getFloatTimeDomainData(buf)
        voiceLevel.value = levelFromRms(rms(buf))
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
      return () => {
        cancelAnimationFrame(raf)
        voiceLevel.value = 0
        try {
          src.disconnect()
          an.disconnect()
        } catch {
          /* already gone */
        }
      }
    } catch {
      return () => undefined
    }
  }
}
