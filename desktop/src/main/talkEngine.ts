/** Talk to Orcha (GH #409): the master chat's turns, across every project on this Mac.
 *
 *  The brain is the owner's own Claude Code (talkRuntime.askClaude): each turn it gets every
 *  running project's context (team, open work, what needs the owner — `GET …/voice-first/
 *  context`) and the conversation, and answers with JSON: a reply, links to what it mentions,
 *  and at most ONE action. It never acts. The project validates the action and writes the
 *  read-back (`POST …/voice-first/propose`); the owner confirms (yes, or the confirm phrase for
 *  merge / deploy / publish…); only then does `execute` record it (voice_actions) and send the
 *  exact request the portal's own button sends, as the owner.
 *
 *  Yes / no / the confirm phrase are matched here, instantly — they never wait for the model.
 *  Pure: storage, projects, the model and HTTP are injected (talkEngine.test.ts). */
import type { ProjectIcon } from '../shared/projectIcon'
import type {
  TalkAgent,
  TalkConversation,
  TalkLink,
  TalkMention,
  TalkProposal,
  TalkReply,
  TalkSendInput,
  TalkTurn,
  TalkUpdate,
  TalkLookup,
  TalkWatch
} from '../shared/talk'

export interface ContextTask {
  id: string
  ref: string
  title: string
  status: string
  assignee: string | null
  href: string
}
export interface ContextNeed {
  kind: 'plan' | 'verify' | 'request'
  id: string
  ref: string
  title: string
  from: string | null
  /** the task it is about (a request: the task it came from, when known) */
  task_id?: string | null
  href: string
}
export interface WatchedTask {
  id: string
  title: string
  status: string
  assignee: string | null
  href: string
}
export interface ProjectContext {
  cid: string
  actor: string
  project: string
  owner: string | null
  agents: { alias: string; role: string; status: string; working_on: string | null }[]
  open_tasks: ContextTask[]
  recently_done: ContextTask[]
  needs_you: ContextNeed[]
}
export interface TalkProject {
  /** the stack (compose project) — what the app opens */
  stack: string
  /** what the owner and the model call it (unique across projects) */
  name: string
  apiPort: number
  ctx: ProjectContext
  /** the project's own icon (from GET /api/containers) */
  icon?: ProjectIcon | null
  /** its workflows that are not hidden (from GET /api/containers/{cid}/workflows) */
  workflows?: ContextWorkflow[]
}
export interface ContextWorkflow {
  id: string
  title: string
  status: string
  accepted: number
  total: number
}

export interface PortalResponse {
  status: number
  body: unknown
}

export class BrainUnavailable extends Error {}

export const projectKey = (p: TalkProject): string => `${p.stack}:${p.ctx.cid}`

export interface TalkDeps {
  store: { get(id: string): Promise<TalkConversation | null>; put(c: TalkConversation): Promise<TalkConversation> }
  /** every running project's context (cached briefly; `fresh` skips the cache) */
  projects(fresh?: boolean): Promise<TalkProject[]>
  /** one model turn → its JSON text (throws BrainUnavailable); 'memory' = MEMORY_SYSTEM's shape */
  ask(system: string, prompt: string, kind?: 'answer' | 'memory'): Promise<string>
  portal(apiPort: number, method: string, url: string, body?: unknown): Promise<PortalResponse>
  /** read one tab of a project (read-only); see LOOKUPS */
  look?(project: TalkProject, what: LookupKind, id: string): Promise<unknown>
  newId(): string
  now(): Date
}

export const HISTORY_TURNS = 40
/** older turns are folded into the chat's memory this many at a time */
export const MEMORY_BATCH = 10
const MAX_MEMORY = 2400
const MAX_REPLY = 4000

// --------------------------------------------------------------------------- the prompt

