/** The compact usage indicator in the host sidebar's footer (the app's status area). Shown
 *  only when the portal-wide "Show plan usage" setting is on (off by default), for the
 *  chosen providers: both → each provider's logo + the percent of its busiest window, side
 *  by side; one → its logo, a thin bar and the percent. Collapsed: the gauge with the peak of
 *  the chosen providers. Click opens the Usage popover. */
import { Gauge } from 'lucide-react'
import {
  barTone,
  clampPercent,
  peakWindow,
  type PlanUsageDisplay,
  type PlanUsageProviders,
  type ProviderUsage,
  type UsageSnapshot
} from '../../../shared/usage'
import { cn } from '../ui/cn'
import { LimitBar, ProviderLogo, TONE_TEXT } from './parts'

export function peakProvider(s: UsageSnapshot | null): { p: ProviderUsage; percent: number } | null {
  if (!s) return null
  let best: { p: ProviderUsage; percent: number } | null = null
  for (const p of s.providers) {
    const w = peakWindow(p)
    if (w && (!best || w.usedPercent > best.percent)) best = { p, percent: clampPercent(w.usedPercent) }
  }
  return best
}

const PLAN_PROVIDERS = ['claude', 'codex'] as const

/** The providers the row shows for a choice, Claude first: each with the rounded percent of
 *  its busiest window. A chosen provider with no known window is left out. */
export function shownProviders(s: UsageSnapshot | null, choice: PlanUsageProviders): { p: ProviderUsage; pct: number }[] {
  if (!s) return []
  const ids = choice === 'both' ? PLAN_PROVIDERS : [choice]
  const out: { p: ProviderUsage; pct: number }[] = []
  for (const id of ids) {
    const p = s.providers.find((x) => x.id === id)
    const w = p ? peakWindow(p) : null
    if (p && w) out.push({ p, pct: Math.round(clampPercent(w.usedPercent)) })
  }
  return out
}

/** Whether the sidebar row shows at all (the setting; unknown = off, the default). */
export function usageRowVisible(display: PlanUsageDisplay | null | undefined): boolean {
  return !!display?.show
}

export default function UsageIndicator({
  snapshot,
  display,
  open,
  collapsed,
  onToggle
}: {
  snapshot: UsageSnapshot | null
  /** The "Show plan usage" setting; the row renders nothing while it is off or unknown. */
  display: PlanUsageDisplay | null
  open: boolean
  collapsed: boolean
  onToggle(): void
}) {
  if (!display || !usageRowVisible(display)) return null
  const shown = shownProviders(snapshot, display.providers)
  const pct = shown.length > 0 ? Math.max(...shown.map((x) => x.pct)) : null
  const tone = pct === null ? 'neutral' : barTone(pct)
  const label = shown.length > 0 ? `Usage: ${shown.map((x) => `${x.p.label} ${x.pct}%`).join(', ')}` : 'Usage'
  if (collapsed) {
    return (
      <button
        type="button"
        data-nav-item
        data-testid="usage-indicator"
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={onToggle}
        className={cn(
          'relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text',
          open && 'bg-selected text-text'
        )}
      >
        <Gauge className="h-4 w-4" />
        {pct !== null && (
          <span className={cn('absolute -bottom-0.5 right-0 text-[9px] font-semibold tabular-nums', TONE_TEXT[tone])}>{pct}</span>
        )}
      </button>
    )
  }
  return (
    <button
      type="button"
      data-nav-item
      data-testid="usage-indicator"
      aria-label={label}
      aria-expanded={open}
      onClick={onToggle}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-text-2 transition-colors hover:bg-hover hover:text-text',
        open && 'bg-selected text-text'
      )}
    >
      {shown.length === 1 ? (
        <ProviderLogo id={shown[0].p.id} size={16} />
      ) : (
        <Gauge className="h-4 w-4 shrink-0 text-text-3" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1 truncate">Usage</span>
      {shown.length === 1 ? (
        <>
          <LimitBar percent={shown[0].pct} className="w-10" thin />
          <span className={cn('w-8 text-right text-[11.5px] tabular-nums', TONE_TEXT[barTone(shown[0].pct)])}>{shown[0].pct}%</span>
        </>
      ) : (
        shown.map(({ p, pct: v }) => (
          <span key={p.id} data-usage-provider={p.id} className="flex shrink-0 items-center gap-1">
            <ProviderLogo id={p.id} size={14} />
            <span className={cn('text-[11.5px] tabular-nums', TONE_TEXT[barTone(v)])}>{v}%</span>
          </span>
        ))
      )}
    </button>
  )
}
