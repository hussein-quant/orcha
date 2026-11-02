/** Talk to Orcha (GH-409): the master chat — one place to run every project, typed or spoken.
 *
 *  Left: every chat, grouped by date, with full-text search across all of them (a hit opens the
 *  chat at that message). Right: the conversation — day dividers and message times so the owner
 *  can go back; Orcha's words reveal as they land beside a small orb, theirs in blue bubbles;
 *  Verdikt-style cards (links that open, actions to confirm, work that came back). A new chat
 *  opens on a cinematic hero: the orb, starters and every project at a glance. Voice lives only
 *  here: the orb sits above the composer and waits for the owner to speak. */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  ChevronRight,
  AudioLines,
  Bot,
  Loader2,
  Inbox,
  ListPlus,
  MessagesSquare,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  ScanSearch,
  Search,
  SquarePen,
  Sunrise,
  Trash2,
  Users,
  X
} from 'lucide-react'
import type { TalkLink, TalkMention, TalkProjectOption, TalkProposal, TalkSearchHit, TalkSummary, TalkTurn } from '../../../shared/talk'
import { cn } from '../ui/cn'
import { ProjectIcon } from '../ui/ProjectIcon'
import { ActionCard, AgentCards, KIND_ICON, ProjectBoard, SourceChips, UpdateCard } from './cards'
import { dropQuery, matchTags, mentionAt, pillKey, type TagOption } from './mentions'
import { dayLabel, fullWhen, groupBy, groupLabel, sameDay, shortWhen, timeLabel } from './dates'
import { Orb, type OrbMode } from './Orb'
import { ScopeMenu } from './ScopeMenu'
import { HOTKEY_LABEL, useTalkPrefs } from './prefs'
import type { TalkPhase, TalkSession, TalkState } from './session'
import './talk.css'

const PHASE_TEXT: Record<TalkPhase, string> = {
  idle: 'Hold Space to talk',
  listening: 'Listening — take your time',
  hearing: 'Listening… let go of Space when you’re done',
  transcribing: 'Got it…',
  thinking: 'Thinking',
  speaking: 'Speaking — tap the orb to interrupt',
  undo: 'Say “cancel” to stop it',
  acting: 'Doing it…'
}

const STARTERS = [
  {
    icon: Inbox,
    text: 'What needs me right now?',
    hint: 'Plans, checks and questions waiting on you'
  },
  {
    icon: Users,
    text: 'What is everyone working on?',
    hint: 'Every agent, across your projects'
  },
  {
    icon: ListPlus,
    text: 'Help me plan a new task',
    hint: 'Describe it — Orcha writes it up'
  },
  {
    icon: Sunrise,
    text: 'Catch me up on today',
    hint: 'What moved, what finished, what’s stuck'
  }
]

type Open = (link: Pick<TalkLink, 'project' | 'cid' | 'path'>) => void

function orbMode(phase: TalkPhase): OrbMode {
  if (phase === 'listening' || phase === 'hearing') return 'listening'
  if (phase === 'speaking') return 'speaking'
  if (phase === 'thinking' || phase === 'transcribing' || phase === 'acting') return 'thinking'
  return 'idle'
}

function startedLabel(iso: string): string {
  const d = dayLabel(iso)
  return d === 'Today' || d === 'Yesterday' ? d.toLowerCase() : d
}

function greeting(): string {
  const h = new Date().getHours()
  return h < 5 ? 'Working late?' : h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.'
}

/** A chat's icon, as the app draws icons: its project's own icon when it covers one project,
 *  else a plain chat glyph. */
function ChatIcon({ scope, icons }: { scope: string | null | undefined; icons: Map<string, TalkProjectOption> }) {
  const p = scope ? icons.get(scope) : undefined
  if (p) return <ProjectIcon icon={p.icon} size={16} />
  return <MessagesSquare className="h-4 w-4 shrink-0 text-text-3" strokeWidth={1.75} aria-hidden="true" />
}

/** Search snippet: \u0001…\u0002 marks a match. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\u0001[^\u0002]*\u0002)/)
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('\u0001') ? (
          <mark key={i} className="talk-mark">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        )
      )}
    </>
  )
}

/** Orcha's words: paragraphs and "- " lists; a reply that just landed reveals word by word. */
function RichText({ text, reveal }: { text: string; reveal: boolean }) {
  const blocks = useMemo(() => {
    const out: { list: boolean; lines: string[] }[] = []
    for (const raw of text.split('\n')) {
      const line = raw.trimEnd()
      const isItem = /^\s*[-•]\s+/.test(line)
      if (!line.trim()) {
        out.push({ list: false, lines: [] })
        continue
      }
      const last = out[out.length - 1]
      if (last && last.list === isItem && (isItem || last.lines.length)) last.lines.push(line.replace(/^\s*[-•]\s+/, ''))
      else out.push({ list: isItem, lines: [line.replace(/^\s*[-•]\s+/, '')] })
    }
    return out.filter((b) => b.lines.length)
  }, [text])
  const total = useMemo(() => text.split(/\s+/).length, [text])
  const step = Math.min(32, 1400 / Math.max(1, total))
  let n = 0
  const words = (s: string): ReactNode =>
    reveal
      ? s.split(/(\s+)/).map((w, i) =>
          /^\s+$/.test(w) || !w ? (
            w
          ) : (
            <span key={i} className="talk-word" style={{ animationDelay: `${Math.round(n++ * step)}ms` }}>
              {w}
            </span>
          )
        )
      : s
  return (
    <div className="flex flex-col gap-2.5">
      {blocks.map((b, i) =>
        b.list ? (
          <ul key={i} className="flex flex-col gap-1.5">
            {b.lines.map((l, j) => (
              <li key={j} className="talk-li relative pl-5">
                {words(l)}
              </li>
            ))}
          </ul>
        ) : (
          <p key={i} className="whitespace-pre-wrap">
            {words(b.lines.join('\n'))}
          </p>
        )
      )}
    </div>
  )
}

