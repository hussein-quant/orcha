import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Copy } from 'lucide-react'
import type { ProgressEvent, ProvisionStep as StepId } from '../../../../shared/types'
import type { ProvisionFailure } from '../provisionError'
import { InlineText, Notice, ObButton, StatusGlyph, StepFooter, StepHeader, type GlyphState } from '../ui'

export type ProvisionStatus = 'idle' | 'running' | 'done' | 'failed'

const STEPS: { id: StepId; label: string }[] = [
  { id: 'clone-repo', label: 'Clone the repository' },
  { id: 'preflight', label: 'Check Docker' },
  { id: 'render-compose', label: 'Prepare project files' },
  { id: 'copy-templates', label: 'Copy templates' },
  { id: 'compose-up', label: 'Start containers' },
  { id: 'wait-portal', label: 'Wait for the portal' },
  { id: 'create-container', label: 'Create the project' },
  { id: 'register-human', label: 'Register you' },
  { id: 'start-daemons', label: 'Start the agent worker' }
]

/** Steps every local provision walks; clone/preflight rows only appear when they apply. */
const CORE = new Set<StepId>([
  'render-compose',
  'copy-templates',
  'compose-up',
  'wait-portal',
  'create-container',
  'register-human',
  'start-daemons'
])

const ASIDE: Record<GlyphState, string> = {
  todo: '',
  running: 'Running…',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  warning: ''
}

/** Create: honest, step-by-step progress for provisioning (and cloning), the live log on
 *  demand, and — when it fails — a readable reason, the raw details on demand, Try again and
 *  Back. Never a dead end, and the title always matches what actually happened. */
