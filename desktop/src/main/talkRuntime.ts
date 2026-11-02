/** Talk to Orcha (GH #409): what the master chat's engine runs on, in main.
 *
 *  - the brain: one headless turn of the owner's own Claude Code (`claude -p`, no tools, no MCP,
 *    no hooks or project settings, a neutral cwd, a hard timeout) — their subscription, no key;
 *  - the projects: every running stack's containers and their `voice-first/context`, read in
 *    parallel and cached for a few seconds;
 *  - speech: the per-Mac local speech service, reached through any running project's
 *    `voice-first/{start,speak,listen,voices}` (it owns the token and starts the service);
 *  - the Talk hotkey (globalShortcut) and the IPC the manager window calls. */
import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { containerIcon } from '../shared/projectIcon'
import type { Stack } from '../shared/types'
import {
  TALK_CHANNELS,
  TALK_HOTKEYS,
  type TalkHotkey,
  type TalkProjectOption,
  type TalkSendInput,
  type TalkSpeechStatus,
  type TalkVoice
} from '../shared/talk'
import { BrainUnavailable, LINK_TABS, LOOKUP_KINDS, TalkEngine, lookupPath, projectKey, type ContextWorkflow, type PortalResponse, type ProjectContext, type TalkProject, type WatchedTask } from './talkEngine'
import type { TalkStore } from './talkStore'

export const TALK_MODEL = process.env.ORCHA_TALK_MODEL || 'claude-sonnet-5-5'
const MODEL_TIMEOUT_MS = Number(process.env.ORCHA_TALK_TIMEOUT_MS) || 60_000
const CONTEXT_TTL_MS = 8_000
const CONTAINERS_MAX = 6
/** how often followed work is checked for news (only while some chat follows something) */
const WATCH_MS = 20_000
/** A run token or agent identity must never leak into the owner's chat. */
const DROP_ENV = ['ORCHA_RUN_TOKEN', 'ORCHA_WORK_TOKEN', 'ORCHA_AGENT_ID', 'ORCHA_AGENT_ALIAS', 'ANTHROPIC_API_KEY']

/** The shape every answer must have (Claude Code validates it), so raw JSON or stray prose
 *  around it never reaches the chat. talkEngine.parseAnswer reads it. */
const LINK_SCHEMA = {
  type: 'object',
  properties: {
    project: { type: 'string' },
    ref: { type: 'string' },
    what: { type: 'string', enum: ['', 'workflow', 'request', 'agent', 'agent_runs', ...LINK_TABS] },
    label: { type: 'string' }
  },
  required: ['project', 'ref', 'what', 'label'],
  additionalProperties: false
}

export const ANSWER_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    reply: { type: 'string' },
    links: { type: 'array', maxItems: 6, items: LINK_SCHEMA },
    action: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: { project: { type: 'string' }, name: { type: 'string' }, args: { type: 'object' } },
          required: ['project', 'name', 'args']
        }
      ]
    },
    open: { anyOf: [{ type: 'null' }, LINK_SCHEMA] },
    look: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        properties: { project: { type: 'string' }, what: { type: 'string', enum: LOOKUP_KINDS }, id: { type: 'string' } },
        required: ['project', 'what', 'id'],
        additionalProperties: false
      }
    },
    agents: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        properties: { project: { type: 'string' }, alias: { type: 'string' } },
        required: ['project', 'alias'],
        additionalProperties: false
      }
    },
    title: { type: ['string', 'null'] }
  },
  required: ['reply', 'links', 'action', 'open', 'look', 'agents'],
  additionalProperties: false
})

export const MEMORY_SCHEMA = JSON.stringify({
  type: 'object',
  properties: { memory: { type: 'string' } },
  required: ['memory'],
  additionalProperties: false
})

export function claudeArgs(system: string, prompt: string, model = TALK_MODEL, schema = ANSWER_SCHEMA): string[] {
  return [
    '-p', '--output-format', 'json', '--no-session-persistence', '--model', model,
    '--strict-mcp-config', '--setting-sources', '', '--tools', '', '--disable-slash-commands',
    '--json-schema', schema,
    '--system-prompt', system, prompt
  ]
}

