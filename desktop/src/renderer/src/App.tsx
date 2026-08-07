import { useCallback, useEffect, useState } from 'react'
import type { AttentionItem, Stack, WizardVariant } from '../../shared/types'
import ManagerView from './components/ManagerView'
import OnboardingWizard from './onboarding/OnboardingWizard'
import Rail from './components/Rail'

type AppMode = 'loading' | 'manager' | 'onboarding'

const RAIL_POLL_MS = 5000

function countsByProject(items: AttentionItem[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item.project, (counts.get(item.project) ?? 0) + 1)
  return counts
}

export default function App() {
  const [mode, setMode] = useState<AppMode>('loading')
  // Which framing the wizard uses when mode === 'onboarding'. Defaults to 'first-run' —
  // the zero-stack path below sets it explicitly; add-project entry points override it.
  const [wizardVariant, setWizardVariant] = useState<WizardVariant>('first-run')
  // Rail data: kept independent of ManagerView's own poll so the rail (always on screen,
  // even while a portal view covers the rest of the window) stays live regardless of mode.
  const [railStacks, setRailStacks] = useState<Stack[]>([])
  const [attentionCounts, setAttentionCounts] = useState<Map<string, number>>(new Map())
  // Which stack's embedded portal view (main-process WebContentsView) is currently showing.
  // null = the renderer's own content (home/manager or the wizard) is on screen. Main is the
  // source of truth (a notification click or deep link can change this without any click
  // here), mirrored via onPortalActive.
  const [activeProject, setActiveProject] = useState<string | null>(null)

  const refreshRail = useCallback(async () => {
    try {
      const [stacks, attention] = await Promise.all([
        window.orchaDesktop.listStacks(),
        window.orchaDesktop.listAttention().catch((): AttentionItem[] => [])
      ])
      setRailStacks(stacks)
      setAttentionCounts(countsByProject(attention))
    } catch {
      setRailStacks([])
      setAttentionCounts(new Map())
    }
  }, [])

  // Decide the initial mode before showing the manager: zero stacks → onboarding.
  useEffect(() => {
    let cancelled = false
    void window.orchaDesktop
      .listStacks()
      .then((stacks) => {
        if (cancelled) return
        setWizardVariant('first-run')
        setMode(stacks.length === 0 ? 'onboarding' : 'manager')
      })
      .catch(() => {
        if (!cancelled) setMode('manager') // Docker down → manager shows its banner
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    void refreshRail()
    const timer = setInterval(() => void refreshRail(), RAIL_POLL_MS)
    return () => clearInterval(timer)
  }, [refreshRail])

  // Main is the source of truth for which portal view is showing (tray/notification/deep
  // link can change it without a click in this window) — mirror it into rail highlight state.
  useEffect(() => window.orchaDesktop.onPortalActive(({ project }) => setActiveProject(project)), [])

  // File→Add Project (main) asks us to switch. Main already hides any embedded portal view
  // before sending this (wizard/home = no view visible), so just follow its lead here too.
  useEffect(
    () =>
      window.orchaDesktop.onNavigate(({ target, variant }) => {
        if (target === 'onboarding') {
          setWizardVariant(variant ?? 'add-project')
          setActiveProject(null)
        }
        setMode(target)
      }),
    []
  )

  /** Open a stack's portal embedded in the window (replaces the old per-portal
   *  BrowserWindow) and make sure we're not still showing the wizard/onboarding DOM —
   *  a WebContentsView draws above renderer content, so leaving the wizard mounted
   *  underneath a shown portal would just be wasted render, not a visual bug, but
   *  switching modes keeps the two mutually exclusive as designed. */
  const showStackPortal = useCallback((stack: Stack) => {
    setMode('manager')
    void window.orchaDesktop.portalShow(stack.project)
  }, [])

  const showHome = useCallback(() => {
    void window.orchaDesktop.portalHide()
    setMode('manager')
  }, [])

  const startAddProject = useCallback(() => {
    // Wizard/home = no view visible — hide any embedded portal before mounting the wizard.
    void window.orchaDesktop.portalHide()
    setWizardVariant('add-project')
    setMode('onboarding')
  }, [])

  if (mode === 'loading') return <div className="h-full animate-fade-in" />

  return (
    <div className="flex h-full">
      <Rail
        stacks={railStacks}
        activeProject={mode === 'onboarding' ? null : activeProject}
        attentionCounts={attentionCounts}
        onSelectStack={showStackPortal}
        onSelectHome={showHome}
        onAddProject={startAddProject}
      />
      <div className="min-w-0 flex-1">
        {mode === 'onboarding' ? (
          <OnboardingWizard
            variant={wizardVariant}
            onDone={() => setMode('manager')}
            onCancel={wizardVariant === 'add-project' ? () => setMode('manager') : undefined}
          />
        ) : (
          <ManagerView onCreate={startAddProject} />
        )}
      </div>
    </div>
  )
}