export const SYSTEM = `You are Orcha, the owner's chief of staff for all of their software projects. Each project is built by a team of AI agents in Orcha; the owner decides, you help them run everything from one chat. They may type or talk to you (spoken messages are marked); your replies may be read aloud.

The owner speaks English. Spoken messages are machine-transcribed and sometimes come out garbled or in the wrong language (short English phrases often come out as Dutch or German): read them as the English they most likely were, and always reply in English.

Be a sharp, warm colleague. Know what is going on across the board from the context below, and be proactive: point out what is waiting on them, what looks stuck, and suggest the next useful step — as a suggestion or a question, never as something you did. Keep replies conversational and short (one to three sentences) unless they ask for a rundown, details or a list; then use short lines starting with "- ". Plain text only: no markdown headings, bold, tables, HTML, ids, URLs or JSON in the reply text. Name projects, tasks and agents by name.

You can propose exactly ONE action per reply; you never perform it. The app shows the owner a read-back and runs it only after they confirm, so never say an action is done. Actions (args):
- approve_plan {task, text?}              approve an agent's plan (text = optional note)
- reject_plan {task, text}                send a plan back; text = what should change
- accept {task, text?}                    accept finished work
- send_back {task, text}                  send work back; text = what to fix
- answer {request, text}                  answer an agent's question
- create_task {title, definition_of_done, description?, assignee?}
- assign_task {task, assignee}
- post_message {task, text}               add a note or more detail to a task
- message_agent {agent, text}             send a line in an agent's own chat (agent = its alias)
Below is a summary of every project. Each project also has tabs you can look into: workflows (multi-step runs), routines (scheduled jobs), requests (questions between agents), tasks (all, including backlog), activity (recent events), metrics (runs and cost, last 7 days), pulls / issues / checks (GitHub), code_threads; and, for one item, thread (a task's messages; id = its ref), deliverables (a task's files; id = its ref), workflow / workflow_tasks (id = a workflow id), routine_runs (id = a routine id). When answering needs any of these — or when you'd otherwise say you can't see something — set "look" to what you need (up to 10, across projects; "id": "" when none) and leave "reply" empty; you will get the data and then answer. Never say you can't see a tab: look instead. Don't look when the summary already answers. Trust the summary over your own earlier replies: they may have been written when this chat covered fewer projects.

You cannot open or change anything yourself, and you cannot see a task's details beyond the context below. Never say you opened, showed or did something. When the owner asks to open, show or go to a project, task or request (or says yes to your offer to open it), set "open" to it and the app opens it on their screen; say "Opening it" rather than "I've opened it".
\`task\` / \`request\` = the ref from the context; \`project\` = the project's name exactly as listed; assignee = a real agent alias in that project.

Creating tasks: when the owner describes work, gather it into one good task — a short clear title, a description that keeps every detail, constraint and example they gave (written for the agent who will do it), and a concrete, checkable definition_of_done. Pick the right project and, when obvious, the right agent. If they are still explaining, let them; ask at most ONE short question when something essential is missing (which project, what done looks like). Never invent work they did not ask for.

Answer as a JSON object:
{"reply": "<what you say>", "links": [{"project": "<name>", "ref": "<ref or id, or \\"\\">", "what": "<\\"\\" or kind>", "label": "<name of it, or \\"\\">"}], "action": null or {"project": "<name>", "name": "<action>", "args": {...}}, "open": null or one link like those in "links", "look": [] or [{"project": "<name>", "what": "<tab>", "id": "<ref or id, or \\"\\">"}], "agents": [] or [{"project": "<name>", "alias": "<agent alias>"}], "title": null}
"agents" = agents to show as cards (at most 12) — when the owner asks about agents, who is doing what, who is stuck or waiting, or one agent's status. A card shows the agent's state, its task and what it waits on the owner for, with buttons that open its chat and its runs beside the chat, so keep the reply to a short summary and don't list each agent's details again. Show the ones that answer the question (one project's team, or just those waiting on the owner).
The owner can tag projects and agents (shown as [tagged: …] after their message). A tagged project is the one they mean. A tagged agent: when their words are for the agent — an instruction or a question to it ("check the build", "what's blocking you?") — propose message_agent with their words as the text (tidied, not reworded, nothing added); when they ask you about the agent, just answer (its card is shown for you).
"links" = what your reply talks about, so the owner can open it beside the chat (at most 6). A link is one of: a task or a request from the summary ("what": "", "ref": its ref); the project itself ("what": "", "ref": ""); a workflow ("what": "workflow", "ref": its id from the summary or a look); an agent's question ("what": "request", "ref": its id); an agent ("what": "agent", "ref": its alias — opens its chat; "what": "agent_runs" opens its runs); or a whole tab ("what": workflows / routines / requests / agents / org / github / code / activity / metrics / needs, "ref": ""). Give "label" = its name (e.g. the workflow's name) or "". Always link what you mention — workflows and questions included — so the owner can read it; prefer the item's own page (a workflow by its id) over its whole tab. When you propose an action, "reply" is a short lead-in; the app shows the owner the full draft, which they can edit or push back on, and asks to go ahead. When they push back, propose the action again with their changes; never drop it or run anything without their final say.`

function line(t: ContextTask): string {
  return `- ref=${t.ref} "${t.title}" ${t.status}${t.assignee ? `, ${t.assignee}` : ', unassigned'}`
}

export function projectsText(projects: TalkProject[]): string {
  if (!projects.length) return 'No projects are running right now.'
  return projects
    .map((p) => {
      const c = p.ctx
      const out = [`## Project: ${p.name}`]
      out.push(
        'Agents: ' +
          (c.agents.length
            ? c.agents.map((a) => `${a.alias} (${a.role}, ${a.status}${a.working_on ? `, on "${a.working_on}"` : ''})`).join('; ')
            : 'none')
      )
      if (c.needs_you.length) {
        out.push(`Needs the owner (${c.needs_you.length}):`)
        for (const n of c.needs_you) out.push(`- [${n.kind}] ref=${n.ref} "${n.title}" from ${n.from ?? 'an agent'}`)
      } else out.push('Needs the owner: nothing.')
      if (p.workflows?.length) {
        out.push('Workflows (link one with "what": "workflow", "ref": its id):')
        out.push(...p.workflows.map((w) => `- id=${w.id} "${w.title}" ${w.status}, ${w.accepted} of ${w.total} steps accepted`))
      } else if (p.workflows) out.push('Workflows: none.')
      if (c.open_tasks.length) {
        out.push('Open tasks:')
        out.push(...c.open_tasks.map(line))
      }
      if (c.recently_done.length) {
        out.push('Recently done:')
        out.push(...c.recently_done.map(line))
      }
      return out.join('\n')
    })
    .join('\n\n')
}

function historyText(c: TalkConversation): string {
  return c.turns
    .slice(-HISTORY_TURNS)
    .map((t) => {
      const who = t.who === 'you' ? `Owner${t.via === 'voice' ? ' (spoken)' : ''}` : 'Orcha'
      const proj = (m: TalkMention): string => m.project.split(':')[0].replace(/^orcha-/, '')
      const tags = t.mentions?.length
        ? ` [tagged: ${t.mentions.map((m) => (m.alias ? `agent @${m.alias} (${proj(m)})` : `project ${proj(m)}`)).join(', ')}]`
        : ''
      const p = t.proposal ? ` [proposed: ${t.proposal.read_back} (${t.proposal.projectName}) — ${t.proposal.status}${t.proposal.outcome ? `: ${t.proposal.outcome}` : ''}]` : ''
      // an older reply that leaked raw JSON: show the model only what was meant to be said
      const text = t.who === 'orcha' && t.text.includes('"reply"') ? parseAnswer(t.text).reply || t.text : t.text
      return `${who}: ${text}${tags}${p}`
    })
    .join('\n')
}

/** `others`: the names of the running projects a one-project chat does not cover, so a question
 *  about one of them is recognised (and pointed at "Cover all projects") rather than read as an
 *  item here with a similar name. */
export function buildPrompt(c: TalkConversation, projects: TalkProject[], now: Date, note?: string, others: string[] = []): string {
  const owners = [...new Set(projects.map((p) => p.ctx.owner).filter(Boolean))]
  const parts = [
    `Today is ${now.toDateString()}.${owners.length ? ` The owner is ${owners.join(' / ')}.` : ''}`,
    projectsText(projects),
    c.scope
      ? `This conversation is set to ${projects[0]?.name ?? 'one project'} only: you see and act only there. If the owner asks about other projects, say this chat is set to ${projects[0]?.name ?? 'one project'} and they can switch it to all projects with “Cover all projects” at the top of the chat. Don't answer about other projects from memory.${
          others.length
            ? ` The owner's other projects, which this chat cannot see: ${others.join(', ')}. When they name one of these (even loosely or misspelled), they mean that project, not an item here with a similar name: say it's in that project and point them to “Cover all projects”.`
            : ''
        }`
      : '',
    c.memory?.text && c.turns.length > HISTORY_TURNS ? `Earlier in this conversation (your notes):\n${c.memory.text}` : '',
    `Conversation so far:\n${historyText(c) || '(nothing yet)'}`,
    note ?? "Reply to the owner's last message."
  ]
  if (c.title === NEW_TITLE) parts.push('Also set "title": a 3 to 6 word title for this conversation.')
  return parts.filter(Boolean).join('\n\n')
}

