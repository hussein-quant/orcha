/** Talk to Orcha (GH-409): what the master chat shows besides words — in Verdikt's language.
 *   SourceChips   what a reply talks about; each opens it in its project
 *   ActionCard    a proposed action: kicker · title · the full draft (editable) · status · Confirm/Cancel
 *   AgentCards    agents at a glance: state, task, what they wait on; open their chat / runs
 *   UpdateCard    work the chat started came back: it needs you (one-click answer) or it's done
 *   ProjectBoard  a new chat opens on every project at a glance */
import { useState, type ReactNode } from 'react'
import {
  Activity,
  ArrowUpRight,
  Bot,
  Check,
  CheckCheck,
  CircleSlash,
  ClipboardList,
  FolderKanban,
  ListChecks,
  ListTodo,
  MessageCircleQuestion,
  PanelsTopLeft,
  Pencil,
  PartyPopper,
  Sparkles,
  UserPlus,
  MessageSquareText,
  MessagesSquare,
  Workflow,
  X
} from 'lucide-react'
import type { TalkAgent, TalkLink, TalkProjectOption, TalkProposal, TalkUpdate } from '../../../shared/talk'
import { cn } from '../ui/cn'
import { ProjectIcon } from '../ui/ProjectIcon'
import type { TalkPhase } from './session'

type Open = (link: Pick<TalkLink, 'project' | 'cid' | 'path'>) => void

const KIND_ICON = {
  project: FolderKanban,
  task: ListChecks,
  plan: ClipboardList,
  verify: CheckCheck,
  request: MessageCircleQuestion,
  workflow: Workflow,
  agent: Bot,
  page: PanelsTopLeft
} as const

export { KIND_ICON }

export function SourceChips({ links, projects, onOpen }: { links: TalkLink[]; projects?: Map<string, TalkProjectOption>; onOpen: Open }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-text-3">Linked · {links.length}</div>
      <div className="flex flex-wrap gap-1.5">
        {links.map((l, i) => {
          const Icon = KIND_ICON[l.kind] ?? ListChecks
          return (
            <button
              key={`${l.project}${l.path}`}
              type="button"
              onClick={() => onOpen(l)}
              title={`Open in ${l.projectName}`}
              style={{ ['--i' as string]: i }}
              className="talk-chip-in group/chip inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md border border-border bg-bg/60 px-2 text-[12.5px] text-text-2 transition-colors hover:border-border-strong hover:bg-hover hover:text-text"
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-text-3 group-hover/chip:text-text-2" />
              <span className="min-w-0 truncate">{l.kind === 'project' ? l.projectName : l.label}</span>
              {l.kind !== 'project' && (
                <span className="flex shrink-0 items-center gap-1 text-text-3">
                  <ProjectIcon icon={projects?.get(l.project)?.icon} size={16} />
                  {l.projectName}
                </span>
              )}
              <ArrowUpRight className="h-3 w-3 shrink-0 text-text-3 opacity-0 transition-opacity group-hover/chip:opacity-100" />
            </button>
          )
        })}
      </div>
    </div>
  )
}

const STATUS_WORD: Record<string, string> = { working: 'Working', idle: 'Idle', awaiting_request: 'Waiting on a reply', paused: 'Paused', blocked: 'Blocked' }
const NEED_WORD: Partial<Record<TalkLink['kind'], string>> = { plan: 'Plan to approve', verify: 'Work to check', request: 'Question for you' }

