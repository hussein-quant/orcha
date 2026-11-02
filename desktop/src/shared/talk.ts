/** Talk to Orcha (GH #409): one master chat across every project on this Mac, typed or spoken.
 *  Shared by main (talk/*), the preload (types only) and the renderer (talk/*). */

import type { ProjectIcon } from './projectIcon'

export const TALK_CHANNELS = {
  list: 'orcha:talk:list',
  get: 'orcha:talk:get',
  create: 'orcha:talk:create',
  remove: 'orcha:talk:remove',
  /** which projects this conversation covers (and the running projects to choose from) */
  setScope: 'orcha:talk:setScope',
  projects: 'orcha:talk:projects',
  /** the owner said or typed something → Orcha's reply (maybe a proposal to confirm) */
  send: 'orcha:talk:send',
  /** the owner confirmed the pending proposal (after the undo window) → run it */
  execute: 'orcha:talk:execute',
  /** the owner declined the pending proposal */
  decline: 'orcha:talk:decline',
  /** after an action ran: Orcha's follow-up (what next, a suggestion) */
  followUp: 'orcha:talk:followUp',
  /** a card's one-click action (Approve / Accept…) → a proposal, without the model */
  quick: 'orcha:talk:quick',
  /** main → renderer: a conversation changed by itself (work it started came back) */
  changed: 'orcha:talk:changed',
  speech: 'orcha:talk:speech',
  /** set up local speech (`orcha voice install`), after the owner agreed */
  installSpeech: 'orcha:talk:installSpeech',
  /** main → renderer: one line of the speech install's output */
  installProgress: 'orcha:talk:installProgress',
  speak: 'orcha:talk:speak',
  listen: 'orcha:talk:listen',
  voices: 'orcha:talk:voices',
  /** main → renderer: the Talk hotkey was pressed (from any app) */
  hotkey: 'orcha:talk:hotkey',
  setHotkey: 'orcha:talk:setHotkey',
  /** every message in every chat (full-text) */
  search: 'orcha:talk:search',
  /** show a project page in Talk's side panel (or hide it: null) */
  peek: 'orcha:talk:peek'
} as const

export const TALK_HOTKEYS = ['Control+Alt+Space', 'Control+Shift+Space', 'Alt+Shift+Space'] as const
export type TalkHotkey = (typeof TALK_HOTKEYS)[number]

/** Something Orcha mentioned that can be opened in its project. */
export interface TalkLink {
  project: string // the stack (compose project) it lives in
  projectName: string
  cid: string
  label: string
  /** portal path, e.g. /tasks?task=… ('/' = the project itself) */
  path: string
  kind: 'project' | 'task' | 'request' | 'plan' | 'verify' | 'workflow' | 'agent' | 'page'
}

/** An agent at a glance (asked about, or @-tagged): its state, its task, what it waits on the
 *  owner for. Its chat and runs open in the side panel (/agents?agent=…&tab=conversation|runs). */
export interface TalkAgent {
  project: string
  projectName: string
  cid: string
  alias: string
  role: string
  /** the agent's own status (working, idle, awaiting_request…) */
  status: string
  /** its current task */
  task: TalkLink | null
  /** the first thing it waits on the owner for (a plan, work to verify, a question) */
  needs: TalkLink | null
  needsCount: number
}

/** A project or an agent the owner tagged with @ in the composer (a pill).
 *  project = the project key ("<stack>:<cid>"); alias = the agent (absent: the project itself). */
export interface TalkMention {
  project: string
  alias?: string
}

export type ProposalStatus = 'pending' | 'done' | 'declined' | 'failed'

export interface TalkProposal {
  project: string
  projectName: string
  cid: string
  actor: string
  action: string
  item_kind: 'plan' | 'verify' | 'request' | 'task' | 'agent'
  item_id: string | null
  title: string
  text: string | null
  read_back: string
  sensitive: string[]
  decision: boolean
  request: { method: 'POST' | 'PUT' | 'PATCH'; url: string; body: Record<string, unknown> }
  /** the draft as proposed (title, description, text…): shown in full and editable before it runs */
  args?: Record<string, unknown>
  status: ProposalStatus
  /** done: what was created / changed; failed: why */
  outcome?: string
}

export interface TalkTurn {
  id: string
  who: 'you' | 'orcha'
  text: string
  at: string
  /** spoken (voice) or typed */
  via?: 'voice' | 'text'
  links?: TalkLink[]
  proposal?: TalkProposal
  /** a reply that could not be produced (the brain was unavailable) */
  error?: boolean
  /** work this chat started came back: it needs the owner, or it finished */
  update?: TalkUpdate
  /** the owner asked to open this: the app opens it when the reply lands */
  opened?: TalkLink
  /** what Orcha looked into before answering (read-only) */
  looked?: TalkLookup[]
  /** agent cards (Orcha's reply) */
  agents?: TalkAgent[]
  /** agents the owner tagged with @ (their message) */
  mentions?: TalkMention[]
}

