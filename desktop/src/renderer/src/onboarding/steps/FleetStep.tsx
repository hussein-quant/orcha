import { useEffect, useState } from 'react'
import { Crown, Loader2 } from 'lucide-react'
import type { RosterSuggestion, RosterSuggestResponse } from '../../../../shared/types'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'

interface ContainerRow {
  id: string
}
interface AgentRow {
  id: string
  kind: string
}

/** Resolve the container id for a just-provisioned stack: GET /api/containers and take the
 *  newest/only one (mirrors how attention.ts's fetchStackAttention learns cid post-provision —
 *  there's exactly one container per stack in orcha's model). */
async function resolveContainerId(apiPort: number): Promise<string | null> {
  const res = (await window.orchaDesktop.portalGet(apiPort, '/api/containers')) as {
    containers: ContainerRow[]
  }
  return res.containers[0]?.id ?? null
}

/** Find the human actor id from the container snapshot's agent roster (kind: 'human') — the
 *  accept call attributes fleet creation to the person running onboarding. */
async function resolveHumanAgentId(apiPort: number, cid: string): Promise<string | null> {
  const detail = (await window.orchaDesktop.portalGet(apiPort, `/api/containers/${cid}`)) as {
    agents: AgentRow[]
  }
  return detail.agents.find((a) => a.kind === 'human')?.id ?? null
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'unavailable' } // feature-detect: non-200/404 on the suggest GET → auto-skip
  | { kind: 'ready'; cid: string; humanAgentId: string | null; data: RosterSuggestResponse }
  | { kind: 'creating'; cid: string; humanAgentId: string | null; data: RosterSuggestResponse }
  | { kind: 'done'; created: string[] }

/** "Meet your suggested fleet" — shown after a successful provision (first-run AND
 *  add-project). Feature-detects the roster/suggest endpoint: any non-200 (older/open CLI
 *  portals without it, most commonly 404) skips this step entirely and silently via
 *  `onUnavailable`, so the wizard's walker treats it like it was never there. */
export default function FleetStep({
  apiPort,
  onDone,
  onUnavailable
}: {
  apiPort: number
  onDone: () => void
  onUnavailable: () => void
}) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const cid = await resolveContainerId(apiPort)
        if (!cid) {
          if (!cancelled) onUnavailable()
          return
        }
        const data = (await window.orchaDesktop.portalGet(
          apiPort,
          `/api/containers/${cid}/roster/suggest`
        )) as RosterSuggestResponse
        if (cancelled) return
        if (!data.available || data.suggestions.length === 0) {
          onUnavailable()
          return
        }
        const humanAgentId = await resolveHumanAgentId(apiPort, cid).catch(() => null)
        if (cancelled) return
        setSelected(new Set(data.suggestions.map((s) => s.alias)))
        setState({ kind: 'ready', cid, humanAgentId, data })
      } catch {
        // Any failure (404 from an older portal, network hiccup, malformed body) — skip
        // rather than block the wizard on a step that isn't load-bearing.
        if (!cancelled) onUnavailable()
      }
    }
    void load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiPort])

  function toggle(alias: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(alias)) next.delete(alias)
      else next.add(alias)
      return next
    })
  }

  async function createFleet(): Promise<void> {
    if (state.kind !== 'ready') return
    const { cid, humanAgentId, data } = state
    setState({ kind: 'creating', cid, humanAgentId, data })
    try {
      const chosen = data.suggestions.filter((s) => selected.has(s.alias))
      const res = (await window.orchaDesktop.portalPost(apiPort, `/api/containers/${cid}/roster/suggest/accept`, {
        suggestions: chosen,
        actor_agent_id: humanAgentId
      })) as { created?: string[] }
      setState({ kind: 'done', created: res.created ?? chosen.map((s) => s.alias) })
    } catch {
      // Accept failing isn't fatal to onboarding — fall through to Finish without a fleet
      // rather than stranding the user on an error screen for a non-essential step.
      onDone()
    }
  }

  if (state.kind === 'loading') {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-text/60">
        <span className="onb-spin flex h-5 w-5 items-center justify-center">
          <Loader2 className="h-5 w-5 text-accent" />
        </span>
        <span className="text-sm">Looking at your project…</span>
      </div>
    )
  }

  if (state.kind === 'unavailable') return null

  if (state.kind === 'done') {
    return (
      <div className="flex flex-col gap-4 animate-slide-in">
        <div className="flex flex-col gap-1">
          <span className="onb-eyebrow">Fleet</span>
          <h2 className="onb-title text-2xl">Fleet created</h2>
          <p className="onb-body">
            {state.created.length > 0
              ? `${state.created.join(', ')} — ready to go.`
              : 'No agents were added.'}
          </p>
        </div>
        <div className="flex justify-end">
          <Button data-onb-primary="true" onClick={onDone}>
            Continue
          </Button>
        </div>
      </div>
    )
  }

  const { data } = state
  const sorted = [...data.suggestions].sort((a, b) => Number(b.is_main) - Number(a.is_main))
  const creating = state.kind === 'creating'

  return (
    <div className="flex flex-col gap-4 animate-slide-in">
      <div className="flex flex-col gap-1">
        <span className="onb-eyebrow">Fleet</span>
        <h2 className="onb-title text-2xl">Meet your suggested fleet</h2>
        <p className="onb-body">
          Based on {data.signals.join(', ') || 'your project'}, here's who we'd bring on.
        </p>
      </div>

      <div className="onb-stagger flex flex-col gap-2">
        {sorted.map((s, i) => (
          <FleetCard
            key={s.alias}
            suggestion={s}
            index={i}
            checked={selected.has(s.alias)}
            onToggle={() => toggle(s.alias)}
          />
        ))}
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone} disabled={creating}>
          Skip
        </Button>
        <Button
          data-onb-primary="true"
          onClick={() => void createFleet()}
          disabled={creating || selected.size === 0}
        >
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Create fleet
        </Button>
      </div>
    </div>
  )
}

function FleetCard({
  suggestion,
  index,
  checked,
  onToggle
}: {
  suggestion: RosterSuggestion
  index: number
  checked: boolean
  onToggle: () => void
}) {
  return (
    <Card
      data-selected={checked}
      className="onb-select-card flex items-start gap-3"
      style={{ '--onb-stagger-i': index } as React.CSSProperties}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        aria-label={`Include ${suggestion.alias}`}
        className="mt-1 h-4 w-4 accent-accent"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          {suggestion.is_main && <Crown className="h-3.5 w-3.5 text-accent" aria-label="Lead agent" />}
          <span className="font-medium text-text">{suggestion.alias}</span>
          <span className="text-xs text-text/50">{suggestion.role}</span>
        </div>
        <span className="text-xs text-text/70">{suggestion.focus}</span>
        <span className="text-[11px] text-text/40">{suggestion.rationale}</span>
      </div>
    </Card>
  )
}