export default function ProvisionStep({
  projectName,
  events,
  status,
  failure,
  warnings = [],
  gitTip = null,
  withClone = false,
  onContinue,
  onRetry,
  onBack
}: {
  projectName: string
  events: ProgressEvent[]
  status: ProvisionStatus
  failure: ProvisionFailure | null
  warnings?: string[]
  gitTip?: string | null
  withClone?: boolean
  onContinue: () => void
  onRetry: () => void
  onBack: () => void
}) {
  const stepState = new Map<StepId, GlyphState>()
  const logs: string[] = []
  for (const e of events) {
    if (e.status === 'log') logs.push(e.line)
    else
      stepState.set(
        e.step,
        e.status === 'ok' ? 'done' : e.status === 'fail' ? 'failed' : e.status === 'skip' ? 'skipped' : 'running'
      )
  }
  // A step still "running" when the attempt failed is the one that failed (the engine
  // doesn't always emit an explicit fail event before rejecting).
  if (status === 'failed') {
    for (const [k, v] of stepState) if (v === 'running') stepState.set(k, 'failed')
    if (failure?.step && !stepState.has(failure.step)) stepState.set(failure.step, 'failed')
  }
  const visible = STEPS.filter((s) => CORE.has(s.id) || stepState.has(s.id) || (s.id === 'clone-repo' && withClone))
  const finished = visible.filter((s) => {
    const st = stepState.get(s.id)
    return st === 'done' || st === 'skipped'
  }).length
  const current = visible.find((s) => stepState.get(s.id) === 'running')

  const [showLog, setShowLog] = useState(false)
  const logOpen = showLog || status === 'failed'
  const logRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (logOpen && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logOpen, logs.length])
  const [showDetail, setShowDetail] = useState(false)
  const [showSteps, setShowSteps] = useState(false)
  const stepsOpen = status !== 'done' || showSteps

  const title =
    status === 'failed'
      ? `Couldn’t create ${projectName}`
      : status === 'done'
        ? `${projectName} is ready`
        : `Creating ${projectName}`
  const subtitle =
    status === 'failed'
      ? 'Nothing you entered is lost. Fix the problem below, then try again — or go back and change your choices.'
      : status === 'done'
        ? `The project is running. ${warnings.length + (gitTip ? 1 : 0) > 1 ? 'A few things' : 'One thing'} to know before you add agents:`
        : `Step ${Math.min(finished + 1, visible.length)} of ${visible.length}${current ? ` · ${current.label}` : ''}. This usually takes a minute or two.`

  return (
    <>
      <StepHeader title={title} subtitle={subtitle} />

      {status === 'failed' && failure && (
        <Notice
          tone="danger"
          title={<InlineText text={failure.message} />}
          action={
            <div className="flex items-center gap-1.5">
              <ObButton variant="ghost" onClick={onBack}>
                Back
              </ObButton>
              <ObButton variant="primary" data-onb-primary="true" onClick={onRetry}>
                Try again
              </ObButton>
            </div>
          }
        >
          {(failure.cause || failure.detail) && (
            <div className="flex flex-col gap-1.5">
              {failure.cause && (
                <span className="ob-notice-cause" data-testid="failure-cause">
                  {failure.cause}
                </span>
              )}
              {failure.detail && (
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    className="ob-disclosure"
                    aria-expanded={showDetail}
                    onClick={() => setShowDetail((v) => !v)}
                  >
                    {showDetail ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    {showDetail ? 'Hide details' : 'Show details'}
                  </button>
                  {showDetail && <pre className="ob-log max-h-40">{failure.detail.slice(-4000)}</pre>}
                </div>
              )}
            </div>
          )}
        </Notice>
      )}

      {status === 'done' && (warnings.length > 0 || gitTip) && (
        <div className="flex flex-col gap-2">
          {warnings.map((w, i) => (
            <Notice key={i} tone="warning">
              <InlineText text={w} />
            </Notice>
          ))}
          {gitTip && (
            <Notice>
              <InlineText text={gitTip} />
            </Notice>
          )}
        </div>
      )}

      {status === 'done' && (
        <button
          type="button"
          className="ob-disclosure"
          aria-expanded={showSteps}
          onClick={() => setShowSteps((v) => !v)}
        >
          {showSteps ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          All {visible.length} steps finished
        </button>
      )}
      {stepsOpen && (
        <div className="ob-list" aria-label="Progress" role="list">
          {visible.map((s) => {
            const st = stepState.get(s.id) ?? 'todo'
            return (
              <div key={s.id} role="listitem" className="ob-row" data-state={st} style={{ minHeight: 36 }}>
                <StatusGlyph state={st} />
                <span className={`flex-1 truncate ${st === 'todo' || st === 'skipped' ? 'text-text-3' : 'text-text'}`}>
                  {s.label}
                </span>
                <span className={`ob-row-aside ${st === 'failed' ? 'text-danger' : ''}`}>{ASIDE[st]}</span>
              </div>
            )
          })}
        </div>
      )}

      {logs.length > 0 && (status !== 'done' || showSteps) && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <button
              type="button"
              className="ob-disclosure"
              aria-expanded={logOpen}
              onClick={() => setShowLog((v) => !v)}
            >
              {logOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Log · {logs.length} {logs.length === 1 ? 'line' : 'lines'}
            </button>
            {logOpen && (
              <button
                type="button"
                className="ob-disclosure"
                onClick={() => void navigator.clipboard?.writeText(logs.join('\n'))}
              >
                <Copy className="h-3 w-3" /> Copy log
              </button>
            )}
          </div>
          {!logOpen && status === 'running' && (
            <span className="truncate font-mono text-[11.5px] text-text-3" title={logs[logs.length - 1]}>
              {logs[logs.length - 1].trim()}
            </span>
          )}
          {logOpen && (
            <pre ref={logRef} className="ob-log" aria-label="Provisioning log">
              {logs.slice(-400).join('\n')}
            </pre>
          )}
        </div>
      )}

      {status === 'done' && (
        <StepFooter>
          <ObButton variant="primary" data-onb-primary="true" onClick={onContinue}>
            Continue
          </ObButton>
        </StepFooter>
      )}
    </>
  )
}
