import { useEffect, useState } from 'react'
import type { WizardVariant } from '../../shared/types'
import ManagerView from './components/ManagerView'
import OnboardingWizard from './onboarding/OnboardingWizard'

type AppMode = 'loading' | 'manager' | 'onboarding'

export default function App() {
  const [mode, setMode] = useState<AppMode>('loading')
  // Which framing the wizard uses when mode === 'onboarding'. Defaults to 'first-run' —
  // the zero-stack path below sets it explicitly; add-project entry points override it.
  const [wizardVariant, setWizardVariant] = useState<WizardVariant>('first-run')

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

  // File→Add Project (main) asks us to switch.
  useEffect(
    () =>
      window.orchaDesktop.onNavigate(({ target, variant }) => {
        if (target === 'onboarding') setWizardVariant(variant ?? 'add-project')
        setMode(target)
      }),
    []
  )

  if (mode === 'loading') return <div className="h-full animate-fade-in" />
  if (mode === 'onboarding') {
    return (
      <OnboardingWizard
        variant={wizardVariant}
        onDone={() => setMode('manager')}
        onCancel={wizardVariant === 'add-project' ? () => setMode('manager') : undefined}
      />
    )
  }
  return (
    <ManagerView
      onCreate={() => {
        setWizardVariant('add-project')
        setMode('onboarding')
      }}
    />
  )
}