/** One model turn → its text. Throws BrainUnavailable, never hangs. */
export function askClaude(exe: string | null, system: string, prompt: string, schema = ANSWER_SCHEMA): Promise<string> {
  if (!exe) return Promise.reject(new BrainUnavailable('Claude Code is not installed on this Mac'))
  const cwd = path.join(os.tmpdir(), 'orcha-talk')
  try {
    mkdirSync(cwd, { recursive: true })
  } catch {
    /* tmp always exists */
  }
  const env = { ...process.env }
  for (const k of DROP_ENV) delete env[k]
  return new Promise((resolve, reject) => {
    execFile(exe, claudeArgs(system, prompt, TALK_MODEL, schema), { cwd, env, timeout: MODEL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const killed = (err as { killed?: boolean }).killed
        return reject(new BrainUnavailable(killed ? `Claude took longer than ${MODEL_TIMEOUT_MS / 1000} s` : (stderr || stdout || err.message).trim().slice(-200)))
      }
      try {
        const doc = JSON.parse(stdout) as { is_error?: boolean; result?: string; structured_output?: unknown }
        if (doc.is_error) return reject(new BrainUnavailable(String(doc.result ?? 'Claude reported an error').slice(0, 200)))
        const text = doc.structured_output && typeof doc.structured_output === 'object' ? JSON.stringify(doc.structured_output) : (doc.result ?? '').trim()
        return text ? resolve(text) : reject(new BrainUnavailable('Claude answered with nothing'))
      } catch {
        return reject(new BrainUnavailable('Claude returned output that is not JSON'))
      }
    })
  })
}

/** The Activity tab is a live event stream: read the last day's events for a moment, then stop. */
async function readEvents(apiPort: number, url: string): Promise<unknown[]> {
  const since = Date.now() / 1000 - 86_400
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 1500)
  const events: unknown[] = []
  try {
    const res = await fetch(`http://localhost:${apiPort}${url}?since_ts=${since}`, { signal: ctl.signal })
    const reader = res.body?.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (reader) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop() ?? ''
      for (const p of parts) {
        if (p.startsWith(': heartbeat')) return events.slice(-40) // caught up
        if (p.startsWith('data: ')) {
          try {
            events.push(JSON.parse(p.slice(6)))
          } catch {
            /* skip a malformed event */
          }
        }
      }
    }
  } catch {
    /* the read window closed: what arrived is the answer */
  } finally {
    clearTimeout(timer)
    ctl.abort()
  }
  return events.slice(-40)
}

