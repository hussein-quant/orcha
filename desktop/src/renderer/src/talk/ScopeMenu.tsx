/** Talk to Orcha (GH-409): which projects a chat covers — a Linear-style picker (the app's menu
 *  look: raised popover, type to filter, project icons, a check on the current one). */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Globe, Search } from 'lucide-react'
import type { TalkProjectOption } from '../../../shared/talk'
import { cn } from '../ui/cn'
import { ProjectIcon } from '../ui/ProjectIcon'

export function ScopeMenu({
  value,
  projects,
  onChange
}: {
  /** "<stack>:<cid>", or null = every project */
  value: string | null
  projects: TalkProjectOption[]
  onChange(scope: string | null): void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement | null>(null)
  const filter = useRef<HTMLInputElement | null>(null)
  const current = value ? projects.find((p) => p.key === value) : undefined

  const items = useMemo(() => {
    const all: (TalkProjectOption | null)[] = [null, ...projects]
    const t = q.trim().toLowerCase()
    return t ? all.filter((p) => (p ? p.name.toLowerCase().includes(t) : 'all projects'.includes(t))) : all
  }, [projects, q])

  useEffect(() => {
    if (!open) return
    setQ('')
    setActive(Math.max(0, [null, ...projects].findIndex((p) => (p?.key ?? null) === value)))
    requestAnimationFrame(() => filter.current?.focus())
    const onDown = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, projects, value])

  const pick = (p: TalkProjectOption | null): void => {
    setOpen(false)
    if ((p?.key ?? null) !== value) onChange(p?.key ?? null)
  }

  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Which projects this chat covers"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex h-7 max-w-[220px] items-center gap-1.5 rounded-md border border-border px-2 text-[12px] text-text-2 hover:border-border-strong hover:bg-hover hover:text-text',
          open && 'border-border-strong bg-hover text-text'
        )}
      >
        {current ? <ProjectIcon icon={current.icon} size={16} /> : <Globe className="h-3.5 w-3.5 shrink-0 text-text-3" strokeWidth={1.75} />}
        <span className="min-w-0 truncate">{current ? current.name : value ? 'One project' : 'All projects'}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-text-3" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Which projects this chat covers"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              setOpen(false)
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              const n = items.length
              if (n) setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const p = items[active]
              if (p !== undefined) pick(p)
            }
          }}
          className="talk-pop absolute right-0 top-full z-40 mt-1 w-64 rounded-[10px] border border-border-strong bg-raised p-1 shadow-[var(--shadow-pop)]"
        >
          <div className="flex h-8 items-center gap-2 border-b border-border px-2 pb-1">
            <Search className="h-3.5 w-3.5 shrink-0 text-text-3" />
            <input
              ref={filter}
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                setActive(0)
              }}
              placeholder="Covers…"
              aria-label="Filter projects"
              className="talk-filter min-w-0 flex-1 bg-transparent text-[12.5px] text-text outline-none placeholder:text-text-3"
            />
          </div>
          <div className="max-h-72 overflow-y-auto pt-1">
            {items.length === 0 && <div className="px-2 py-2 text-[12px] text-text-3">No project matches.</div>}
            {items.map((p, i) => {
              const selected = (p?.key ?? null) === value
              return (
                <button
                  key={p?.key ?? 'all'}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(p)}
                  className={cn('flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-text', i === active && 'bg-hover')}
                >
                  {p ? <ProjectIcon icon={p.icon} size={16} /> : <Globe className="h-4 w-4 shrink-0 text-text-3" strokeWidth={1.75} />}
                  <span className="min-w-0 flex-1 truncate">{p ? p.name : 'All projects'}</span>
                  {p && p.needsYou > 0 && <span className="shrink-0 text-[11.5px] tabular-nums text-warning">{p.needsYou}</span>}
                  <Check className={cn('h-3.5 w-3.5 shrink-0 text-text-2', !selected && 'invisible')} />
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