/** The agents a reply is about, one row each. Chat and Runs open beside the chat. */
export function AgentCards({ agents, projects, onOpen }: { agents: TalkAgent[]; projects?: Map<string, TalkProjectOption>; onOpen: Open }) {
  const page = (a: TalkAgent, tab: 'conversation' | 'runs'): TalkLink => ({
    project: a.project,
    projectName: a.projectName,
    cid: a.cid,
    label: tab === 'runs' ? `${a.alias} · Runs` : a.alias,
    path: `/agents?agent=${encodeURIComponent(a.alias)}&tab=${tab}`,
    kind: 'agent'
  })
  return (
    <div className="talk-rise overflow-hidden rounded-xl border border-border bg-raised/70">
      {agents.map((a, i) => {
        const pill = a.needsCount ? (
          <Pill tone="warn">Needs you{a.needsCount > 1 ? ` · ${a.needsCount}` : ''}</Pill>
        ) : (
          <Pill tone={a.status === 'working' ? 'ok' : 'muted'}>{STATUS_WORD[a.status] ?? a.status.replace(/_/g, ' ')}</Pill>
        )
        return (
          <div key={`${a.project}:${a.cid}:${a.alias}`} className={cn('px-3.5 py-3', i > 0 && 'border-t border-border')}>
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-hover text-text-2">
                <Bot className="h-3.5 w-3.5" strokeWidth={1.75} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
                  <span className="truncate font-semibold text-text">{a.alias}</span>
                  <span className="flex shrink-0 items-center gap-1 text-[12px] text-text-3">
                    <ProjectIcon icon={projects?.get(`${a.project}:${a.cid}`)?.icon} size={16} />
                    {a.projectName}
                  </span>
                </div>
                {a.role && <div className="truncate text-[12px] text-text-3" title={a.role}>{a.role}</div>}
              </div>
              {pill}
            </div>
            <div className="mt-2 space-y-1 pl-[2.375rem]">
              {a.needs && (
                <button type="button" onClick={() => onOpen(a.needs as TalkLink)} className="flex w-full min-w-0 items-center gap-1.5 text-left text-[12.5px] hover:underline">
                  <span className="shrink-0 text-warning">{NEED_WORD[a.needs.kind] ?? 'Needs you'}</span>
                  <span className="min-w-0 truncate text-text-2">{a.needs.label}</span>
                </button>
              )}
              {a.task && a.task.path !== a.needs?.path && (
                <button type="button" onClick={() => onOpen(a.task as TalkLink)} className="flex w-full min-w-0 items-center gap-1.5 text-left text-[12.5px] text-text-2 hover:underline">
                  <ListChecks className="h-3.5 w-3.5 shrink-0 text-text-3" strokeWidth={1.75} />
                  <span className="min-w-0 truncate">{a.task.label}</span>
                </button>
              )}
              {!a.task && !a.needs && <div className="text-[12.5px] text-text-3">Not on a task</div>}
              <div className="flex gap-1.5 pt-1">
                <AgentBtn onClick={() => onOpen(page(a, 'conversation'))} icon={<MessagesSquare className="h-3.5 w-3.5" strokeWidth={1.75} />}>
                  Chat
                </AgentBtn>
                <AgentBtn onClick={() => onOpen(page(a, 'runs'))} icon={<Activity className="h-3.5 w-3.5" strokeWidth={1.75} />}>
                  Runs
                </AgentBtn>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function AgentBtn({ onClick, icon, children }: { onClick(): void; icon: ReactNode; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-[12px] text-text-2 hover:bg-hover hover:text-text"
    >
      {icon}
      {children}
    </button>
  )
}

function Pill({ tone, children }: { tone: 'live' | 'ok' | 'bad' | 'muted' | 'warn'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium',
        tone === 'live' && 'bg-accent/15 text-accent',
        tone === 'ok' && 'bg-ok/15 text-ok',
        tone === 'bad' && 'bg-danger/12 text-danger',
        tone === 'warn' && 'bg-warning/15 text-warning',
        tone === 'muted' && 'bg-hover text-text-3'
      )}
    >
      {children}
    </span>
  )
}

function CardLink({ onClick, children }: { onClick(): void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-0.5 text-[12px] font-medium text-accent hover:underline">
      {children}
      <ArrowUpRight className="h-3 w-3" />
    </button>
  )
}

function Shell({ tone, children, glow }: { tone: 'live' | 'ok' | 'bad' | 'muted' | 'warn'; children: ReactNode; glow?: boolean }) {
  return (
    <article
      className={cn(
        'talk-rise talk-card relative overflow-hidden rounded-xl border bg-raised/70',
        tone === 'live' && 'border-accent/45',
        tone === 'ok' && 'border-ok/40',
        tone === 'bad' && 'border-danger/40',
        tone === 'warn' && 'border-warning/40',
        tone === 'muted' && 'border-border',
        glow && 'talk-done-glow'
      )}
    >
      {tone === 'live' && <div className="talk-card-sheen" aria-hidden="true" />}
      {children}
    </article>
  )
}

function Header({ icon, tone, kicker, title, pill }: { icon: ReactNode; tone: string; kicker: string; title: string; pill: ReactNode }) {
  return (
    <header className="flex items-start gap-3 px-4 pt-3.5">
      <div className={cn('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', tone)}>{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[10.5px] font-medium uppercase tracking-[0.06em] text-text-3">{kicker}</div>
        <div className="mt-0.5 text-[14px] font-semibold leading-5 text-text">{title}</div>
      </div>
      {pill}
    </header>
  )
}

const ACTION: Record<string, { label: string; icon: typeof ListChecks }> = {
  approve_plan: { label: 'Approve plan', icon: ClipboardList },
  reject_plan: { label: 'Send plan back', icon: ClipboardList },
  accept: { label: 'Accept work', icon: CheckCheck },
  send_back: { label: 'Send work back', icon: CheckCheck },
  answer: { label: 'Answer', icon: MessageCircleQuestion },
  create_task: { label: 'Create task', icon: Sparkles },
  assign_task: { label: 'Assign', icon: UserPlus },
  post_message: { label: 'Message', icon: MessageSquareText },
  message_agent: { label: 'Chat with agent', icon: MessagesSquare }
}

/** What each action writes, as the owner sees and edits it before it runs. */
const DRAFT: Record<string, { key: string; label: string; long?: boolean }[]> = {
  create_task: [
    { key: 'title', label: 'Title' },
    { key: 'description', label: 'Details', long: true },
    { key: 'definition_of_done', label: 'Done when', long: true },
    { key: 'assignee', label: 'Agent' }
  ],
  approve_plan: [{ key: 'text', label: 'Note', long: true }],
  accept: [{ key: 'text', label: 'Note', long: true }],
  reject_plan: [{ key: 'text', label: 'What should change', long: true }],
  send_back: [{ key: 'text', label: 'What to fix', long: true }],
  answer: [{ key: 'text', label: 'Answer', long: true }],
  post_message: [{ key: 'text', label: 'Message', long: true }],
  assign_task: [{ key: 'assignee', label: 'Agent' }],
  message_agent: [{ key: 'text', label: 'Message', long: true }]
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function Draft({ p }: { p: TalkProposal }) {
  const rows = (DRAFT[p.action] ?? []).filter((f) => str(p.args?.[f.key]).trim() && !(f.key === 'title' && str(p.args?.title) === p.title))
  if (!p.args) {
    // a proposal from before drafts were kept: what the project wrote back
    return p.action === 'create_task' && p.text ? (
      <p className="mt-2 whitespace-pre-wrap border-l-2 border-border pl-3 text-[12.5px] leading-5 text-text-3">{p.text}</p>
    ) : null
  }
  if (!rows.length) return null
  return (
    <dl className="mt-2.5 grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2 border-l-2 border-border pl-3 text-[12.5px] leading-5">
      {rows.map((f) => (
        <div key={f.key} className="contents">
          <dt className="text-text-3">{f.label}</dt>
          <dd className="min-w-0 whitespace-pre-wrap break-words text-text-2">{str(p.args?.[f.key])}</dd>
        </div>
      ))}
    </dl>
  )
}

function DraftEditor({ p, onSave, onDiscard }: { p: TalkProposal; onSave(args: Record<string, unknown>): void; onDiscard(): void }) {
  const fields = DRAFT[p.action] ?? []
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, str(p.args?.[f.key])])))
  const save = (): void => {
    const args: Record<string, unknown> = { ...p.args }
    for (const f of fields) {
      const v = values[f.key]?.trim() ?? ''
      if (v) args[f.key] = v
      else delete args[f.key]
    }
    onSave(args)
  }
  const box = 'w-full rounded-lg border border-border bg-bg/70 px-2.5 py-1.5 text-[12.5px] leading-5 text-text outline-none focus:border-accent/60'
  return (
    <div
      className="mt-2.5 space-y-2.5"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDiscard()
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
      }}
    >
      {fields.map((f, i) => (
        <label key={f.key} className="block">
          <span className="mb-1 block text-[11.5px] text-text-3">{f.label}</span>
          {f.long ? (
            <textarea
              autoFocus={i === 0}
              value={values[f.key]}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              className={cn(box, 'max-h-64 min-h-[3.5rem] resize-none [field-sizing:content]')}
            />
          ) : (
            <input
              autoFocus={i === 0}
              value={values[f.key]}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              className={cn(box, 'h-8')}
            />
          )}
        </label>
      ))}
      <div className="flex items-center gap-2">
        <span className="text-[11.5px] text-text-3">⌘↩ to update · Esc to discard</span>
        <button type="button" onClick={onDiscard} className="ml-auto h-8 rounded-lg border border-border px-3 text-[12.5px] text-text hover:bg-hover">
          Discard
        </button>
        <button type="button" onClick={save} className="h-8 rounded-lg bg-accent px-3.5 text-[12.5px] font-semibold text-bg hover:bg-accent-hover">
          Update draft
        </button>
      </div>
    </div>
  )
}