export const MEMORY_SYSTEM = `You keep the running notes of a long conversation between a software owner and Orcha, their chief of staff across projects. Fold the new messages into the notes. Keep what later turns may need: decisions made, what the owner asked for and why, preferences, open questions, promises, and the projects, tasks and agents involved (by name). Drop small talk. Plain text, short lines starting with "- ", under 300 words. Answer as {"memory": "<the notes>"}.`

export function memoryPrompt(notes: string | undefined, turns: TalkTurn[]): string {
  const lines = turns.map((t) => `${t.at.slice(0, 16).replace('T', ' ')} ${t.who === 'you' ? 'Owner' : 'Orcha'}: ${t.text}`)
  return `Notes so far:\n${notes || '(none yet)'}\n\nNew messages:\n${lines.join('\n')}`
}

// --------------------------------------------------------------------------- looking into a project

/** What the model may look into before answering — every tab of a project, read-only.
 *  `id`: the item it is about (a task ref, or a workflow / routine id from an earlier look). */
export const LOOKUPS = {
  workflows: { label: 'Workflows', id: false, path: (cid: string) => `/api/containers/${cid}/workflows` },
  workflow: { label: 'Workflow', id: true, path: (_cid: string, id: string) => `/api/workflows/${id}` },
  workflow_tasks: { label: 'Workflow steps', id: true, path: (_cid: string, id: string) => `/api/workflows/${id}/tasks` },
  routines: { label: 'Routines', id: false, path: (cid: string) => `/api/containers/${cid}/routines` },
  routine_runs: { label: 'Routine runs', id: true, path: (_cid: string, id: string) => `/api/routines/${id}/runs` },
  requests: { label: 'Requests', id: false, path: (cid: string) => `/api/containers/${cid}/requests` },
  tasks: { label: 'All tasks', id: false, path: (cid: string) => `/api/containers/${cid}/tasks` },
  thread: { label: 'Thread', id: true, path: (_cid: string, id: string) => `/api/tasks/${id}/messages` },
  deliverables: { label: 'Deliverables', id: true, path: (_cid: string, id: string) => `/api/tasks/${id}/deliverables` },
  activity: { label: 'Activity', id: false, path: (cid: string) => `/api/containers/${cid}/events` },
  metrics: { label: 'Metrics', id: false, path: (cid: string) => `/api/containers/${cid}/metrics` },
  pulls: { label: 'Pull requests', id: false, path: (cid: string) => `/api/containers/${cid}/github/pulls` },
  issues: { label: 'Issues', id: false, path: (cid: string) => `/api/containers/${cid}/github/issues` },
  checks: { label: 'Checks', id: false, path: (cid: string) => `/api/containers/${cid}/github/checks` },
  code_threads: { label: 'Code threads', id: false, path: (cid: string) => `/api/containers/${cid}/code/threads` }
} as const
export type LookupKind = keyof typeof LOOKUPS
export const LOOKUP_KINDS = Object.keys(LOOKUPS) as LookupKind[]
export const MAX_LOOKUPS = 10
const LOOK_BUDGET = 7000

/** A task ref / id prefix from the context → its full id; another id (a workflow, a routine)
 *  only when it is a whole UUID. Never anything that could reshape the path. */
export function resolveLookupId(p: TalkProject, raw: string): string {
  const r = raw.trim().toLowerCase()
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r)) return r
  if (!/^[0-9a-f]{4,}$/.test(r)) return ''
  const task = [...p.ctx.open_tasks, ...p.ctx.recently_done].find((t) => t.ref.startsWith(r) || t.id.startsWith(r))
  if (task) return task.id
  const need = p.ctx.needs_you.find((n) => n.ref.startsWith(r) || n.id.startsWith(r))
  return need?.task_id ?? need?.id ?? ''
}

export function lookupPath(what: LookupKind, cid: string, id: string): string {
  return (LOOKUPS[what].path as (cid: string, id: string) => string)(cid, id)
}

function lookupLabel(p: TalkProject, what: LookupKind, id: string): string {
  const spec = LOOKUPS[what]
  if (!spec.id) return spec.label
  const task = [...p.ctx.open_tasks, ...p.ctx.recently_done].find((t) => t.id === id)
  return task ? `${spec.label}: ${task.title}` : spec.label
}

/** JSON for the prompt: long strings cut, long lists capped, the whole within a budget. */
export function compact(v: unknown, budget = LOOK_BUDGET): string {
  const walk = (x: unknown, depth: number): unknown => {
    if (typeof x === 'string') return x.length > 400 ? `${x.slice(0, 400)}…` : x
    if (Array.isArray(x)) {
      const items = x.slice(0, 30).map((i) => walk(i, depth + 1))
      return x.length > 30 ? [...items, `…${x.length - 30} more`] : items
    }
    if (x && typeof x === 'object') {
      if (depth > 6) return '…'
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(x)) {
        if (val === null || val === '') continue // empty lists stay: “none” is an answer
        out[k] = walk(val, depth + 1)
      }
      return out
    }
    return x
  }
  const s = typeof v === 'string' ? v : JSON.stringify(walk(v, 0))
  return s.length > budget ? `${s.slice(0, budget)}… (cut)` : s
}

// --------------------------------------------------------------------------- the model's answer

export interface BrainAnswer {
  reply: string
  links: LinkAsk[]
  action: { project: string; name: string; args: Record<string, unknown> } | null
  /** what the owner asked to open */
  open: LinkAsk | null
  /** tabs to look into before answering */
  look: { project: string; what: string; id: string }[]
  /** agents to show as cards */
  agents: { project: string; alias: string }[]
  title: string | null
}

const FENCE = /^```(?:json)?\s*|\s*```$/gm