export default function TalkView({
  session,
  onOpenLink,
  onClose,
  currentProject
}: {
  session: TalkSession
  onOpenLink: Open
  onClose(): void
  /** the project open on screen ("<stack>:<cid>"), offered as a chat scope */
  currentProject: string | null
}) {
  const s = useSyncExternalStore(session.subscribe, session.getState)
  const [prefs] = useTalkPrefs()
  const [draft, setDraft] = useState('')
  // @-tagging: the pills picked so far, and the open menu (where the "@" is, the matches, which is active)
  const [pills, setPills] = useState<TalkMention[]>([])
  const [tagMenu, setTagMenu] = useState<{ start: number; items: TagOption[]; active: number } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<TalkSearchHit[] | null>(null)
  const [focusTurn, setFocusTurn] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  atBottomRef.current = atBottom
  const [listOpen, setListOpen] = useListOpen()
  // the side panel: what Orcha links to opens beside the chat, never navigating away
  const [peek, setPeek] = useState<Pick<TalkLink, 'project' | 'cid' | 'path'> & Partial<Pick<TalkLink, 'label' | 'kind'>> | null>(null)
  const openPeek = useCallback((l: Pick<TalkLink, 'project' | 'cid' | 'path'> & Partial<TalkLink>) => setPeek(l), [])
  const showList = listOpen
  const scroller = useRef<HTMLDivElement | null>(null)
  const input = useRef<HTMLTextAreaElement | null>(null)
  const search = useRef<HTMLInputElement | null>(null)
  const turns = useMemo(() => s.conv?.turns ?? [], [s.conv?.turns])
  const pending = session.pendingProposal()
  const working = s.phase === 'thinking' || s.phase === 'acting' || s.phase === 'transcribing'

  // replies that land while the chat is open reveal word by word; history just appears
  const seen = useRef<{
    conv: string | null
    ids: Set<string>
    fresh: Set<string>
  }>({ conv: null, ids: new Set(), fresh: new Set() })
  if (seen.current.conv !== (s.conv?.id ?? null))
    seen.current = {
      conv: s.conv?.id ?? null,
      ids: new Set(turns.map((t) => t.id)),
      fresh: new Set()
    }
  for (const t of turns)
    if (!seen.current.ids.has(t.id)) {
      seen.current.ids.add(t.id)
      if (t.who === 'orcha') seen.current.fresh.add(t.id)
    }

  useEffect(() => {
    void session.refresh()
  }, [session])
  useEffect(() => {
    session.setOpener(openPeek)
    return () => session.setOpener(null)
  }, [session, openPeek])
  useEffect(() => {
    if (!peek) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="menu"]')) setPeek(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [peek])
  useEffect(() => {
    if (focusTurn) return // going to a search hit, not the end
    const el = scroller.current
    el?.scrollTo({
      top: el.scrollHeight,
      behavior: turns.length > 0 && seen.current.fresh.size ? 'smooth' : 'auto'
    })
  }, [turns.length, s.phase, s.conv?.id, focusTurn])
  // the column narrows when the side panel opens: stay pinned to the latest message
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    if (!focusTurn) return
    const el = scroller.current?.querySelector(`[data-turn-id="${CSS.escape(focusTurn)}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setFlash(focusTurn)
    setFocusTurn(null)
    const t = window.setTimeout(() => setFlash(null), 2200)
    return () => window.clearTimeout(t)
  }, [focusTurn, turns])
  useEffect(() => {
    if (!s.voice && !query) input.current?.focus()
  }, [s.conv?.id, s.voice, query])
  useEffect(() => {
    const q = query.trim()
    if (!q) return setHits(null)
    const t = window.setTimeout(() => void session.search(q).then(setHits), 140)
    return () => window.clearTimeout(t)
  }, [query, session])
  // hold Space to talk (anywhere on this screen except while typing; in the empty composer too)
  const draftRef = useRef(draft)
  draftRef.current = draft
  useEffect(() => {
    let held = false
    const typing = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null
      if (!el || !el.tagName) return false
      if (el === input.current) return draftRef.current.length > 0
      return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(el.tagName) || !!el.closest('[role="menu"]')
    }
    const down = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return
      e.preventDefault()
      if (e.repeat || held) return
      held = true
      void session.holdStart()
    }
    const up = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || !held) return
      e.preventDefault()
      held = false
      session.holdEnd()
    }
    const blur = (): void => {
      if (held) {
        held = false
        session.holdEnd()
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      blur()
    }
  }, [session])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        search.current?.focus()
        search.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const now = useNow(s.phase === 'undo')
  const submit = (): void => {
    // pills alone ("@nyumba-connect @atlas") still ask something: about them
    const t = draft.trim() || pills.map((p) => `@${p.alias ?? byKey.get(p.project)?.name ?? 'project'}`).join(' ')
    if (!t) return
    setDraft('')
    setTagMenu(null)
    setPills([])
    void session.send(t, 'text', pills)
  }
  const findTag = (text: string, caret: number, picked = pills): void => {
    const at = mentionAt(text, caret)
    const items = at ? matchTags(s.projects, s.conv?.scope ?? null, at.query, picked) : []
    setTagMenu(at && items.length ? { start: at.start, items, active: 0 } : null)
  }
  const pickTag = (o: TagOption): void => {
    const el = input.current
    if (!el || !tagMenu) return
    const next = dropQuery(draft, el.selectionStart ?? draft.length, tagMenu.start)
    setDraft(next.text)
    setPills((m) => [...m, o.alias ? { project: o.project, alias: o.alias } : { project: o.project }])
    setTagMenu(null)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(next.caret, next.caret)
    })
  }
  const prefill = (text: string): void => {
    setDraft(text)
    requestAnimationFrame(() => {
      const el = input.current
      if (!el) return
      el.focus()
      el.setSelectionRange(text.length, text.length)
    })
  }
  const openHit = async (h: TalkSearchHit): Promise<void> => {
    await session.select(h.conversationId)
    setFocusTurn(h.turnId)
  }
  const scopeName = s.conv?.scope ? (s.projects.find((p) => p.key === s.conv?.scope)?.name ?? 'one project') : null
  const byKey = useMemo(() => new Map(s.projects.map((p) => [p.key, p])), [s.projects])
  const byStack = useMemo(() => new Map(s.projects.map((p) => [p.stack, p])), [s.projects])
  const groups = useMemo(() => groupBy(s.list, (c) => groupLabel(c.updatedAt)), [s.list])

  return (
    <div className="talk-stage absolute inset-0 z-20 flex bg-card outline-none animate-fade-in" data-testid="talk-view">
      {/* ------------------------------------------------------------ every chat */}
      {showList && (
        <aside className="talk-list relative z-10 flex w-[252px] shrink-0 flex-col border-r border-border bg-bg/55 backdrop-blur-xl">
          <div className="flex h-12 shrink-0 items-center gap-2.5 px-3.5">
            <Orb mode={s.voice ? orbMode(s.phase) : 'idle'} size={20} />
            <span className="text-[13.5px] font-semibold tracking-[-0.01em] text-text">Talk</span>
            <button
              type="button"
              aria-label="Hide chats"
              title="Hide chats"
              onClick={() => setListOpen(false)}
              className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label="New chat"
              title="New chat"
              onClick={() => {
                setQuery('')
                void session.newChat(prefs.newChatScope === 'current' ? currentProject : null)
              }}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-2 hover:bg-hover hover:text-text"
            >
              <SquarePen className="h-4 w-4" />
            </button>
          </div>
          <div className="px-3 pb-2">
            <label className="talk-search flex h-8 items-center gap-2 rounded-lg border border-border bg-bg/70 px-2.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-text-3" />
              <input
                ref={search}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setQuery('')
                  if (e.key === 'Enter' && hits?.[0]) void openHit(hits[0])
                }}
                placeholder="Search every chat"
                aria-label="Search every chat"
                className="min-w-0 flex-1 bg-transparent text-[12.5px] text-text outline-none placeholder:text-text-3"
              />
              {query ? (
                <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className="text-text-3 hover:text-text">
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : (
                <kbd className="talk-kbd">⌘F</kbd>
              )}
            </label>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {hits ? (
              <SearchResults hits={hits} query={query} onOpen={(h) => void openHit(h)} />
            ) : (
              <>
                {s.list.length === 0 && (
                  <div className="mx-1.5 mt-2 rounded-xl border border-dashed border-border px-3 py-4 text-center text-[12px] leading-5 text-text-3">
                    Your chats live here, by date — come back to any of them.
                  </div>
                )}
                {groups.map((g) => (
                  <section key={g.label} className="mb-2" aria-label={g.label}>
                    <h3 className="sticky top-0 z-[1] bg-bg/80 px-2 pb-1 pt-2.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-text-3 backdrop-blur">
                      {g.label}
                    </h3>
                    <ul className="flex flex-col gap-px">
                      {g.items.map((c) => (
                        <ChatRow
                          key={c.id}
                          c={c}
                          icons={byKey}
                          active={s.conv?.id === c.id}
                          confirming={confirmDelete === c.id}
                          onSelect={() => void session.select(c.id)}
                          onDelete={() => {
                            if (confirmDelete === c.id) {
                              setConfirmDelete(null)
                              void session.remove(c.id)
                            } else setConfirmDelete(c.id)
                          }}
                          onBlurDelete={() => setConfirmDelete(null)}
                        />
                      ))}
                    </ul>
                  </section>
                ))}
              </>
            )}
          </div>
        </aside>
      )}

      {/* ------------------------------------------------------------ the conversation */}
      <section className="relative z-10 flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border/60 px-4">
          {!showList && (
            <>
              <button
                type="button"
                aria-label="Show chats"
                title="Show chats"
                onClick={() => setListOpen(true)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text"
              >
                <PanelLeftOpen className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="New chat"
                title="New chat"
                onClick={() => void session.newChat(prefs.newChatScope === 'current' ? currentProject : null)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text"
              >
                <SquarePen className="h-4 w-4" />
              </button>
            </>
          )}
          {s.conv && turns.length > 0 && <ChatIcon scope={s.conv.scope} icons={byKey} />}
          <div className="min-w-0">
            <h1 className="truncate text-[13.5px] font-semibold tracking-[-0.01em] text-text">{s.conv?.title ?? 'New chat'}</h1>
            {s.conv && turns.length > 0 && (
              <div className="truncate text-[11px] text-text-3" title={fullWhen(s.conv.createdAt)}>
                Started {startedLabel(s.conv.createdAt)} · {turns.length} messages
              </div>
            )}
          </div>
          <div className="ml-auto" />
          <ScopeMenu value={s.conv?.scope ?? null} projects={s.projects} onChange={(scope) => void session.setScope(scope)} />
          <button
            type="button"
            aria-label="Close Talk"
            title="Close"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-3 hover:bg-hover hover:text-text"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {scopeName && (
          <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-bg/40 px-5 py-1.5 text-[12px] text-text-3">
            <span className="min-w-0 truncate">
              This chat covers only <span className="text-text-2">{scopeName}</span>.
            </span>
            <button
              type="button"
              onClick={() => void session.setScope(null)}
              className="ml-auto shrink-0 rounded-md px-2 py-0.5 font-medium text-text-2 hover:bg-hover hover:text-text"
            >
              Cover all projects
            </button>
          </div>
        )}
        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget
            setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 240)
          }}
          className="talk-scroll min-h-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto flex w-full max-w-[800px] flex-col px-6 pb-10 pt-4">
            {turns.length === 0 && (
              <Hero
                voice={s.voice}
                phase={s.phase}
                scopeName={scopeName}
                projects={s.projects}
                onAsk={(t) => void session.send(t, 'text')}
                onOpen={openPeek}
              />
            )}
            {turns.map((t, i) => (
              <Fragment key={t.id}>
                {(i === 0 || !sameDay(turns[i - 1].at, t.at)) && (
                  <div className="talk-day" role="separator" aria-label={dayLabel(t.at)} title={fullWhen(t.at)}>
                    <span>{dayLabel(t.at)}</span>
                  </div>
                )}
                <div className={cn('py-3', flash === t.id && 'talk-flash')} data-turn-id={t.id}>
                  <Turn
                    turn={t}
                    projects={byStack}
                    reveal={seen.current.fresh.has(t.id)}
                    live={!!pending && t.proposal === pending}
                    phase={s.phase}
                    undoLeft={s.undoUntil ? Math.max(0, Math.ceil((s.undoUntil - now) / 1000)) : null}
                    undoTotal={prefs.undoSeconds}
                    confirmPhrase={prefs.confirmPhrase}
                    onOpen={openPeek}
                    onConfirm={() => void session.confirm()}
                    onCancel={() => void session.cancel()}
                    onQuick={(u, action, args) => void session.quick(u.project, u.cid, action, args)}
                    onRevise={(p, args) => void session.quick(p.project, p.cid, p.action, args)}
                    onReply={prefill}
                  />
                </div>
              </Fragment>
            ))}
            {working && (
              <div className="flex items-center gap-3 py-3">
                <Orb mode="thinking" size={26} />
                <span className="talk-thinking text-[15px]" aria-live="polite">
                  {PHASE_TEXT[s.phase]}
                </span>
              </div>
            )}
          </div>
        </div>

        {!atBottom && turns.length > 0 && (
          <button
            type="button"
            onClick={() =>
              scroller.current?.scrollTo({
                top: scroller.current.scrollHeight,
                behavior: 'smooth'
              })
            }
            className="talk-rise absolute bottom-[132px] left-1/2 z-20 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-raised/95 px-3 text-[12px] text-text-2 shadow-lg backdrop-blur hover:text-text"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            Latest
          </button>
        )}

        {/* voice + composer */}
        <div className="shrink-0 px-6 pb-4">
          <div className="mx-auto flex w-full max-w-[800px] flex-col items-center gap-3">
            {s.voice && turns.length > 0 && (
              <div className="talk-rise flex flex-col items-center gap-2 pb-1">
                <button
                  type="button"
                  aria-label="Talk, interrupt, or finish speaking"
                  onClick={() => void session.tap()}
                  className="talk-aura rounded-full"
                >
                  <Orb mode={orbMode(s.phase)} size={88} />
                </button>
                <div className="h-4 text-[12px] text-text-3" aria-live="polite">
                  {PHASE_TEXT[s.phase]}
                </div>
              </div>
            )}
            {s.install && <VoiceSetup install={s.install} onInstall={() => void session.installVoice()} onClose={() => session.dismissInstall()} />}
            {s.error && (
              <div role="alert" className="talk-rise w-full rounded-xl border border-danger/40 bg-danger/10 px-3.5 py-2 text-[12.5px] text-danger">
                {s.error}
              </div>
            )}
            <form
              className="talk-input relative flex w-full items-end gap-1.5 rounded-[24px] border border-border bg-raised/90 py-1.5 pl-4 pr-1.5 backdrop-blur-xl"
              onSubmit={(e) => {
                e.preventDefault()
                submit()
              }}
            >
              {tagMenu && <TagMenu items={tagMenu.items} active={tagMenu.active} onPick={pickTag} onHover={(i) => setTagMenu((m) => m && { ...m, active: i })} />}
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {pills.map((t) => (
                <TagPill key={pillKey(t)} tag={t} projects={byKey} onRemove={() => setPills((m) => m.filter((x) => pillKey(x) !== pillKey(t)))} />
              ))}
              <textarea
                ref={input}
                rows={1}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value)
                  findTag(e.target.value, e.target.selectionStart ?? e.target.value.length)
                }}
                onBlur={() => setTagMenu(null)}
                onKeyDown={(e) => {
                  if (tagMenu && !e.nativeEvent.isComposing) {
                    const n = tagMenu.items.length
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault()
                      setTagMenu({ ...tagMenu, active: (tagMenu.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n })
                      return
                    }
                    if (e.key === 'Enter' || e.key === 'Tab') {
                      e.preventDefault()
                      pickTag(tagMenu.items[tagMenu.active])
                      return
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      e.stopPropagation()
                      setTagMenu(null)
                      return
                    }
                  }
                  // Backspace at the very start takes the last pill off
                  const el = e.currentTarget
                  if (e.key === 'Backspace' && pills.length && el.selectionStart === 0 && el.selectionEnd === 0) {
                    e.preventDefault()
                    setPills((m) => m.slice(0, -1))
                    return
                  }
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    submit()
                  }
                }}
                placeholder={
                  pills.length
                    ? pills.some((t) => t.alias)
                      ? 'Ask about them, or what to tell them'
                      : '@ to pick an agent, or ask about it'
                    : s.voice
                      ? 'Talk, or type here'
                      : scopeName
                        ? `Message Orcha about ${scopeName} — @ to tag`
                        : 'Message Orcha — @ to tag a project or agent'
                }
                aria-label="Message Orcha"
                data-dictation="off"
                className="max-h-48 min-h-[40px] min-w-[10rem] flex-1 resize-none bg-transparent py-2 text-[14.5px] leading-6 text-text outline-none placeholder:text-text-3"
                style={{ fieldSizing: 'content' } as React.CSSProperties}
              />
              </div>
              <button
                type="button"
                onClick={() => (s.voice ? session.stopVoice() : void session.startVoice())}
                aria-pressed={s.voice}
                title={s.voice ? 'End voice' : `Talk (${HOTKEY_LABEL[prefs.hotkey]})`}
                className={cn(
                  'mb-0.5 flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition-colors',
                  s.voice ? 'border border-border bg-hover text-text hover:bg-selected' : 'text-text-2 hover:bg-hover hover:text-text'
                )}
              >
                <AudioLines className="h-4 w-4" />
                {s.voice ? 'End voice' : 'Voice'}
              </button>
              <button
                type="submit"
                aria-label="Send"
                disabled={!draft.trim() && !pills.length}
                className="talk-send mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            </form>
            <div className="flex items-center gap-2 whitespace-nowrap text-[11px] text-text-3">
              <span className="flex items-center gap-1">
                Hold <kbd className="talk-kbd">Space</kbd> to talk
              </span>
              <span aria-hidden="true">·</span>
              <span className="flex items-center gap-1">
                <kbd className="talk-kbd">{HOTKEY_LABEL[prefs.hotkey]}</kbd> from any app
              </span>
              <span aria-hidden="true">·</span>
              <span>Nothing happens until you confirm</span>
            </div>
          </div>
        </div>
      </section>
      {peek && (
        <PeekPanel
          key={`${peek.project}${peek.path}`}
          link={peek}
          project={byStack.get(peek.project)}
          session={session}
          onClose={() => setPeek(null)}
          onOpenFull={() => onOpenLink(peek)}
        />
      )}
    </div>
  )
}

/** The side panel: the item's REAL project page (Embodent draws it here, chromeless) under a
 *  slim header — what it is, open it in the project, close. */
function PeekPanel({
  link,
  project,
  session,
  onClose,
  onOpenFull
}: {
  link: Pick<TalkLink, 'project' | 'cid' | 'path'> & Partial<Pick<TalkLink, 'label' | 'kind'>>
  project: TalkProjectOption | undefined
  session: TalkSession
  onClose(): void
  onOpenFull(): void
}) {
  const body = useRef<HTMLDivElement | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const el = body.current
    if (!el) return
    let raf = 0
    const place = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect()
        void session
          .peek({ project: link.project, cid: link.cid, path: link.path, rect: { x: r.left, y: r.top, width: r.width, height: r.height } })
          .then((ok) => setFailed(!ok))
      })
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(el)
    window.addEventListener('resize', place)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', place)
      void session.peek(null)
    }
  }, [session, link.project, link.cid, link.path])
  const KindIcon = KIND_ICON[link.kind ?? 'task'] ?? KIND_ICON.task
  return (
    <aside className="relative z-10 flex w-[44%] min-w-[380px] max-w-[720px] shrink-0 flex-col border-l border-border bg-bg" aria-label="Side panel">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <ProjectIcon icon={project?.icon} size={16} />
        <span className="shrink-0 text-[12.5px] text-text-3">{project?.name ?? 'Project'}</span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-3" />
        <KindIcon className="h-3.5 w-3.5 shrink-0 text-text-3" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-text">{link.label ?? (link.kind === 'project' ? 'Overview' : 'Task')}</span>
        <button
          type="button"
          onClick={onOpenFull}
          title={`Open in ${project?.name ?? 'the project'}`}
          aria-label={`Open in ${project?.name ?? 'the project'}`}
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text"
        >
          <ArrowUpRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          title="Close panel (Esc)"
          aria-label="Close panel"
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div ref={body} className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex items-center justify-center text-[12px] text-text-3">
          {failed ? `${project?.name ?? 'The project'} isn’t running — start it to see this here.` : 'Loading…'}
        </div>
      </div>
    </aside>
  )
}

function ChatRow({
  c,
  icons,
  active,
  confirming,
  onSelect,
  onDelete,
  onBlurDelete
}: {
  c: TalkSummary
  icons: Map<string, TalkProjectOption>
  active: boolean
  confirming: boolean
  onSelect(): void
  onDelete(): void
  onBlurDelete(): void
}) {
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'page' : undefined}
        title={fullWhen(c.updatedAt)}
        className={cn('talk-row flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left', active && 'talk-row-active')}
      >
        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
          <ChatIcon scope={c.scope} icons={icons} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text">{c.title}</span>
            <span className="shrink-0 text-[10.5px] tabular-nums text-text-3 group-hover:invisible">{shortWhen(c.updatedAt)}</span>
          </span>
          {c.preview && <span className="truncate text-[12px] text-text-3">{c.preview}</span>}
        </span>
      </button>
      <button
        type="button"
        aria-label={confirming ? 'Confirm delete' : 'Delete chat'}
        title={confirming ? 'Click again to delete' : 'Delete'}
        onClick={onDelete}
        onBlur={onBlurDelete}
        className={cn(
          'absolute right-1.5 top-2 hidden h-6 items-center justify-center rounded-md px-1.5 text-text-3 hover:bg-hover hover:text-danger group-hover:flex',
          confirming && 'flex text-danger'
        )}
      >
        {confirming ? <span className="text-[11px]">Delete?</span> : <Trash2 className="h-3.5 w-3.5" />}
      </button>
    </li>
  )
}

function SearchResults({ hits, query, onOpen }: { hits: TalkSearchHit[]; query: string; onOpen(h: TalkSearchHit): void }) {
  if (!hits.length) return <div className="px-3 py-6 text-center text-[12px] text-text-3">Nothing in your chats matches “{query.trim()}”.</div>
  return (
    <div className="flex flex-col gap-1 pt-1">
      <div className="px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-text-3">
        {hits.length === 40 ? '40+' : hits.length} {hits.length === 1 ? 'message' : 'messages'}
      </div>
      {hits.map((h, i) => (
        <button
          key={h.turnId}
          type="button"
          onClick={() => onOpen(h)}
          style={{ ['--i' as string]: Math.min(i, 12) }}
          className="talk-chip-in talk-row flex flex-col gap-1 rounded-xl px-2.5 py-2 text-left"
        >
          <span className="flex items-center gap-1.5 text-[11px] text-text-3">
            <span className={cn('talk-dot', h.who === 'you' && 'talk-dot-you')} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate font-medium text-text-2">{h.title}</span>
            <span className="shrink-0 tabular-nums" title={fullWhen(h.at)}>
              {shortWhen(h.at)}
            </span>
          </span>
          <span className="line-clamp-3 text-[12.5px] leading-[18px] text-text-2">
            <span className="text-text-3">{h.who === 'you' ? 'You: ' : 'Orcha: '}</span>
            <Snippet text={h.snippet} />
          </span>
        </button>
      ))}
    </div>
  )
}

function Hero({
  voice,
  phase,
  scopeName,
  projects,
  onAsk,
  onOpen
}: {
  voice: boolean
  phase: TalkPhase
  scopeName: string | null
  projects: Parameters<typeof ProjectBoard>[0]['projects']
  onAsk(text: string): void
  onOpen: Open
}) {
  return (
    <div className="talk-hero flex flex-col items-center gap-7 pt-[4vh] text-center">
      <div className="talk-aura talk-hero-orb">
        <Orb mode={voice ? orbMode(phase) : 'idle'} size={112} />
      </div>
      <div className="talk-rise">
        <h2 className="talk-hero-title text-[30px] font-semibold leading-tight tracking-[-0.025em]">{greeting()} What’s on your mind?</h2>
        <p className="mt-2 text-[13.5px] text-text-3">
          {scopeName
            ? `Ask about ${scopeName}, plan work, or decide — typing or talking.`
            : 'Every project in one conversation. Ask, plan, decide — typing or talking.'}
        </p>
      </div>
      <div className="grid w-full max-w-[640px] grid-cols-2 gap-2.5">
        {STARTERS.map(({ icon: Icon, text, hint }, i) => (
          <button
            key={text}
            type="button"
            style={{ ['--i' as string]: i }}
            onClick={() => onAsk(text)}
            className="talk-starter talk-chip-in group flex items-start gap-2.5 rounded-xl border border-border bg-raised/50 px-3 py-2.5 text-left backdrop-blur"
          >
            <Icon className="talk-starter-icon mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-text">{text}</span>
              <span className="block text-[11.5px] leading-4 text-text-3">{hint}</span>
            </span>
          </button>
        ))}
      </div>
      {!scopeName && (
        <div className="talk-rise w-full pt-3" style={{ animationDelay: '200ms' }}>
          <ProjectBoard projects={projects} onAsk={onAsk} onOpen={onOpen} />
        </div>
      )}
    </div>
  )
}

const LIST_KEY = 'orcha:talk:list'

/** The chat list: open by default on a wide window, then as the owner left it. */
function useListOpen(): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(LIST_KEY)
      if (v === '1' || v === '0') return v === '1'
    } catch {
      /* storage blocked */
    }
    return window.innerWidth >= 1280
  })
  return [
    open,
    (v) => {
      setOpen(v)
      try {
        localStorage.setItem(LIST_KEY, v ? '1' : '0')
      } catch {
        /* storage blocked: lasts for this session */
      }
    }
  ]
}

/** What Orcha read before answering: one quiet line (Linear-style), the full list on hover. */
function Looked({ items }: { items: NonNullable<TalkTurn['looked']> }) {
  const projects = [...new Set(items.map((i) => i.projectName))]
  const tabs = [...new Set(items.map((i) => i.label))]
  const all = items.map((i) => `${i.label} · ${i.projectName}`).join('\n')
  return (
    <div className="flex items-center gap-1.5 text-[12px] text-text-3" title={all}>
      <ScanSearch className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
      <span className="min-w-0 truncate">
        Looked at {tabs.slice(0, 3).join(', ')}
        {tabs.length > 3 ? ` +${tabs.length - 3}` : ''}
        {' in '}
        {projects.length === 1 ? projects[0] : `${projects.length} projects`}
      </span>
    </div>
  )
}

/** Voice needs a one-time setup: what it installs, then its progress. Nothing is installed
 *  until the owner presses Install. */
function VoiceSetup({ install, onInstall, onClose }: { install: NonNullable<TalkState['install']>; onInstall(): void; onClose(): void }) {
  return (
    <div role="dialog" aria-label="Set up voice" className="talk-rise w-full rounded-xl border border-border bg-raised px-4 py-3.5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-hover text-text-2">
          {install.step === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AudioLines className="h-3.5 w-3.5" strokeWidth={1.75} />}
        </div>
        <div className="min-w-0 flex-1">
          {install.step === 'ask' && (
            <>
              <div className="text-[13.5px] font-semibold text-text">Voice needs a one-time setup</div>
              <p className="mt-1 text-[12.5px] leading-5 text-text-2">
                Talk listens and speaks on this Mac, so what you say never leaves it. Setting it up downloads the speech models (about 3 GB, once) and
                installs espeak-ng with Homebrew (about 26 MB) for the natural voice. It runs <code className="text-text">orcha voice install</code> and
                takes a few minutes; you can keep typing meanwhile.
              </p>
            </>
          )}
          {install.step === 'running' && (
            <>
              <div className="text-[13.5px] font-semibold text-text">Setting up voice…</div>
              <p className="mt-1 truncate font-mono text-[11.5px] text-text-3" title={install.line}>
                {install.line}
              </p>
              <p className="mt-1 text-[12px] text-text-3">You can keep typing. Voice turns on when it’s done.</p>
            </>
          )}
          {install.step === 'failed' && (
            <>
              <div className="text-[13.5px] font-semibold text-text">Voice setup didn’t finish</div>
              <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-5 text-danger">{install.error}</p>
              <p className="mt-1 text-[12px] text-text-3">
                You can also run <code className="text-text-2">orcha voice install</code> in Terminal.
              </p>
            </>
          )}
        </div>
      </div>
      {install.step !== 'running' && (
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-8 rounded-lg border border-border px-3 text-[12.5px] text-text hover:bg-hover">
            Not now
          </button>
          <button type="button" onClick={onInstall} className="h-8 rounded-lg bg-accent px-3.5 text-[12.5px] font-semibold text-bg hover:bg-accent-hover">
            {install.step === 'failed' ? 'Try again' : 'Install'}
          </button>
        </div>
      )}
    </div>
  )
}

/** A tagged project or agent, as a pill (in the composer with ×, and on the owner's message). */
function TagPill({ tag, projects, onRemove }: { tag: TalkMention; projects: Map<string, TalkProjectOption>; onRemove?(): void }) {
  const p = projects.get(tag.project)
  return (
    <span className="inline-flex h-6 max-w-full items-center gap-1 rounded-md border border-border bg-hover px-1.5 text-[12.5px] text-text">
      {tag.alias ? <Bot className="h-3.5 w-3.5 shrink-0 text-text-3" strokeWidth={1.75} /> : <ProjectIcon icon={p?.icon} size={16} />}
      <span className="truncate">{tag.alias ?? p?.name ?? 'project'}</span>
      {tag.alias && p && projects.size > 1 && <span className="shrink-0 text-text-3">{p.name}</span>}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${tag.alias ?? p?.name ?? 'tag'}`} className="-mr-0.5 rounded text-text-3 hover:text-text">
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  )
}