export async function portalFetch(apiPort: number, method: string, url: string, body?: unknown, timeoutMs = 10_000): Promise<PortalResponse> {
  if (!/^\/api\/[\w/?=&.%-]*$/.test(url)) throw new Error('not a portal API path')
  const res = await fetch(`http://localhost:${apiPort}${url}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  })
  let parsed: unknown = null
  try {
    parsed = await res.json()
  } catch {
    parsed = null
  }
  return { status: res.status, body: parsed }
}

/** A container's visible workflows with their progress; undefined when they can't be read. */
async function readWorkflows(port: number, cid: string): Promise<ContextWorkflow[] | undefined> {
  const r = await portalFetch(port, 'GET', `/api/containers/${cid}/workflows`, undefined, 5000).catch(() => null)
  if (!r || r.status !== 200) return undefined
  type Row = { id: string; title: string; status: string; hidden?: boolean; progress?: { accepted?: number; total?: number } }
  const rows = (r.body as { workflows?: Row[] })?.workflows ?? []
  return rows
    .filter((w) => !w.hidden)
    .slice(0, 10)
    .map((w) => ({ id: w.id, title: w.title, status: w.status, accepted: w.progress?.accepted ?? 0, total: w.progress?.total ?? 0 }))
}

/** Every running project's context (container by container). A project that fails is
 *  skipped, never fatal. Names are unique: a clash gets its stack name added. */
export async function readProjects(stacks: Stack[]): Promise<TalkProject[]> {
  const running = stacks.filter((s) => s.running && s.apiPort !== null)
  const per = await Promise.all(
    running.map(async (s): Promise<TalkProject[]> => {
      const port = s.apiPort as number
      try {
        const list = await portalFetch(port, 'GET', '/api/containers', undefined, 4000)
        const rows = ((list.body as { containers?: { id: string }[] })?.containers ?? []).slice(0, CONTAINERS_MAX)
        const out = await Promise.all(
          rows.map(async (c): Promise<TalkProject | null> => {
            const r = await portalFetch(port, 'GET', `/api/containers/${c.id}/voice-first/context`, undefined, 5000).catch(() => null)
            if (!r || r.status !== 200) return null
            const ctx = r.body as ProjectContext
            const workflows = await readWorkflows(port, c.id)
            return { stack: s.project, name: ctx.project || s.projectShort, apiPort: port, ctx, icon: containerIcon(c) ?? null, workflows }
          })
        )
        return out.filter((x): x is TalkProject => x !== null)
      } catch {
        return []
      }
    })
  )
  const all = per.flat()
  const seen = new Map<string, number>()
  for (const p of all) seen.set(p.name.toLowerCase(), (seen.get(p.name.toLowerCase()) ?? 0) + 1)
  return all.map((p) => ((seen.get(p.name.toLowerCase()) ?? 0) > 1 ? { ...p, name: `${p.name} (${p.stack.replace(/^orcha-/, '')})` } : p))
}

export interface TalkMainDeps {
  store: TalkStore
  listStacks(): Promise<Stack[]>
  claudePath(): Promise<string | null>
  ipc: { handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void }
  shortcuts: { register(acc: string, cb: () => void): boolean; unregister(acc: string): void }
  /** focus the manager window and tell it the hotkey was pressed */
  onHotkey(): void
  /** a conversation changed by itself (followed work came back) */
  changed(id: string): void
  newId(): string
  /** run `orcha voice install` as the owner, line by line (absent: the app can't install it) */
  installSpeech?(onLine: (line: string) => void): Promise<void>
  /** send one install output line to the window */
  installProgress?(line: string): void
}

type Result<T> = { ok: true; data: T } | { ok: false; message: string }

async function result<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

const option = (p: TalkProject): TalkProjectOption => ({
  key: projectKey(p),
  name: p.name,
  stack: p.stack,
  cid: p.ctx.cid,
  needsYou: p.ctx.needs_you.length,
  openTasks: p.ctx.open_tasks.length,
  agents: p.ctx.agents.length,
  working: p.ctx.agents.filter((a) => !!a.working_on).length,
  agentList: p.ctx.agents.map((a) => ({ alias: a.alias, role: a.role, status: a.status })),
  icon: p.icon ?? null
})

export function registerTalk(d: TalkMainDeps): { release(): void } {
  let cache: { at: number; projects: TalkProject[] } | null = null
  const projects = async (fresh = false): Promise<TalkProject[]> => {
    if (!fresh && cache && Date.now() - cache.at < CONTEXT_TTL_MS) return cache.projects
    const list = await readProjects(await d.listStacks())
    cache = { at: Date.now(), projects: list }
    try {
      d.store.saveSnapshot('projects', list.map(option))
    } catch {
      /* the board just won't be instant next launch */
    }
    return list
  }
  // warm the context at launch, so the first message doesn't wait for it
  const warm = setTimeout(() => void projects().catch(() => undefined), 2_000)
  const engine = new TalkEngine({
    store: d.store,
    projects,
    ask: async (system, prompt, kind) => askClaude(await d.claudePath(), system, prompt, kind === 'memory' ? MEMORY_SCHEMA : ANSWER_SCHEMA),
    portal: (port, method, url, body) => portalFetch(port, method, url, body, 20_000),
    look: async (p, what, id) => {
      const url = lookupPath(what, p.ctx.cid, id)
      if (what === 'activity') return readEvents(p.apiPort, url)
      const r = await portalFetch(p.apiPort, 'GET', url, undefined, 8000)
      if (r.status !== 200) throw new Error(`${r.status}`)
      return r.body
    },
    newId: d.newId,
    now: () => new Date()
  })

  /** Speech goes through any running project (they share one service per Mac). */
  const speechPort = async (): Promise<{ port: number; cid: string } | null> => {
    const list = await projects()
    return list.length ? { port: list[0].apiPort, cid: list[0].ctx.cid } : null
  }
  const speechStatus = async (start: boolean): Promise<TalkSpeechStatus> => {
    const gw = await speechPort()
    if (!gw) return { installed: false, ready: false, reason: 'Start a project to use speech.' }
    const st = await portalFetch(gw.port, 'GET', `/api/containers/${gw.cid}/voice-first/status`, undefined, 5000)
    const local = (st.body as { local?: { installed?: boolean; ready?: boolean; apple_silicon?: boolean } })?.local
    if (!local?.installed) {
      if (local?.apple_silicon === false) return { installed: false, ready: false, reason: 'Speech needs a Mac with Apple Silicon.' }
      return d.installSpeech
        ? { installed: false, ready: false, reason: 'Voice needs a one-time setup.', canInstall: true }
        : { installed: false, ready: false, reason: 'Speech isn’t installed. Run `orcha voice install` once.' }
    }
    if (local.ready || !start) return { installed: true, ready: !!local.ready, reason: null }
    const r = await portalFetch(gw.port, 'POST', `/api/containers/${gw.cid}/voice-first/start`, undefined, 120_000)
    return r.status < 300 ? { installed: true, ready: true, reason: null } : { installed: true, ready: false, reason: 'Speech didn’t start. Try again.' }
  }

  const h = (ch: string, fn: (...a: unknown[]) => Promise<unknown>): void =>
    d.ipc.handle(ch, (_e, ...a) => result(() => fn(...a)))
  const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '')

  h(TALK_CHANNELS.list, () => d.store.list())
  h(TALK_CHANNELS.get, (id) => d.store.get(str(id)))
  h(TALK_CHANNELS.search, (q) => d.store.search(str(q, 200)))
  h(TALK_CHANNELS.create, async (scope) => {
    void projects().catch(() => undefined) // warm the context while the owner starts talking
    await d.store.dropEmpty() // one blank chat at a time
    return d.store.put(engine.newConversation(str(scope) || null))
  })
  h(TALK_CHANNELS.setScope, async (id, scope) => {
    const c = await d.store.get(str(id))
    if (!c) throw new Error('That conversation no longer exists.')
    return d.store.put({ ...c, scope: str(scope) || null })
  })
  // `cached`: answer at once from the last snapshot when the context isn't loaded yet
  h(TALK_CHANNELS.projects, async (cached) => {
    if (cached === true && !cache) {
      const snap = d.store.snapshot<TalkProjectOption[]>('projects')
      if (snap?.data?.length) return snap.data
    }
    return (await projects()).map(option)
  })
  h(TALK_CHANNELS.remove, async (id) => {
    await d.store.remove(str(id))
    return d.store.list()
  })
  // after a reply: fold turns that left the model's window into the chat's notes (background)
  const remembering = new Set<string>()
  const remember = <T extends { conversation: { id: string } }>(r: T): T => {
    const id = r.conversation.id
    if (!remembering.has(id)) {
      remembering.add(id)
      void engine
        .remember(id)
        .catch((e) => console.warn('[orcha-desktop] talk memory failed:', e instanceof Error ? e.message : e))
        .finally(() => remembering.delete(id))
    }
    return r
  }
  h(TALK_CHANNELS.send, async (raw) => {
    const i = (raw ?? {}) as Partial<TalkSendInput>
    return remember(await engine.send({
      id: str(i.id),
      text: str(i.text, 8000),
      via: i.via === 'voice' ? 'voice' : 'text',
      confirmPhrase: str(i.confirmPhrase, 40) || 'confirm',
      mentions: Array.isArray(i.mentions) ? i.mentions.map((m) => ({ project: str(m?.project, 160), alias: str(m?.alias, 80) || undefined })).filter((m) => m.project) : []
    }))
  })
  h(TALK_CHANNELS.execute, (id, transcript) => engine.execute(str(id), str(transcript, 4000)))
  h(TALK_CHANNELS.decline, (id) => engine.decline(str(id)))
  h(TALK_CHANNELS.followUp, async (id, phrase) => remember(await engine.followUp(str(id), str(phrase, 40) || 'confirm')))
  h(TALK_CHANNELS.quick, (id, project, cid, action, args) =>
    engine.quick(str(id), str(project), str(cid, 64), str(action, 40), args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {})
  )

  // Followed work: when a task this chat started or acted on needs the owner again (a plan,
  // a check, a question) or finishes, the conversation gets an update card.
  let checking = false
  const watchTimer = setInterval(() => {
    if (checking) return
    checking = true
    void (async () => {
      try {
        const ids = await d.store.watchingIds()
        if (!ids.length) return
        const convs = (await Promise.all(ids.map((id) => d.store.get(id)))).filter((c): c is NonNullable<typeof c> => c !== null)
        const stacks = await d.listStacks()
        const changed = await engine.checkWatches(convs, async (project, cid, ids) => {
          const s = stacks.find((x) => x.project === project && x.running && x.apiPort !== null)
          if (!s) return null
          const r = await portalFetch(s.apiPort as number, 'GET', `/api/containers/${cid}/voice-first/context?watch=${ids.join(',')}`, undefined, 6000)
          if (r.status !== 200) return null
          const b = r.body as ProjectContext & { watched?: WatchedTask[] }
          return { needs: b.needs_you ?? [], watched: b.watched ?? [] }
        })
        for (const id of changed) d.changed(id)
      } catch (e) {
        console.warn('[orcha-desktop] talk watch failed:', e instanceof Error ? e.message : e)
      } finally {
        checking = false
      }
    })()
  }, WATCH_MS)
  h(TALK_CHANNELS.speech, (start) => speechStatus(start === true))
  // one install at a time; the owner agreed to it in the app first
  let installing: Promise<TalkSpeechStatus> | null = null
  h(TALK_CHANNELS.installSpeech, () => {
    if (!d.installSpeech) return Promise.reject(new Error('Run `orcha voice install` in Terminal.'))
    const run = d.installSpeech
    installing ??= run((line) => d.installProgress?.(line))
      .then(() => speechStatus(true))
      .finally(() => {
        installing = null
      })
    return installing
  })
  h(TALK_CHANNELS.speak, async (text, voice, rate) => {
    const gw = await speechPort()
    if (!gw) throw new Error('no running project for speech')
    const res = await fetch(`http://localhost:${gw.port}/api/containers/${gw.cid}/voice-first/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: str(text, 2000), voice: str(voice, 64) || null, rate: typeof rate === 'number' && rate >= 80 ? rate : null }),
      signal: AbortSignal.timeout(30_000)
    })
    if (!res.ok) throw new Error(`speech failed (${res.status})`)
    return res.arrayBuffer()
  })
  h(TALK_CHANNELS.listen, async (wav) => {
    const gw = await speechPort()
    if (!gw) throw new Error('no running project for speech')
    if (!(wav instanceof ArrayBuffer) && !ArrayBuffer.isView(wav)) throw new Error('not audio')
    const res = await fetch(`http://localhost:${gw.port}/api/containers/${gw.cid}/voice-first/listen`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav as ArrayBuffer,
      signal: AbortSignal.timeout(60_000)
    })
    if (!res.ok) throw new Error(`listening failed (${res.status})`)
    return String(((await res.json()) as { text?: unknown }).text ?? '')
  })
  h(TALK_CHANNELS.voices, async () => {
    const gw = await speechPort()
    if (!gw) return { voices: [], best: null }
    const r = await portalFetch(gw.port, 'GET', `/api/containers/${gw.cid}/voice-first/voices`, undefined, 8000)
    const b = r.body as { voices?: { name: string; label?: string; quality?: string; engine?: string }[]; best?: string | null }
    const voices: TalkVoice[] = (b?.voices ?? []).map((v) => ({ name: v.name, label: v.label ?? v.name, quality: v.quality ?? '', engine: v.engine }))
    return { voices, best: b?.best ?? null }
  })

  let held: TalkHotkey | null = null
  const release = (): void => {
    if (held) d.shortcuts.unregister(held)
    held = null
  }
  h(TALK_CHANNELS.setHotkey, async (key) => {
    const want = (TALK_HOTKEYS as readonly unknown[]).includes(key) ? (key as TalkHotkey) : null
    if (want === held) return true
    release()
    if (!want) return true
    const ok = d.shortcuts.register(want, d.onHotkey)
    if (ok) held = want
    else console.warn(`[orcha-desktop] Talk hotkey ${want} is taken by another app`)
    return ok
  })
  return {
    release: () => {
      release()
      clearInterval(watchTimer)
      clearTimeout(warm)
      d.store.close()
    }
  }
}