/** Every top-level {...} in `t` that parses as a JSON object, in order (strings respected). */
function jsonObjects(t: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"' && depth > 0) inStr = true
    else if (ch === '{') {
      if (depth++ === 0) start = i
    } else if (ch === '}' && depth > 0 && --depth === 0) {
      try {
        const v = JSON.parse(t.slice(start, i + 1))
        if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Record<string, unknown>)
      } catch {
        /* not JSON: keep scanning */
      }
    }
  }
  return out
}

export function parseAnswer(text: string): BrainAnswer {
  const t = text.replace(FENCE, '').trim()
  // the model's answer object; when it wrote more than one (a "correction"), the last one wins
  const docs = jsonObjects(t)
  const doc = docs.filter((d) => typeof d.reply === 'string' || typeof d.say === 'string').pop() ?? (docs.length === 1 && t.startsWith('{') ? docs[0] : null)
  if (!doc) return { reply: t.slice(0, MAX_REPLY), links: [], action: null, open: null, look: [], agents: [], title: null } // plain prose: still a reply
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const links = Array.isArray(doc.links)
    ? doc.links
        .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object')
        .map((l) => ({ project: str(l.project), ref: str(l.ref), what: str(l.what), label: str(l.label) }))
        .filter((l) => l.project)
        .slice(0, 6)
    : []
  const act = doc.action && typeof doc.action === 'object' ? (doc.action as Record<string, unknown>) : null
  const action =
    act && str(act.name)
      ? {
          project: str(act.project),
          name: str(act.name),
          args: act.args && typeof act.args === 'object' && !Array.isArray(act.args) ? (act.args as Record<string, unknown>) : {}
        }
      : null
  const o = doc.open && typeof doc.open === 'object' ? (doc.open as Record<string, unknown>) : null
  return {
    reply: (str(doc.reply) || str(doc.say)).trim().slice(0, MAX_REPLY),
    links,
    action,
    open: o && str(o.project) ? { project: str(o.project), ref: str(o.ref), what: str(o.what), label: str(o.label) } : null,
    look: Array.isArray(doc.look)
      ? doc.look
          .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object')
          .map((l) => ({ project: str(l.project), what: str(l.what), id: str(l.id) }))
          .filter((l) => l.project && (LOOKUP_KINDS as string[]).includes(l.what))
          .slice(0, MAX_LOOKUPS)
      : [],
    agents: Array.isArray(doc.agents)
      ? doc.agents
          .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
          .map((a) => ({ project: str(a.project), alias: str(a.alias) }))
          .filter((a) => a.project && a.alias)
          .slice(0, MAX_AGENTS)
      : [],
    title: str(doc.title).trim().slice(0, 60) || null
  }
}

// --------------------------------------------------------------------------- yes / no

const FILLERS = /^(?:(?:um+|uh+|er+|hmm+|ok(?:ay)?|so|well|please|alright)[\s,]+)+/

export function normalize(text: string): string {
  let t = text.toLowerCase().trim().replace(/[‘’]/g, "'")
  t = t.replace(/[.!?]+$/, '').replace(/\s+/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '')
  return t.replace(FILLERS, '').replace(/^[\s,]+|[\s,]+$/g, '')
}