/** What an "@" in the composer can tag (projects, agents), above the box — the app's menu look. */
function TagMenu({ items, active, onPick, onHover }: { items: TagOption[]; active: number; onPick(o: TagOption): void; onHover(i: number): void }) {
  return (
    <div
      role="listbox"
      aria-label="Tag a project or agent"
      className="absolute bottom-full left-2 z-20 mb-2 w-80 max-w-[calc(100%-1rem)] overflow-hidden rounded-xl border border-border bg-raised p-1 shadow-xl"
    >
      {items.map((a, i) => (
        <button
          key={pillKey(a)}
          type="button"
          role="option"
          aria-selected={i === active}
          onMouseDown={(e) => {
            e.preventDefault() // keep the focus (and the caret) in the box
            onPick(a)
          }}
          onMouseEnter={() => onHover(i)}
          className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left', i === active && 'bg-hover')}
        >
          {a.kind === 'agent' ? <Bot className="h-3.5 w-3.5 shrink-0 text-text-3" strokeWidth={1.75} /> : <ProjectIcon icon={a.icon} size={16} />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] text-text">{a.alias ?? a.projectName}</span>
            <span className="block truncate text-[11.5px] text-text-3">{a.kind === 'agent' ? a.role : 'Project'}</span>
          </span>
          {a.kind === 'agent' && (
            <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-text-3">
              <ProjectIcon icon={a.icon} size={16} />
              {a.projectName}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const t = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(t)
  }, [on])
  return now
}

function Turn({
  turn,
  projects,
  reveal,
  live,
  phase,
  undoLeft,
  undoTotal,
  confirmPhrase,
  onOpen,
  onConfirm,
  onCancel,
  onQuick,
  onRevise,
  onReply
}: {
  turn: TalkTurn
  projects: Map<string, TalkProjectOption>
  reveal: boolean
  live: boolean
  phase: TalkPhase
  undoLeft: number | null
  undoTotal: number
  confirmPhrase: string
  onOpen: Open
  onConfirm(): void
  onCancel(): void
  onQuick(u: NonNullable<TalkTurn['update']>, action: string, args: Record<string, unknown>): void
  onRevise(p: TalkProposal, args: Record<string, unknown>): void
  onReply(text: string): void
}) {
  if (turn.who === 'you') {
    return (
      <div className={cn('group flex flex-col items-end gap-1', turn.id.startsWith('local-') && 'talk-rise')}>
        <div className="talk-you max-w-[78%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-[15px] leading-7">
          {turn.mentions && turn.mentions.length > 0 && (
            <span className="mb-1 flex flex-wrap gap-1.5">
              {turn.mentions.map((t) => (
                <TagPill key={pillKey(t)} tag={t} projects={projects} />
              ))}
            </span>
          )}
          {turn.text}
        </div>
        <div className="talk-meta flex items-center gap-1 pr-1 text-[11px] text-text-3" title={fullWhen(turn.at)}>
          {turn.via === 'voice' && (
            <>
              <Mic className="h-3 w-3" />
              <span>Spoken ·</span>
            </>
          )}
          <span className="tabular-nums">{timeLabel(turn.at)}</span>
        </div>
      </div>
    )
  }
  const u = turn.update
  return (
    <div className={cn('group flex gap-3.5', reveal && 'talk-rise')}>
      <div className="pt-0.5">
        <Orb mode="idle" size={26} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {turn.looked && turn.looked.length > 0 && <Looked items={turn.looked} />}
        <div className={cn('text-[15px] leading-7', turn.error ? 'text-text-3' : 'text-text')}>
          <RichText text={turn.text} reveal={reveal} />
        </div>
        {turn.proposal && (
          <ActionCard
            p={turn.proposal}
            live={live}
            phase={phase}
            undoLeft={undoLeft}
            undoTotal={undoTotal}
            confirmPhrase={confirmPhrase}
            onOpen={onOpen}
            onConfirm={onConfirm}
            onCancel={onCancel}
            onRevise={(args) => onRevise(turn.proposal as TalkProposal, args)}
          />
        )}
        {u && <UpdateCard u={u} onOpen={onOpen} onQuick={(a, args) => onQuick(u, a, args)} onReply={onReply} />}
        {turn.agents && turn.agents.length > 0 && <AgentCards agents={turn.agents} projects={projects} onOpen={onOpen} />}
        {turn.links && turn.links.length > 0 && !turn.proposal && <SourceChips links={turn.links} projects={projects} onOpen={onOpen} />}
        <div className="talk-meta -mt-1 text-[11px] tabular-nums text-text-3" title={fullWhen(turn.at)}>
          {timeLabel(turn.at)}
          {turn.opened ? ` · opened ${turn.opened.kind === 'project' ? turn.opened.projectName : turn.opened.label}` : ''}
        </div>
      </div>
    </div>
  )
}