/** One tab Orcha read to answer (workflows, a task's thread, GitHub pulls…). */
export interface TalkLookup {
  project: string
  projectName: string
  what: string
  label: string
}

/** Something the chat is following (work it started or acted on) changed. */
export interface TalkUpdate {
  kind: 'plan' | 'verify' | 'request' | 'done' | 'cancelled'
  project: string
  projectName: string
  cid: string
  taskId: string
  title: string
  /** the request's id for a question */
  itemId: string | null
  from: string | null
  path: string
}

/** A task the chat follows, and the last state it told the owner about. */
export interface TalkWatch {
  project: string
  projectName: string
  cid: string
  taskId: string
  title: string
  last: string
}

export interface TalkConversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  /** null = every project; else one project ("<stack>:<cid>") — the chat sees and acts only there */
  scope: string | null
  turns: TalkTurn[]
  watching?: TalkWatch[]
  /** what the chat remembers from before the turns the model sees (a running summary) */
  memory?: { text: string; upto: string }
}

/** One message found by search (`snippet` marks matches with \u0001 … \u0002). */
export interface TalkSearchHit {
  conversationId: string
  turnId: string
  title: string
  at: string
  who: 'you' | 'orcha'
  snippet: string
}

export interface TalkSummary {
  id: string
  title: string
  updatedAt: string
  preview: string
  /** the one project it covers ("<stack>:<cid>"), null = every project */
  scope?: string | null
}

export interface TalkSendInput {
  id: string
  text: string
  via: 'voice' | 'text'
  /** the confirm phrase for risky actions (merge, deploy, publish…) */
  confirmPhrase: string
  /** agents tagged with @ in the composer */
  mentions?: TalkMention[]
}

/** What the renderer should do next with a reply. */
export type TalkNext = 'reply' | 'confirm' | 'execute'

export interface TalkReply {
  conversation: TalkConversation
  turn: TalkTurn
  next: TalkNext
}

export interface TalkProjectOption {
  key: string // "<stack>:<cid>"
  name: string
  stack: string
  cid: string
  needsYou: number
  /** open tasks, agents, and agents working right now (for the board) */
  openTasks: number
  agents: number
  working: number
  /** the project's own icon (emoji or app glyph), as the sidebar shows it */
  icon?: ProjectIcon | null
  /** its agents, for @-tagging in the composer */
  agentList?: { alias: string; role: string; status: string }[]
}

export interface TalkSpeechStatus {
  /** local speech installed (orcha voice install) */
  installed: boolean
  ready: boolean
  /** why speaking / listening is unavailable, in words */
  reason: string | null
  /** not installed, and the app can install it here (after asking) */
  canInstall?: boolean
}

export interface TalkVoice {
  name: string
  label: string
  quality: string
  engine?: string
}

export interface TalkApi {
  list(): Promise<TalkSummary[]>
  get(id: string): Promise<TalkConversation | null>
  create(scope?: string | null): Promise<TalkConversation>
  setScope(id: string, scope: string | null): Promise<TalkConversation>
  /** `cached`: the last snapshot at once when the live context isn't loaded yet */
  projects(cached?: boolean): Promise<TalkProjectOption[]>
  remove(id: string): Promise<TalkSummary[]>
  send(input: TalkSendInput): Promise<TalkReply>
  execute(id: string, transcript: string): Promise<TalkReply>
  decline(id: string): Promise<TalkReply>
  followUp(id: string): Promise<TalkReply>
  quick(id: string, project: string, cid: string, action: string, args: Record<string, unknown>): Promise<TalkReply>
  onChanged(cb: (id: string) => void): () => void
  speech(start: boolean): Promise<TalkSpeechStatus>
  /** run `orcha voice install` (minutes: ~3 GB of models), then start speech */
  installSpeech(): Promise<TalkSpeechStatus>
  onInstallProgress(cb: (line: string) => void): () => void
  speak(text: string, voice: string, rate: number): Promise<ArrayBuffer>
  listen(wav: ArrayBuffer): Promise<string>
  voices(): Promise<{ voices: TalkVoice[]; best: string | null }>
  setHotkey(key: TalkHotkey | null): Promise<boolean>
  onHotkey(cb: () => void): () => void
  search(q: string): Promise<TalkSearchHit[]>
  /** the side panel: a project's page at `path`, drawn at `rect` (CSS px); null hides it */
  peek(p: TalkPeekTarget | null): Promise<boolean>
}

export interface TalkPeekTarget {
  project: string
  cid: string
  path: string
  rect: { x: number; y: number; width: number; height: number }
}
