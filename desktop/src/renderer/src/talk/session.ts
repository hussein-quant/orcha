/** Talk to Orcha (GH-409): the master chat's client state — the conversations, the turn in
 *  flight and voice mode. One instance for the app (it outlives the Talk view, so a spoken
 *  conversation keeps going while the owner opens a task it linked to).
 *
 *  Voice mode is a loop that WAITS for the owner: listen (however long they take) → transcribe
 *  → Orcha thinks → Orcha speaks (the mic ignores it) → listen again. Silence never ends it;
 *  "End voice" (or the hotkey while idle) does. Talking while Orcha thinks is queued and sent
 *  with the next turn. A confirmed action waits `undoSeconds` ("cancel" / Undo stops it), then
 *  runs, then Orcha follows up with what's next.
 *
 *  Typed and spoken turns share one transcript; everything said is also shown as text. */
import type {
  TalkApi,
  TalkConversation,
  TalkLink,
  TalkMention,
  TalkProjectOption,
  TalkReply,
  TalkPeekTarget,
  TalkSearchHit,
  TalkSpeechStatus,
  TalkSummary
} from '../../../shared/talk'
import { readTalkPrefs, type TalkPrefs } from './prefs'
import { Listener, Speaker } from './voice'

export type TalkPhase = 'idle' | 'listening' | 'hearing' | 'transcribing' | 'thinking' | 'speaking' | 'undo' | 'acting'

export interface TalkState {
  list: TalkSummary[]
  conv: TalkConversation | null
  projects: TalkProjectOption[]
  phase: TalkPhase
  voice: boolean
  /** voice on and the mic listens by itself (off = push-to-talk with Space) */
  handsFree: boolean
  speech: TalkSpeechStatus | null
  /** voice needs a one-time setup: asking, installing (with the latest output line) or failed */
  install: { step: 'ask' } | { step: 'running'; line: string } | { step: 'failed'; error: string } | null
  undoUntil: number | null
  error: string | null
}