export function ActionCard({
  p,
  live,
  phase,
  undoLeft,
  undoTotal,
  confirmPhrase,
  onOpen,
  onConfirm,
  onCancel,
  onRevise
}: {
  p: TalkProposal
  live: boolean
  phase: TalkPhase
  undoLeft: number | null
  undoTotal: number
  confirmPhrase: string
  onOpen: Open
  onConfirm(): void
  onCancel(): void
  /** the owner edited the draft: the project checks it again and a fresh card replaces this one */
  onRevise(args: Record<string, unknown>): void
}) {
  const [editing, setEditing] = useState(false)
  const a = ACTION[p.action] ?? { label: p.action, icon: Sparkles }
  const counting = live && phase === 'undo'
  const tone = p.status === 'done' ? 'ok' : p.status === 'failed' ? 'bad' : live ? 'live' : 'muted'
  const pill =
    p.status === 'done' ? (
      <Pill tone="ok">
        <Check className="talk-check mr-0.5 inline h-3 w-3" />
        Done
      </Pill>
    ) : p.status === 'failed' ? (
      <Pill tone="bad">Didn’t go through</Pill>
    ) : p.status === 'declined' ? (
      <Pill tone="muted">{p.outcome === 'replaced' ? 'Changed' : 'Cancelled'}</Pill>
    ) : counting ? (
      <Pill tone="live">Confirmed</Pill>
    ) : phase === 'acting' && live ? (
      <Pill tone="live">Running…</Pill>
    ) : (
      <Pill tone="warn">Needs your OK</Pill>
    )
  const Icon = a.icon
  return (
    <Shell tone={tone} glow={p.status === 'done'}>
      <Header
        icon={<Icon className="h-3.5 w-3.5" />}
        tone={tone === 'ok' ? 'bg-ok/15 text-ok' : tone === 'bad' ? 'bg-danger/12 text-danger' : 'bg-accent/15 text-accent'}
        kicker={`${a.label} · ${p.projectName}`}
        title={p.title}
        pill={pill}
      />
      <div className="px-4 pb-3.5 pl-[3.25rem]">
        <p className="mt-1 text-[13px] leading-5 text-text-2">{p.read_back}</p>
        {editing && live && p.status === 'pending' ? (
          <DraftEditor
            p={p}
            onDiscard={() => setEditing(false)}
            onSave={(args) => {
              setEditing(false)
              onRevise(args)
            }}
          />
        ) : (
          <Draft p={p} />
        )}
        {p.status === 'failed' && p.outcome && <p className="mt-1.5 text-[12.5px] text-danger">{p.outcome}</p>}
        {p.sensitive.length > 0 && p.status === 'pending' && (
          <p className="mt-1.5 text-[12px] text-warning">Touches {p.sensitive.slice(0, 3).join(', ')} — say “{confirmPhrase}” or press Confirm.</p>
        )}
        {counting && (
          <div className="mt-3">
            <div className="h-1 w-full overflow-hidden rounded-full bg-hover">
              <div
                className="talk-undo-bar h-full rounded-full bg-accent"
                style={{ animationDuration: `${undoTotal}s` }}
              />
            </div>
            <div className="mt-2 flex items-center gap-3">
              <span className="text-[12px] text-text-3">Doing it in {undoLeft ?? 0} s — say “cancel” to stop</span>
              <button type="button" onClick={onCancel} className="ml-auto h-7 rounded-md border border-border px-3 text-[12.5px] text-text hover:bg-hover">
                Undo
              </button>
            </div>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          {p.item_kind === 'agent' ? (
            <CardLink onClick={() => onOpen({ project: p.project, cid: p.cid, path: `/agents?agent=${encodeURIComponent(p.title)}&tab=conversation` })}>
              Open {p.title}'s chat
            </CardLink>
          ) : (
            p.item_id &&
            p.item_kind !== 'request' && (
              <CardLink onClick={() => onOpen({ project: p.project, cid: p.cid, path: `/tasks?task=${p.item_id}` })}>Open task</CardLink>
            )
          )}
          <CardLink onClick={() => onOpen({ project: p.project, cid: p.cid, path: '/' })}>Open {p.projectName}</CardLink>
          {live && !counting && phase !== 'acting' && !editing && (
            <div className="ml-auto flex gap-2">
              {p.args && DRAFT[p.action] && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-border px-3 text-[12.5px] text-text hover:bg-hover"
                >
                  <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                  Edit
                </button>
              )}
              <button type="button" onClick={onCancel} className="inline-flex h-8 items-center gap-1 rounded-lg border border-border px-3 text-[12.5px] text-text hover:bg-hover">
                <X className="h-3.5 w-3.5" />
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                className="talk-confirm inline-flex h-8 items-center gap-1 rounded-lg bg-accent px-3.5 text-[12.5px] font-semibold text-bg hover:bg-accent-hover"
              >
                <Check className="h-3.5 w-3.5" />
                Confirm
              </button>
            </div>
          )}
        </div>
      </div>
    </Shell>
  )
}

export function UpdateCard({
  u,
  onOpen,
  onQuick,
  onReply
}: {
  u: TalkUpdate
  onOpen: Open
  onQuick(action: string, args: Record<string, unknown>): void
  /** put a starter in the input ("Send it back because…") */
  onReply(text: string): void
}) {
  const meta = {
    plan: { kicker: 'Plan to approve', icon: ClipboardList, tone: 'warn' as const, pill: 'Needs you' },
    verify: { kicker: 'Ready for your check', icon: CheckCheck, tone: 'warn' as const, pill: 'Needs you' },
    request: { kicker: 'Question for you', icon: MessageCircleQuestion, tone: 'warn' as const, pill: 'Needs you' },
    done: { kicker: 'Complete', icon: PartyPopper, tone: 'ok' as const, pill: 'Done' },
    cancelled: { kicker: 'Cancelled', icon: CircleSlash, tone: 'muted' as const, pill: 'Cancelled' }
  }[u.kind]
  const Icon = meta.icon
  return (
    <Shell tone={meta.tone} glow={u.kind === 'done'}>
      <Header
        icon={<Icon className="h-3.5 w-3.5" />}
        tone={meta.tone === 'ok' ? 'bg-ok/15 text-ok' : meta.tone === 'warn' ? 'bg-warning/15 text-warning' : 'bg-hover text-text-3'}
        kicker={`${meta.kicker} · ${u.projectName}`}
        title={u.title}
        pill={<Pill tone={meta.tone}>{meta.pill}</Pill>}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pb-3.5 pl-[3.25rem] pt-2">
        {u.from && <span className="text-[12px] text-text-3">from {u.from}</span>}
        <CardLink onClick={() => onOpen(u)}>{u.kind === 'request' ? 'Open question' : 'Open task'}</CardLink>
        <div className="ml-auto flex gap-2">
          {u.kind === 'plan' && (
            <>
              <QuickBtn onClick={() => onReply(`Send back the plan for “${u.title}” in ${u.projectName}: `)}>Change it</QuickBtn>
              <QuickBtn primary onClick={() => onQuick('approve_plan', { task: u.taskId })}>Approve</QuickBtn>
            </>
          )}
          {u.kind === 'verify' && (
            <>
              <QuickBtn onClick={() => onReply(`Send “${u.title}” in ${u.projectName} back: `)}>Send back</QuickBtn>
              <QuickBtn primary onClick={() => onQuick('accept', { task: u.taskId })}>Accept</QuickBtn>
            </>
          )}
          {u.kind === 'request' && <QuickBtn primary onClick={() => onReply(`Answer ${u.from ?? 'the agent'} on “${u.title}” in ${u.projectName}: `)}>Answer</QuickBtn>}
        </div>
      </div>
    </Shell>
  )
}

function QuickBtn({ primary, onClick, children }: { primary?: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center rounded-lg px-3 text-[12.5px]',
        primary ? 'bg-accent font-semibold text-bg hover:bg-accent-hover' : 'border border-border text-text hover:bg-hover'
      )}
    >
      {children}
    </button>
  )
}

