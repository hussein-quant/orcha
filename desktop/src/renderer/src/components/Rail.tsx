import { Home, Plus } from 'lucide-react'
import type { Stack } from '../../../shared/types'
import { cn } from '../ui/cn'

/** Derive a short, stable glyph from a stack's short project name for the rail's icon
 *  slot (no per-project icon asset to manage) — first letter, uppercased. */
function railGlyph(projectShort: string): string {
  return projectShort.charAt(0).toUpperCase() || '?'
}

interface RailProps {
  stacks: Stack[]
  /** Project of the stack whose portal is currently embedded and showing; null when the
   *  home/manager view (or the wizard) is on screen — no rail item is "active" then. */
  activeProject: string | null
  attentionCounts: Map<string, number>
  onSelectStack: (stack: Stack) => void
  onSelectHome: () => void
  onAddProject: () => void
}

/** Thin icon+name left rail, always on screen: lists every discovered stack (running-state
 *  dot + attention badge), an "All projects" home entry, and Add-project — the single-window
 *  equivalent of opening a separate manager window or a portal window per project. Reserves
 *  exactly RAIL_WIDTH px so main's embedded WebContentsView (offset by the same width) never
 *  overlaps it — the rail stays interactive even while a portal fills the rest of the window. */
export default function Rail({
  stacks,
  activeProject,
  attentionCounts,
  onSelectStack,
  onSelectHome,
  onAddProject
}: RailProps) {
  return (
    <nav
      aria-label="Stacks"
      data-testid="rail"
      className="flex h-full w-16 shrink-0 flex-col items-center gap-1 border-r border-border bg-card/60 py-3"
    >
      <button
        type="button"
        aria-label="All projects"
        aria-pressed={activeProject === null}
        title="All projects"
        onClick={onSelectHome}
        className={cn(
          'flex h-11 w-11 flex-col items-center justify-center gap-0.5 rounded-lg text-text/60 transition-colors duration-[var(--duration-base)] hover:bg-card hover:text-text',
          activeProject === null && 'bg-accent/15 text-accent'
        )}
      >
        <Home className="h-4 w-4" />
      </button>

      <div className="my-1 h-px w-8 bg-border" />

      <ul className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">
        {stacks.map((stack) => {
          const count = attentionCounts.get(stack.project) ?? 0
          const active = activeProject === stack.project
          return (
            <li key={stack.project}>
              <button
                type="button"
                aria-label={stack.projectShort}
                aria-pressed={active}
                title={stack.projectShort}
                onClick={() => onSelectStack(stack)}
                className={cn(
                  'relative flex h-11 w-11 items-center justify-center rounded-lg text-sm font-semibold text-text/70 transition-colors duration-[var(--duration-base)] hover:bg-card hover:text-text',
                  active && 'bg-accent/15 text-accent'
                )}
              >
                {railGlyph(stack.projectShort)}
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full',
                    stack.running ? 'bg-ok' : 'bg-text/30'
                  )}
                />
                {count > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[9px] font-bold leading-none text-bg"
                  >
                    {count > 9 ? '9+' : count}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>

      <button
        type="button"
        aria-label="Add project"
        title="Add project"
        onClick={onAddProject}
        className="flex h-11 w-11 items-center justify-center rounded-lg text-text/60 transition-colors duration-[var(--duration-base)] hover:bg-card hover:text-text"
      >
        <Plus className="h-4 w-4" />
      </button>
    </nav>
  )
}