export const YES =
  /^(?:yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|please do|confirm|confirmed|correct|that'?s right|sounds good|right|go for it|send it|create it|yes please|yes go ahead|yeah go ahead|perfect|great|looks good|ship it)$/
export const NO = /^(?:no|nope|cancel|don'?t|do not|stop|never ?mind|wait|hold on|not yet|no thanks|abort)$/

/** true = the confirm phrase, false = cancel, null = neither. */
export function isConfirmation(text: string, phrase: string): boolean | null {
  const t = normalize(text)
  const p = normalize(phrase)
  if (p && (t === p || (t.startsWith(p + ' ') && t.split(' ').length <= p.split(' ').length + 2))) return true
  if (/^(?:cancel|no|nope|stop|don'?t|do not|never ?mind|abort|wait)\b/.test(t)) return false
  return null
}

// --------------------------------------------------------------------------- the engine

export const NEW_TITLE = 'New chat'

const DONE_WORDS: Record<string, string> = {
  approve_plan: 'Approved the plan',
  reject_plan: 'Sent the plan back',
  accept: 'Accepted it',
  send_back: 'Sent it back',
  answer: 'Answered',
  create_task: 'Created',
  assign_task: 'Assigned',
  post_message: 'Posted',
  message_agent: 'Sent'
}

function findProject(projects: TalkProject[], name: string): TalkProject | null {
  const n = name.trim().toLowerCase()
  if (!n) return projects.length === 1 ? projects[0] : null
  return (
    projects.find((p) => p.name.toLowerCase() === n) ??
    projects.find((p) => p.stack.toLowerCase() === n || p.stack.toLowerCase().replace(/^orcha-/, '') === n) ??
    null
  )
}

/** Whole tabs a link can open (each is a portal page; the side panel shows it chromeless). */
export const LINK_TABS = ['workflows', 'routines', 'requests', 'agents', 'org', 'github', 'code', 'activity', 'metrics', 'needs'] as const
const TAB_LABEL: Record<(typeof LINK_TABS)[number], string> = {
  workflows: 'Workflows',
  routines: 'Routines',
  requests: 'Requests',
  agents: 'Agents',
  org: 'Org',
  github: 'GitHub',
  code: 'Code',
  activity: 'Activity',
  metrics: 'Metrics',
  needs: 'Needs you'
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface LinkAsk {
  project: string
  ref: string
  /** "" = a task / request ref from the summary (or the project); else a workflow, request,
   *  agent, or a whole tab */
  what?: string
  label?: string
}

function linkFor(p: TalkProject, l: LinkAsk): TalkLink | null {
  const base = { project: p.stack, projectName: p.name, cid: p.ctx.cid }
  const r = l.ref.trim().toLowerCase()
  const what = (l.what ?? '').trim().toLowerCase()
  const label = (l.label ?? '').trim().slice(0, 120)
  if (what === 'workflow') return UUID_RE.test(r) ? { ...base, label: label || 'Workflow', path: `/workflows/${r}`, kind: 'workflow' } : null
  if (what === 'request') return UUID_RE.test(r) ? { ...base, label: label || 'Question', path: `/requests?req=${r}`, kind: 'request' } : null
  if (what === 'agent' || what === 'agent_chat' || what === 'agent_runs') {
    const a = p.ctx.agents.find((x) => x.alias.toLowerCase() === r.replace(/^@/, ''))
    return a ? agentLink(p, a.alias, what === 'agent_runs' ? 'runs' : 'conversation') : null
  }
  if ((LINK_TABS as readonly string[]).includes(what)) {
    const tab = what as (typeof LINK_TABS)[number]
    return { ...base, label: TAB_LABEL[tab], path: `/${tab}`, kind: 'page' }
  }
  if (!r) return { ...base, label: p.name, path: '/', kind: 'project' }
  if (r.length < 4) return null
  const need = p.ctx.needs_you.find((n) => n.ref.startsWith(r) || n.id.startsWith(r))
  if (need) return { ...base, label: need.title, path: need.href, kind: need.kind }
  const task = [...p.ctx.open_tasks, ...p.ctx.recently_done].find((t) => t.ref.startsWith(r) || t.id.startsWith(r))
  return task ? { ...base, label: task.title, path: task.href, kind: 'task' } : null
}

/** An agent's page on its chat (the default tab) or its runs. */
export function agentLink(p: TalkProject, alias: string, tab: 'conversation' | 'runs'): TalkLink {
  return {
    project: p.stack,
    projectName: p.name,
    cid: p.ctx.cid,
    label: tab === 'runs' ? `${alias} · Runs` : alias,
    path: `/agents?agent=${encodeURIComponent(alias)}&tab=${tab}`,
    kind: 'agent'
  }
}

export const MAX_AGENTS = 12

/** The agents to show as cards (asked for by the model or tagged by the owner), from the summary:
 *  state, current task, and what each waits on the owner for. Unknown agents are dropped. */
export function agentCards(projects: TalkProject[], asks: { project: string; alias: string }[]): TalkAgent[] {
  const out: TalkAgent[] = []
  for (const ask of asks) {
    const p = projects.find((x) => projectKey(x) === ask.project) ?? findProject(projects, ask.project)
    const want = ask.alias.trim().replace(/^@/, '').toLowerCase()
    const a = p?.ctx.agents.find((x) => x.alias.toLowerCase() === want)
    if (!p || !a || out.some((o) => o.project === p.stack && o.cid === p.ctx.cid && o.alias === a.alias)) continue
    const needs = p.ctx.needs_you.filter((n) => n.from === a.alias)
    const mine = p.ctx.open_tasks.filter((t) => t.assignee === a.alias)
    const task = (a.working_on && mine.find((t) => t.title === a.working_on)) || mine.find((t) => t.status === 'in_progress')
    out.push({
      project: p.stack,
      projectName: p.name,
      cid: p.ctx.cid,
      alias: a.alias,
      role: a.role,
      status: a.status,
      task: task ? linkFor(p, { project: p.name, ref: task.ref }) : null,
      needs: needs[0] ? linkFor(p, { project: p.name, ref: needs[0].ref }) : null,
      needsCount: needs.length
    })
    if (out.length >= MAX_AGENTS) break
  }
  return out
}

export function resolveLinks(projects: TalkProject[], links: LinkAsk[]): TalkLink[] {
  const out: TalkLink[] = []
  for (const l of links) {
    const p = findProject(projects, l.project)
    const link = p && linkFor(p, l)
    if (link && !out.some((o) => o.project === link.project && o.path === link.path)) out.push(link)
  }
  return out
}

function portalReason(body: unknown, status: number): string {
  const d = (body as { detail?: unknown })?.detail
  if (typeof d === 'string') return d
  if (d && typeof d === 'object' && typeof (d as { message?: unknown }).message === 'string') return (d as { message: string }).message
  if (Array.isArray(d)) return d.map((e) => (e && typeof e === 'object' && 'msg' in e ? String(e.msg) : '')).filter(Boolean).join('; ')
  return `it was refused (${status})`
}

export class TalkEngine {
  constructor(private readonly deps: TalkDeps) {}

  newConversation(scope: string | null = null): TalkConversation {
    const at = this.deps.now().toISOString()
    return { id: this.deps.newId(), title: NEW_TITLE, createdAt: at, updatedAt: at, scope, turns: [] }
  }

  /** The projects a conversation covers: all running ones, or just its scoped project. */
  private async scoped(c: TalkConversation, fresh = false): Promise<TalkProject[]> {
    const all = await this.deps.projects(fresh)
    return c.scope ? all.filter((p) => projectKey(p) === c.scope) : all
  }

  /** The running projects a one-project chat leaves out (their names only). */
  private async others(c: TalkConversation): Promise<string[]> {
    if (!c.scope) return []
    return (await this.deps.projects()).filter((p) => projectKey(p) !== c.scope).map((p) => p.name)
  }

  private turn(who: TalkTurn['who'], text: string, extra: Partial<TalkTurn> = {}): TalkTurn {
    return { id: this.deps.newId(), who, text, at: this.deps.now().toISOString(), ...extra }
  }

  private async load(id: string): Promise<TalkConversation> {
    const c = await this.deps.store.get(id)
    if (!c) throw new Error('That conversation no longer exists.')
    return c
  }

  private async reply(c: TalkConversation, turn: TalkTurn, next: TalkReply['next'] = 'reply'): Promise<TalkReply> {
    c.turns.push(turn)
    c.updatedAt = turn.at
    const saved = await this.deps.store.put(c)
    return { conversation: saved, turn, next }
  }

  private pending(c: TalkConversation): TalkProposal | null {
    for (let i = c.turns.length - 1; i >= 0; i--) {
      const p = c.turns[i].proposal
      if (p) return p.status === 'pending' ? p : null
    }
    return null
  }

  /** The owner said or typed something. */
  async send(input: TalkSendInput): Promise<TalkReply> {
    const c = await this.load(input.id)
    const text = input.text.trim().slice(0, MAX_REPLY)
    if (!text) throw new Error('Say or type something first.')
    const mentions: TalkMention[] = (input.mentions ?? [])
      .filter((m) => m && typeof m.project === 'string' && m.project)
      .map((m) => {
        const alias = typeof m.alias === 'string' ? m.alias.replace(/^@/, '').slice(0, 80) : ''
        return alias ? { project: m.project.slice(0, 160), alias } : { project: m.project.slice(0, 160) }
      })
      .slice(0, MAX_AGENTS)
    c.turns.push(this.turn('you', text, mentions.length ? { via: input.via, mentions } : { via: input.via }))
    c.updatedAt = this.deps.now().toISOString()

    const p = this.pending(c)
    if (p) {
      const said = normalize(text)
      if (p.sensitive.length) {
        const ok = isConfirmation(text, input.confirmPhrase)
        if (ok === true) return this.reply(c, this.turn('orcha', 'Okay.'), 'execute')
        if (ok === false || NO.test(said)) return this.declined(c, p)
        if (YES.test(said))
          return this.reply(
            c,
            this.turn('orcha', `This touches ${p.sensitive.slice(0, 3).join(', ')}. Say "${input.confirmPhrase}" to go ahead, or cancel.`),
            'confirm'
          )
      } else {
        if (YES.test(said)) return this.reply(c, this.turn('orcha', 'Okay.'), 'execute')
        if (NO.test(said)) return this.declined(c, p)
      }
      p.status = 'declined' // anything else: the owner moved on (the model may propose it again, changed)
      p.outcome = 'replaced'
    }
    return this.think(c, input.confirmPhrase)
  }

  private declined(c: TalkConversation, p: TalkProposal): Promise<TalkReply> {
    p.status = 'declined'
    return this.reply(c, this.turn('orcha', "Okay, I won't."))
  }

  /** The owner declined the pending proposal (Cancel, or undo during the countdown). */
  async decline(id: string): Promise<TalkReply> {
    const c = await this.load(id)
    const p = this.pending(c)
    if (!p) return this.reply(c, this.turn('orcha', 'Nothing is waiting.'))
    p.status = 'declined'
    return this.reply(c, this.turn('orcha', 'Cancelled. Nothing was sent.'))
  }

  private async think(c: TalkConversation, confirmPhrase: string, note?: string): Promise<TalkReply> {
    const projects = await this.scoped(c)
    if (c.scope && !projects.length) {
      return this.reply(c, this.turn('orcha', "That project isn't running right now. Start it, or switch this chat to all projects.", { error: true }))
    }
    let ans: BrainAnswer
    const looked: TalkLookup[] = []
    try {
      const prompt = buildPrompt(c, projects, this.deps.now(), note, await this.others(c))
      ans = parseAnswer(await this.deps.ask(SYSTEM, prompt))
      // it asked to look into a tab first (workflows, a task's thread, GitHub…): fetch, then answer
      if (ans.look.length && this.deps.look) {
        const found = await this.lookups(projects, ans.look)
        looked.push(...found.map((f) => f.ref))
        const data = found.map((f) => `### ${f.ref.label} — ${f.ref.projectName}\n${f.text}`).join('\n\n')
        ans = parseAnswer(
          await this.deps.ask(SYSTEM, `${prompt}\n\nWhat you looked up (now answer the owner; you cannot look again):\n\n${data || '(nothing could be read)'}`)
        )
      }
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      return this.reply(c, this.turn('orcha', `I can't reach Claude right now (${why}). Try again in a moment.`, { error: true }))
    }
    if (ans.title && c.title === NEW_TITLE) c.title = ans.title
    const extra: Partial<TalkTurn> = looked.length ? { looked } : {}
    // agent cards: whoever the owner just tagged, then whoever the model chose to show
    const tagged = ([...c.turns].reverse().find((t) => t.who === 'you')?.mentions ?? []).filter((m): m is Required<TalkMention> => !!m.alias)
    const agents = agentCards(projects, [...tagged, ...ans.agents])
    if (agents.length) extra.agents = agents
    const opened = ans.open ? resolveLinks(projects, [ans.open])[0] : undefined
    const links = resolveLinks(projects, ans.open ? [ans.open, ...ans.links] : ans.links)
    if (!ans.action) return this.reply(c, this.turn('orcha', ans.reply || 'Sorry, could you say that again?', { ...extra, links, opened }))

    const proj = findProject(projects, ans.action.project)
    if (!proj) {
      const names = projects.map((p) => p.name).join(', ')
      return this.reply(
        c,
        this.turn('orcha', `${ans.reply ? ans.reply + ' ' : ''}Which project is that for? ${names ? `I have ${names}.` : ''}`.trim(), { ...extra, links })
      )
    }
    return this.propose(c, proj, ans.action.name, ans.action.args, confirmPhrase, ans.reply, links, extra)
  }

  /** Read what the model asked to look at (read-only GETs), each compacted for the prompt. */
  private async lookups(projects: TalkProject[], asks: BrainAnswer['look']): Promise<{ ref: TalkLookup; text: string }[]> {
    const seen = new Set<string>()
    const jobs: Promise<{ ref: TalkLookup; text: string } | null>[] = []
    for (const a of asks.slice(0, MAX_LOOKUPS)) {
      const p = findProject(projects, a.project)
      const spec = LOOKUPS[a.what as LookupKind]
      if (!p || !spec) continue
      const id = spec.id ? resolveLookupId(p, a.id) : ''
      if (spec.id && !id) continue
      const key = `${p.stack}:${p.ctx.cid}:${a.what}:${id}`
      if (seen.has(key)) continue
      seen.add(key)
      const ref: TalkLookup = { project: p.stack, projectName: p.name, what: a.what, label: lookupLabel(p, a.what as LookupKind, id) }
      jobs.push(
        (this.deps.look as NonNullable<TalkDeps['look']>)(p, a.what as LookupKind, id)
          .then((v) => ({ ref, text: compact(v) }))
          .catch((e) => ({ ref, text: `(could not read: ${e instanceof Error ? e.message : String(e)})` }))
      )
    }
    return (await Promise.all(jobs)).filter((x): x is { ref: TalkLookup; text: string } => x !== null)
  }

  /** One action → the project validates it and writes the read-back → a card to confirm. */
  private async propose(
    c: TalkConversation,
    proj: TalkProject,
    action: string,
    args: Record<string, unknown>,
    confirmPhrase: string,
    reply = '',
    links: TalkLink[] = [],
    extra: Partial<TalkTurn> = {}
  ): Promise<TalkReply> {
    let res: PortalResponse
    try {
      res = await this.deps.portal(proj.apiPort, 'POST', `/api/containers/${proj.ctx.cid}/voice-first/propose`, {
        actor_agent_id: proj.ctx.actor,
        action,
        args
      })
    } catch (e) {
      return this.reply(c, this.turn('orcha', `I couldn't reach ${proj.name} (${e instanceof Error ? e.message : String(e)}).`, { ...extra, links, error: true }))
    }
    const body = res.body as { proposal?: Omit<TalkProposal, 'project' | 'projectName' | 'cid' | 'actor' | 'status'>; say?: string }
    if (res.status >= 300 || !body?.proposal) {
      const say = body?.say ?? portalReason(res.body, res.status)
      return this.reply(c, this.turn('orcha', `${reply ? reply + ' ' : ''}${say}`.trim(), { ...extra, links }))
    }
    const proposal: TalkProposal = {
      ...body.proposal,
      project: proj.stack,
      projectName: proj.name,
      cid: proj.ctx.cid,
      actor: proj.ctx.actor,
      args,
      status: 'pending'
    }
    const ask = proposal.sensitive.length
      ? `This touches ${proposal.sensitive.slice(0, 3).join(', ')}, so say "${confirmPhrase}" to go ahead, or cancel.`
      : 'Change anything, or shall I go ahead?'
    const item = proposal.item_id ? linkFor(proj, { project: proj.name, ref: proposal.item_id }) : null
    const allLinks = item && !links.some((l) => l.path === item.path) ? [item, ...links] : links
    const lead = reply && !reply.includes(proposal.read_back) ? `${reply} ` : ''
    return this.reply(c, this.turn('orcha', `${lead}${proposal.read_back} ${ask}`, { ...extra, proposal, links: allLinks }), 'confirm')
  }

  /** A card's one-click action (Approve, Accept…): straight to a proposal, no model turn. */
  async quick(id: string, project: string, cid: string, action: string, args: Record<string, unknown>, confirmPhrase = 'confirm'): Promise<TalkReply> {
    const c = await this.load(id)
    const proj = (await this.deps.projects()).find((p) => p.stack === project && p.ctx.cid === cid)
    if (!proj) return this.reply(c, this.turn('orcha', "That project isn't running right now.", { error: true }))
    const p = this.pending(c)
    if (p) {
      p.status = 'declined'
      p.outcome = 'replaced'
    }
    return this.propose(c, proj, action, args, confirmPhrase)
  }

  /** The owner confirmed (and the undo window passed): record it, send it, report back. */
  async execute(id: string, transcript: string): Promise<TalkReply> {
    const c = await this.load(id)
    const p = this.pending(c)
    if (!p) return this.reply(c, this.turn('orcha', 'Nothing is waiting to run.'))
    const proj = (await this.deps.projects()).find((x) => x.stack === p.project && x.ctx.cid === p.cid)
    if (!proj) {
      p.status = 'failed'
      p.outcome = `${p.projectName} isn't running`
      return this.reply(c, this.turn('orcha', `${p.projectName} isn't running, so nothing was sent.`, { error: true }))
    }
    if (p.item_kind === 'agent') return this.sendToAgent(c, proj, p)
    const base = `/api/containers/${p.cid}/voice-first/actions`
    const fail = async (why: string, vid?: string): Promise<TalkReply> => {
      p.status = 'failed'
      p.outcome = why
      if (vid) await this.deps.portal(proj.apiPort, 'PATCH', `${base}/${vid}`, { actor_agent_id: p.actor, status: 'failed', reason: why.slice(0, 500) }).catch(() => undefined)
      return this.reply(c, this.turn('orcha', `That didn't go through: ${why}.`, { error: true }))
    }
    let vid: string
    try {
      const rec = await this.deps.portal(proj.apiPort, 'POST', base, {
        actor_agent_id: p.actor,
        idempotency_key: this.deps.newId(),
        kind: p.item_kind,
        item_id: p.item_id,
        action: p.action,
        transcript: transcript.slice(0, 4000) || p.read_back,
        text: p.text
      })
      if (rec.status >= 300) return fail(portalReason(rec.body, rec.status))
      vid = String((rec.body as { voice_action_id?: unknown }).voice_action_id)
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
    let res: PortalResponse
    try {
      const body = p.decision ? { ...p.request.body, via: 'voice', voice_action_id: vid } : p.request.body
      res = await this.deps.portal(proj.apiPort, p.request.method, p.request.url, body)
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e), vid)
    }
    if (res.status >= 300) return fail(portalReason(res.body, res.status), vid)
    if (!p.decision) {
      await this.deps
        .portal(proj.apiPort, 'PATCH', `${base}/${vid}`, { actor_agent_id: p.actor, status: 'done', result: { status: res.status } })
        .catch(() => undefined)
    }
    const links: TalkLink[] = []
    const created = p.action === 'create_task' ? (res.body as { id?: unknown; task_id?: unknown }) : null
    const newId = created ? String(created.id ?? created.task_id ?? '') : ''
    if (newId) links.push({ project: p.project, projectName: p.projectName, cid: p.cid, label: p.title, path: `/tasks?task=${newId}`, kind: 'task' })
    else if (p.item_id) {
      const l = linkFor(proj, { project: proj.name, ref: p.item_id })
      if (l) links.push(l)
    }
    p.status = 'done'
    p.outcome = `${DONE_WORDS[p.action] ?? 'Done'}${p.action === 'create_task' ? ` “${p.title}”` : ''}`
    // follow the task from here: when it needs the owner again or finishes, this chat says so
    const taskId = newId || (p.item_kind !== 'request' ? p.item_id : null)
    if (taskId) {
      const w: TalkWatch = { project: p.project, projectName: p.projectName, cid: p.cid, taskId, title: p.title, last: '' }
      c.watching = [...(c.watching ?? []).filter((x) => x.taskId !== taskId), w].slice(-50)
    }
    await this.deps.projects(true).catch(() => undefined) // the next turn sees the change
    return this.reply(c, this.turn('orcha', `Done. ${p.outcome} in ${p.projectName}.`, { links }))
  }

  /** message_agent: open the agent's own chat (get-or-create), then post the owner's words there
   *  as the owner. That line in the agent's chat is the record (voice_actions has no agent kind). */
  private async sendToAgent(c: TalkConversation, proj: TalkProject, p: TalkProposal): Promise<TalkReply> {
    const fail = (why: string): Promise<TalkReply> => {
      p.status = 'failed'
      p.outcome = why
      return this.reply(c, this.turn('orcha', `That didn't go through: ${why}.`, { error: true }))
    }
    try {
      const open = await this.deps.portal(proj.apiPort, p.request.method, p.request.url, p.request.body)
      if (open.status >= 300) return fail(portalReason(open.body, open.status))
      const b = open.body as { id?: unknown; conversation?: { id?: unknown } } | null
      const conv = String(b?.conversation?.id ?? b?.id ?? '')
      if (!UUID_RE.test(conv)) return fail(`${p.title}'s chat couldn't be opened`)
      const sent = await this.deps.portal(proj.apiPort, 'POST', `/api/conversations/${conv}/turns`, { role: 'human', author_agent_id: p.actor, content: p.text })
      if (sent.status >= 300) return fail(portalReason(sent.body, sent.status))
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
    p.status = 'done'
    p.outcome = `Sent to ${p.title}`
    return this.reply(c, this.turn('orcha', `Sent. ${p.title} answers in its chat.`, { links: [agentLink(proj, p.title, 'conversation')] }))
  }

  /** After an action ran: a short, proactive follow-up from the brain (what next). */
  /** A long chat keeps its context: turns that scrolled out of the model's window are folded
   *  into the chat's notes (in the background, MEMORY_BATCH at a time). True when updated. */
  async remember(id: string): Promise<boolean> {
    const c = await this.deps.store.get(id)
    if (!c) return false
    const cut = c.turns.length - HISTORY_TURNS
    const from = c.memory ? c.turns.findIndex((t) => t.id === c.memory?.upto) + 1 : 0
    if (cut - from < MEMORY_BATCH) return false
    const older = c.turns.slice(from, cut)
    const raw = await this.deps.ask(MEMORY_SYSTEM, memoryPrompt(c.memory?.text, older), 'memory')
    let text = ''
    try {
      text = String((JSON.parse(raw) as { memory?: unknown }).memory ?? '').trim()
    } catch {
      text = raw.trim()
    }
    if (!text) return false
    const latest = await this.deps.store.get(id)
    if (!latest) return false
    await this.deps.store.put({ ...latest, memory: { text: text.slice(0, MAX_MEMORY), upto: older[older.length - 1].id } })
    return true
  }

  async followUp(id: string, confirmPhrase = 'confirm'): Promise<TalkReply> {
    const c = await this.load(id)
    return this.think(
      c,
      confirmPhrase,
      'The last action just ran (see above). In one or two sentences, suggest the most useful next step across their projects, as a question — or simply ask what is next. Do not repeat that it was done.'
    )
  }

  /** Work this chat follows changed: it needs the owner (a plan, a check, a question) or it
   *  finished. `read` gives each project's needs + the followed tasks' status. Returns the
   *  conversations that got a new update turn. */
  async checkWatches(
    conversations: TalkConversation[],
    read: (project: string, cid: string, taskIds: string[]) => Promise<{ needs: ContextNeed[]; watched: WatchedTask[] } | null>
  ): Promise<string[]> {
    const want = new Map<string, { project: string; cid: string; ids: Set<string> }>()
    for (const c of conversations)
      for (const w of c.watching ?? []) {
        const k = `${w.project}:${w.cid}`
        const e = want.get(k) ?? { project: w.project, cid: w.cid, ids: new Set<string>() }
        e.ids.add(w.taskId)
        want.set(k, e)
      }
    if (!want.size) return []
    const seen = new Map<string, { needs: ContextNeed[]; watched: WatchedTask[] }>()
    await Promise.all(
      [...want.entries()].map(async ([k, e]) => {
        const r = await read(e.project, e.cid, [...e.ids]).catch(() => null)
        if (r) seen.set(k, r)
      })
    )
    const changed: string[] = []
    for (const c of conversations) {
      let touched = false
      const keep: TalkWatch[] = []
      for (const w of c.watching ?? []) {
        const r = seen.get(`${w.project}:${w.cid}`)
        if (!r) {
          keep.push(w)
          continue
        }
        const task = r.watched.find((t) => t.id === w.taskId)
        const need = r.needs.find((n) => (n.task_id ?? (n.kind !== 'request' ? n.id : null)) === w.taskId)
        const state = need ? `${need.kind}:${need.id}` : task ? task.status : 'gone'
        if (state === 'gone') {
          touched = true
          continue
        }
        const first = w.last === ''
        if (state !== w.last) {
          w.last = state
          touched = true
          const done = task?.status === 'completed' || task?.status === 'cancelled'
          // the first look only records where things stand (it was just acted on)
          if (!first && (need || done)) {
            const u: TalkUpdate = {
              kind: need ? need.kind : task?.status === 'completed' ? 'done' : 'cancelled',
              project: w.project,
              projectName: w.projectName,
              cid: w.cid,
              taskId: w.taskId,
              title: task?.title ?? w.title,
              itemId: need?.kind === 'request' ? need.id : null,
              from: need?.from ?? task?.assignee ?? null,
              path: need?.href ?? task?.href ?? `/tasks?task=${w.taskId}`
            }
            c.turns.push(this.turn('orcha', updateText(u, need?.title), { update: u }))
            c.updatedAt = this.deps.now().toISOString()
          }
        }
        if (task?.status === 'completed' || task?.status === 'cancelled') continue // nothing more to follow
        keep.push(w)
      }
      if (touched) {
        c.watching = keep
        await this.deps.store.put(c)
        changed.push(c.id)
      }
    }
    return changed
  }
}

export function updateText(u: TalkUpdate, needTitle?: string): string {
  const who = u.from ?? 'The agent'
  switch (u.kind) {
    case 'plan':
      return `${who} has a plan for “${u.title}” in ${u.projectName}. Approve it, or tell me what to change?`
    case 'verify':
      return `${who} finished “${u.title}” in ${u.projectName} and it's waiting on your check. Accept it, or send it back?`
    case 'request':
      return `${who} has a question about “${u.title}” in ${u.projectName}: ${needTitle ?? 'it needs your answer'}`
    case 'done':
      return `“${u.title}” in ${u.projectName} is complete.`
    case 'cancelled':
      return `“${u.title}” in ${u.projectName} was cancelled.`
  }
}