export function ProjectBoard({
  projects,
  onAsk,
  onOpen
}: {
  projects: TalkProjectOption[]
  onAsk(text: string): void
  onOpen: Open
}) {
  if (!projects.length) return null
  const total = projects.reduce((n, p) => n + p.needsYou, 0)
  const busy = projects.reduce((n, p) => n + (p.working ?? 0), 0)
  return (
    <div className="w-full">
      <div className="mb-2.5 flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-text-3">
        <span>Across the board</span>
        <span className="h-px flex-1 bg-border" />
        <span className={cn(total > 0 && 'text-warning')}>{total ? `${total} need you` : 'all clear'}</span>
        {busy > 0 && <span>· {busy} agents working</span>}
      </div>
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3">
        {projects.map((p, i) => (
          <div
            key={p.key}
            style={{ ['--i' as string]: i }}
            className="talk-tile group relative flex flex-col gap-2.5 overflow-hidden rounded-xl border border-border bg-raised/55 px-3.5 py-3 text-left backdrop-blur"
          >
            <div className="flex items-center gap-2.5">
              <ProjectIcon icon={p.icon} size={20} />
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text">{p.name}</span>
              {p.needsYou > 0 && <Pill tone="warn">{p.needsYou} need you</Pill>}
            </div>
            <div className="flex items-center gap-3 text-[11.5px] text-text-3">
              <span className="flex items-center gap-1" title="Open tasks">
                <ListTodo className="h-3.5 w-3.5" />
                {p.openTasks ?? 0}
              </span>
              <span className="flex items-center gap-1" title={`${p.working ?? 0} of ${p.agents ?? 0} agents working`}>
                <Bot className="h-3.5 w-3.5" />
                {p.agents ?? 0}
                {(p.working ?? 0) > 0 && <span className="talk-live-dot" aria-hidden="true" />}
              </span>
              <span className="ml-auto flex items-center gap-1 opacity-70 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-text-2 hover:bg-hover hover:text-text"
                  onClick={() => onAsk(`Catch me up on ${p.name}.`)}
                >
                  <Sparkles className="h-3 w-3" />
                  Catch up
                </button>
                <button
                  type="button"
                  aria-label={`Open ${p.name}`}
                  title={`Open ${p.name}`}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-2 hover:bg-hover hover:text-text"
                  onClick={() => onOpen({ project: p.stack, cid: p.cid, path: '/' })}
                >
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