const CANCEL = /^(?:cancel|undo|stop|no|wait|hold on|don'?t|never ?mind)\b/i

function msg(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}

export interface SessionDeps {
  api: TalkApi
  prefs(): TalkPrefs
  listener(ev: { onSpeechStart(): void; onUtterance(wav: Blob): void }): Pick<
    Listener,
    'start' | 'stop' | 'mute' | 'finish' | 'hearing' | 'hold' | 'setAuto'
  >
  speaker(render: (s: string) => Promise<ArrayBuffer>): Pick<Speaker, 'speak' | 'stop'>
  /** the scope a new chat gets (all projects, or the one on screen) */
  defaultScope(): string | null
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(t: unknown): void
  now(): number
}

export class TalkSession {
  private state: TalkState = { list: [], conv: null, projects: [], phase: 'idle', voice: false, handsFree: false, speech: null, install: null, undoUntil: null, error: null }
  private subs = new Set<() => void>()
  private listener
  private speaker
  private queue: string[] = []
  private undoTimer: unknown = null
  private busy = false
  /** how voice should start once a setup the owner agreed to finishes */
  private wantHandsFree = true
  /** opens a project / task on screen (set by the view) */
  private opener: ((link: TalkLink) => void) | null = null

  constructor(private readonly d: SessionDeps) {
    this.listener = d.listener({
      onSpeechStart: () => {
        if (this.state.phase === 'listening') this.set({ phase: 'hearing' })
      },
      onUtterance: (wav) => void this.heard(wav)
    })
    this.speaker = d.speaker((s) => {
      const p = this.d.prefs()
      return this.d.api.speak(s, p.voice, p.rate)
    })
  }

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }
  getState = (): TalkState => this.state
  setOpener(fn: ((link: TalkLink) => void) | null): void {
    this.opener = fn
  }

  private set(patch: Partial<TalkState>): void {
    this.state = { ...this.state, ...patch }
    for (const s of this.subs) s()
  }

  // ------------------------------------------------------------------ conversations

  /** The chats first (from the database, instant), then the projects: the last snapshot at
   *  once, then the live context — the screen never waits on the projects. */
  async refresh(): Promise<void> {
    void this.d.api
      .projects(true)
      .then((projects) => {
        if (!this.state.projects.length) this.set({ projects })
        return this.d.api.projects()
      })
      .then((projects) => this.set({ projects }))
      .catch(() => undefined)
    try {
      const list = await this.d.api.list()
      this.set({ list })
      if (!this.state.conv && list.length) await this.select(list[0].id)
    } catch (e) {
      this.set({ error: msg(e) })
    }
  }

  /** The side panel: a project page beside the chat (null hides it). */
  peek(t: TalkPeekTarget | null): Promise<boolean> {
    return this.d.api.peek(t).catch(() => false)
  }

  /** Every message in every chat. */
  search(q: string): Promise<TalkSearchHit[]> {
    return this.d.api.search(q).catch(() => [])
  }

  async select(id: string): Promise<void> {
    if (this.state.conv?.id === id) return
    this.cancelUndo()
    this.speaker.stop()
    const conv = await this.d.api.get(id)
    this.set({ conv, error: null, phase: this.idlePhase() })
  }

  /** A fresh chat (shown at once; saved with the first message). */
  async newChat(scope: string | null = null): Promise<void> {
    this.cancelUndo()
    this.speaker.stop()
    const conv = await this.d.api.create(scope)
    this.set({ conv, error: null, list: [{ id: conv.id, title: conv.title, updatedAt: conv.updatedAt, preview: '' }, ...this.state.list] })
  }

  async remove(id: string): Promise<void> {
    const list = await this.d.api.remove(id)
    this.set({ list, conv: this.state.conv?.id === id ? null : this.state.conv })
  }

  async setScope(scope: string | null): Promise<void> {
    if (!this.state.conv) return this.newChat(scope)
    this.set({ conv: await this.d.api.setScope(this.state.conv.id, scope) })
  }

  private async ensureConv(): Promise<TalkConversation> {
    if (this.state.conv) return this.state.conv
    await this.newChat(this.d.defaultScope())
    return this.state.conv as unknown as TalkConversation
  }

  // ------------------------------------------------------------------ turns

  /** The owner typed (or said) something. */
  async send(text: string, via: 'voice' | 'text' = 'text', mentions: TalkMention[] = []): Promise<void> {
    const t = text.trim()
    if (!t) return
    if (this.state.phase === 'undo' && CANCEL.test(t)) return this.cancel()
    if (this.busy || this.state.phase === 'undo' || this.state.phase === 'acting') {
      this.queue.push(t) // talking while Orcha thinks: goes with the next turn
      return
    }
    const conv = await this.ensureConv()
    this.speaker.stop()
    this.busy = true
    // show the owner's words at once; the reply replaces the conversation when it lands
    const optimistic: TalkConversation = {
      ...conv,
      turns: [
        ...conv.turns,
        { id: `local-${this.d.now()}`, who: 'you', text: t, at: new Date(this.d.now()).toISOString(), via, ...(mentions.length ? { mentions } : {}) }
      ]
    }
    this.set({ conv: optimistic, phase: 'thinking', error: null })
    let reply: TalkReply
    try {
      reply = await this.d.api.send({ id: conv.id, text: t, via, confirmPhrase: this.d.prefs().confirmPhrase, mentions })
    } catch (e) {
      this.busy = false
      this.set({ conv, phase: this.idlePhase(), error: msg(e) })
      return
    } finally {
      this.busy = false
    }
    await this.landed(reply)
  }

  private idlePhase(): TalkPhase {
    return this.state.voice && this.state.handsFree ? 'listening' : 'idle'
  }

  /** A reply arrived: show it, speak it (voice mode), then do what it asks for next. */
  private async landed(reply: TalkReply): Promise<void> {
    this.upsertSummary(reply.conversation)
    this.set({ conv: reply.conversation })
    if (this.queue.length && reply.next !== 'execute') {
      const more = this.queue.splice(0).join(' ')
      return this.send(more, 'voice')
    }
    await this.say(reply.turn.text)
    if (reply.next === 'execute') return this.startUndo()
    this.set({ phase: this.idlePhase() })
    // they asked to open something: open it once Orcha has said so (leaving Talk ends voice)
    if (reply.turn.opened && this.state.conv?.id === reply.conversation.id) this.opener?.(reply.turn.opened)
  }

  private upsertSummary(c: TalkConversation): void {
    const last = c.turns[c.turns.length - 1]
    const row = { id: c.id, title: c.title, updatedAt: c.updatedAt, preview: last ? last.text.slice(0, 120) : '' }
    this.set({ list: [row, ...this.state.list.filter((x) => x.id !== c.id)] })
  }

  private async say(text: string): Promise<void> {
    if (!this.state.voice || !this.state.speech?.ready || !text) return
    this.set({ phase: 'speaking' })
    this.listener.mute(true)
    try {
      await this.speaker.speak(text)
    } finally {
      this.listener.mute(false)
    }
  }

  /** A card's one-click action (Approve, Accept): a proposal straight from the project. */
  async quick(project: string, cid: string, action: string, args: Record<string, unknown>): Promise<void> {
    const conv = await this.ensureConv()
    if (this.busy) return
    this.busy = true
    this.cancelUndo()
    this.speaker.stop()
    this.set({ phase: 'thinking', error: null })
    try {
      const reply = await this.d.api.quick(conv.id, project, cid, action, args)
      this.busy = false
      await this.landed(reply)
    } catch (e) {
      this.busy = false
      this.set({ error: msg(e), phase: this.idlePhase() })
    }
  }

  /** Main says a conversation changed by itself (followed work came back): reload it. */
  async changed(id: string): Promise<void> {
    const conv = await this.d.api.get(id)
    if (!conv) return
    this.upsertSummary(conv)
    if (this.state.conv?.id === id && !this.busy) this.set({ conv })
  }

  // ------------------------------------------------------------------ confirming

  /** The proposal card's Confirm (or the hotkey's "yes"). */
  async confirm(): Promise<void> {
    const p = this.d.prefs()
    const pending = this.pendingProposal()
    if (!pending) return
    await this.send(pending.sensitive.length ? p.confirmPhrase : 'yes', 'text')
  }

  async cancel(): Promise<void> {
    const conv = this.state.conv
    if (!conv) return
    this.cancelUndo()
    this.speaker.stop()
    try {
      const reply = await this.d.api.decline(conv.id)
      this.queue = []
      await this.landed(reply)
    } catch (e) {
      this.set({ error: msg(e), phase: this.idlePhase() })
    }
  }

  pendingProposal(): NonNullable<TalkConversation['turns'][number]['proposal']> | null {
    const turns = this.state.conv?.turns ?? []
    for (let i = turns.length - 1; i >= 0; i--) {
      const p = turns[i].proposal
      if (p) return p.status === 'pending' ? p : null
    }
    return null
  }

  private startUndo(): void {
    const secs = this.d.prefs().undoSeconds
    if (secs <= 0) return void this.run()
    this.set({ phase: 'undo', undoUntil: this.d.now() + secs * 1000 })
    this.undoTimer = this.d.setTimer(() => void this.run(), secs * 1000)
  }

  private cancelUndo(): void {
    if (this.undoTimer !== null) this.d.clearTimer(this.undoTimer)
    this.undoTimer = null
    if (this.state.undoUntil !== null) this.set({ undoUntil: null })
  }

  private async run(): Promise<void> {
    this.undoTimer = null
    const conv = this.state.conv
    if (!conv) return
    this.set({ phase: 'acting', undoUntil: null })
    const transcript = conv.turns
      .filter((t) => t.who === 'you')
      .slice(-4)
      .map((t) => t.text)
      .join(' / ')
    let reply: TalkReply
    try {
      reply = await this.d.api.execute(conv.id, transcript)
    } catch (e) {
      this.set({ error: msg(e), phase: this.idlePhase() })
      return
    }
    this.upsertSummary(reply.conversation)
    this.set({ conv: reply.conversation })
    void this.d.api.projects().then((projects) => this.set({ projects }), () => undefined)
    await this.say(reply.turn.text)
    if (this.queue.length) return this.send(this.queue.splice(0).join(' '), 'voice')
    if (reply.turn.error) return this.set({ phase: this.idlePhase() })
    // Claude's follow-up: what next
    this.set({ phase: 'thinking' })
    try {
      const next = await this.d.api.followUp(conv.id)
      await this.landed(next)
    } catch {
      this.set({ phase: this.idlePhase() })
    }
  }

  // ------------------------------------------------------------------ voice

  /** Space is held: push-to-talk. Starts voice the first time (push-to-talk only — the mic
   *  doesn't listen on its own afterwards), interrupts Orcha, and records until release. */
  private holding = false
  async holdStart(): Promise<void> {
    if (this.holding) return
    this.holding = true
    if (!this.state.voice) {
      await this.startVoice(false)
      if (!this.state.voice || !this.holding) return
    }
    if (this.state.phase === 'speaking') this.speaker.stop()
    this.listener.hold(true)
    this.set({ phase: 'hearing' })
  }

  /** Space released: what was said goes as a message. */
  holdEnd(): void {
    if (!this.holding) return
    this.holding = false
    if (this.state.voice) this.listener.hold(false) // a real utterance → heard() → transcribing
    if (this.state.phase === 'hearing') this.set({ phase: this.idlePhase() }) // too short to send
  }

  /** Voice mode on: start local speech (once) and open the microphone. `handsFree`: the mic
   *  listens for the owner by itself (the orb / Voice button); push-to-talk starts it without. */
  /** The owner agreed: run the one-time speech setup, then turn voice on. */
  async installVoice(): Promise<void> {
    if (this.state.install?.step === 'running') return
    this.set({ install: { step: 'running', line: 'Starting…' }, error: null })
    const off = this.d.api.onInstallProgress((line) => {
      if (this.state.install?.step === 'running') this.set({ install: { step: 'running', line } })
    })
    try {
      const speech = await this.d.api.installSpeech()
      this.set({ speech })
      if (!speech.ready) {
        this.set({ install: { step: 'failed', error: speech.reason ?? 'Speech didn’t start after the install.' } })
        return
      }
      this.set({ install: null })
      await this.startVoice(this.wantHandsFree)
    } catch (e) {
      this.set({ install: { step: 'failed', error: msg(e) } })
    } finally {
      off()
    }
  }

  /** Not now: close the setup card (typing still works). */
  dismissInstall(): void {
    if (this.state.install?.step !== 'running') this.set({ install: null })
  }

  async startVoice(handsFree = true): Promise<void> {
    if (this.state.voice) {
      if (handsFree && !this.state.handsFree) {
        this.listener.setAuto(true)
        this.set({ handsFree: true })
      }
      return
    }
    this.set({ error: null })
    let speech: TalkSpeechStatus
    try {
      speech = await this.d.api.speech(true)
    } catch (e) {
      speech = { installed: false, ready: false, reason: msg(e) }
    }
    this.set({ speech })
    if (!speech.ready && speech.canInstall) {
      // never installs on its own: say what it needs and let the owner decide
      this.wantHandsFree = handsFree
      this.set({ install: { step: 'ask' } })
      return
    }
    if (!speech.ready) {
      this.set({ error: speech.reason ?? 'Speech isn’t available. You can type instead.' })
      return
    }
    try {
      await this.listener.start()
    } catch (e) {
      this.set({ error: msg(e) })
      return
    }
    this.listener.setAuto(handsFree)
    await this.ensureConv()
    this.set({ voice: true, handsFree, phase: this.busy ? this.state.phase : handsFree ? 'listening' : 'idle' })
  }

  stopVoice(): void {
    this.speaker.stop()
    this.listener.stop()
    this.queue = []
    this.holding = false
    this.set({ voice: false, handsFree: false, phase: this.busy ? this.state.phase : this.state.phase === 'undo' ? 'undo' : 'idle' })
  }

  /** The orb / hotkey: start voice, interrupt Orcha, or end your turn now. */
  async tap(): Promise<void> {
    if (this.state.phase === 'speaking') {
      this.speaker.stop()
      return
    }
    if (!this.state.voice || !this.state.handsFree) return this.startVoice()
    if (this.listener.hearing) this.listener.finish()
  }


  private async heard(wav: Blob): Promise<void> {
    const phase = this.state.phase
    if (phase === 'hearing') this.set({ phase: 'transcribing' })
    let text = ''
    try {
      text = (await this.d.api.listen(await wav.arrayBuffer())).trim()
    } catch (e) {
      this.set({ error: msg(e), phase: this.busy ? this.state.phase : this.idlePhase() })
      return
    }
    if (!text) {
      if (!this.busy && this.state.phase === 'transcribing') this.set({ phase: this.idlePhase() })
      return
    }
    await this.send(text, 'voice')
  }
}
