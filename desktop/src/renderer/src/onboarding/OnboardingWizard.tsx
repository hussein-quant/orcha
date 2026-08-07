import { useState } from 'react'
import type { BridgeError, FolderChoice, FolderState, WizardVariant } from '../../../shared/types'
import { Stepper } from '../ui/Stepper'
import { Button } from '../ui/Button'
import { useProvisionStream } from './useProvisionStream'
import PreflightStep from './steps/PreflightStep'
import SourceStep, { type ProjectSource } from './steps/SourceStep'
import FolderStep from './steps/FolderStep'
import GithubSourceStep from './steps/GithubSourceStep'
import DetailsStep from './steps/DetailsStep'
import ProvisionStep from './steps/ProvisionStep'

const STEPS = ['Setup', 'Source', 'Details', 'Create']

const TITLES: Record<WizardVariant, string> = {
  'first-run': 'Set up Orcha',
  'add-project': 'Add a project'
}

/** Which screen is on-stage. Distinct from the Stepper's numeric index (below) — a few
 *  phases share a stepper position (e.g. 'source' covers both the chooser and each source's
 *  own picker) since the two sources take different-length paths to the same provision step. */
type Phase = 'preflight' | 'source' | 'folder' | 'github' | 'details' | 'provision'

/** Stepper position for each phase — 'folder'/'github' both read as "Source" (step 1);
 *  provisioning always reads as "Create" (step 3) whether it got there via Details or a
 *  straight-through clone. */
const STEPPER_INDEX: Record<Phase, number> = {
  preflight: 0,
  source: 1,
  folder: 1,
  github: 1,
  details: 2,
  provision: 3
}

/** Drives preflight → source → (folder details | github clone) → provision for BOTH
 *  first-run onboarding (zero stacks) and "Add project" from an existing manager — same
 *  step components either way, only framing (title, cancel affordance) differs.
 *  `variant` picks the framing; `onCancel` (add-project only) backs out to the manager
 *  without provisioning anything — safe any time, since orcha init/upgrade is re-runnable.
 *
 *  Two sources converge on the same provisioning step:
 *   - 'local': FolderStep picks/creates a folder → DetailsStep (skipped on reconnect) →
 *     provision({mode: initialized ? 'upgrade' : 'init'}).
 *   - 'github': GithubSourceStep clones a repo into a fresh destination → straight to
 *     provision({mode: 'init'}) — a repo we just cloned is never already .orcha-initialized,
 *     and it's always a git repo, so no Details step and no git-init tip either. */
export default function OnboardingWizard({
  onDone,
  variant = 'first-run',
  onCancel
}: {
  onDone: () => void
  variant?: WizardVariant
  onCancel?: () => void
}) {
  const [phase, setPhase] = useState<Phase>('preflight')
  const [source, setSource] = useState<ProjectSource | null>(null)
  const [choice, setChoice] = useState<FolderChoice | null>(null)
  const [folderState, setFolderState] = useState<FolderState | null>(null)
  const [provisioning, setProvisioning] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [project, setProject] = useState<string | null>(null)
  const { events } = useProvisionStream(null)

  // Git tip: shown once provisioning succeeds, only for a folder that wasn't a git repo.
  // Only reachable via the local-folder source — a clone is always a git repo.
  const gitTip =
    source === 'local' && folderState && !folderState.isGitRepo
      ? 'Tip: `git init` in this folder unlocks the local code-source features.'
      : null

  async function openPortalAndFinish(proj: string): Promise<void> {
    await window.orchaDesktop.openOnboardingPortal(proj)
    onDone()
  }

  function finishProvision(res: { project: string; warnings: string[] }, showGitTip: boolean): void {
    setDone(true)
    setProject(res.project)
    // If something needs the user's attention (e.g. the agent worker couldn't start, or
    // this folder isn't a git repo yet), pause on a plain-language note rather than
    // silently whisking them to the portal.
    if (res.warnings.length > 0 || showGitTip) {
      setWarnings(res.warnings)
    } else {
      void openPortalAndFinish(res.project)
    }
  }

  function failProvision(err: unknown): void {
    const be = err as BridgeError
    setError('stderr' in be ? be.stderr : 'reason' in be ? be.reason : be.code)
  }

  // choice/state come in as explicit args (not read off earlier state) so the reconnect
  // path — which calls this straight out of FolderStep's onNext — always provisions
  // against the folder that was JUST picked, not a stale render's closure.
  async function create(choice: FolderChoice, state: FolderState, name: string, objective: string): Promise<void> {
    setPhase('provision')
    setProvisioning(true)
    setError(null)
    try {
      // A folder with .orcha already provisioned reconnects (mode 'upgrade': preserves
      // the existing ports/config, skips container-create + human-register) instead of
      // re-running init, which would mint a fresh project name/ports over a live stack.
      const res = await window.orchaDesktop.provision({
        folder: choice.folder,
        mode: state.initialized ? 'upgrade' : 'init',
        name,
        objective
      })
      finishProvision(res, !state.isGitRepo)
    } catch (err) {
      failProvision(err)
    } finally {
      setProvisioning(false)
    }
  }

  // From GitHub: clone into `dest` (streams 'clone-repo' progress on the same provisioning
  // channel), then the exact same provision pipeline runs server-side on the clone.
  async function cloneAndCreate(repoUrl: string, dest: string): Promise<void> {
    setPhase('provision')
    setProvisioning(true)
    setError(null)
    try {
      const res = await window.orchaDesktop.cloneAndProvision({ repoUrl, dest })
      finishProvision(res, false)
    } catch (err) {
      failProvision(err)
    } finally {
      setProvisioning(false)
    }
  }

  return (
    <main className="mx-auto flex h-full max-w-2xl flex-col gap-6 p-8 animate-fade-in">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{TITLES[variant]}</h1>
        {onCancel && !provisioning && (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      <Stepper steps={STEPS} current={STEPPER_INDEX[phase]} />
      <div className="flex-1">
        {phase === 'preflight' && <PreflightStep onContinue={() => setPhase('source')} />}
        {phase === 'source' && (
          <SourceStep
            onChoose={(s) => {
              setSource(s)
              setPhase(s === 'local' ? 'folder' : 'github')
            }}
          />
        )}
        {phase === 'folder' && (
          <FolderStep
            onBack={() => setPhase('source')}
            onNext={(c, s) => {
              setChoice(c)
              setFolderState(s)
              // Reconnecting ignores name/objective (mode 'upgrade' reads the existing
              // config), so there's nothing useful to ask on the Details step — skip it.
              if (s.initialized) {
                void create(c, s, s.suggestedName, '')
              } else {
                setPhase('details')
              }
            }}
          />
        )}
        {phase === 'github' && (
          <GithubSourceStep
            onBack={() => setPhase('source')}
            onNext={(repoUrl, dest) => void cloneAndCreate(repoUrl, dest)}
          />
        )}
        {phase === 'details' && (
          <DetailsStep
            suggestedName={folderState?.suggestedName ?? ''}
            onBack={() => setPhase('folder')}
            onCreate={(name, objective) => choice && folderState && void create(choice, folderState, name, objective)}
          />
        )}
        {phase === 'provision' && (
          <ProvisionStep
            events={events}
            done={done && !provisioning}
            error={error}
            warnings={warnings}
            gitTip={done && !provisioning ? gitTip : null}
            withClone={source === 'github'}
            onContinue={project ? () => openPortalAndFinish(project) : undefined}
          />
        )}
      </div>
    </main>
  )
}
