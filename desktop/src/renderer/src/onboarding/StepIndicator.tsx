import { Fragment } from 'react'
import { Check, Minus } from 'lucide-react'

export interface StepItem {
  key: string
  label: string
  /** `skipped`: the step doesn't apply to this path (e.g. Details when reconnecting an
   *  existing Orcha folder) — it stays in place, muted with a dash, so the count never shifts. */
  state: 'done' | 'current' | 'upcoming' | 'skipped'
}

/** Labelled compact stepper ("✓ Setup — ✓ Source — ③ Details — 4 Create"), the same shape
 *  as the portal onboarding's stepper. Completed steps are buttons (jump back) only while
 *  `onJump` is provided — the wizard withholds it once a project has been created. */
export function StepIndicator({ steps, onJump }: { steps: StepItem[]; onJump?: (key: string) => void }) {
  const current = steps.findIndex((s) => s.state === 'current')
  return (
    <ol className="ob-steps" aria-label={`Step ${current + 1} of ${steps.length}`}>
      {steps.map((s, i) => {
        const body = (
          <>
            <span className="ob-step-num" aria-hidden="true">
              {s.state === 'done' ? (
                <Check className="h-2.5 w-2.5" strokeWidth={3} />
              ) : s.state === 'skipped' ? (
                <Minus className="h-2.5 w-2.5" strokeWidth={3} />
              ) : (
                i + 1
              )}
            </span>
            {s.label}
            {s.state === 'skipped' && <span className="sr-only"> (not needed)</span>}
          </>
        )
        const jumpable = s.state === 'done' && !!onJump
        return (
          <Fragment key={s.key}>
            {i > 0 && <li className="ob-step-sep" aria-hidden="true" />}
            <li
              aria-current={s.state === 'current' ? 'step' : undefined}
              title={s.state === 'skipped' ? `${s.label} isn’t needed for this project` : undefined}
            >
              {jumpable ? (
                <button type="button" className="ob-step" data-state={s.state} onClick={() => onJump(s.key)}>
                  {body}
                </button>
              ) : (
                <span className="ob-step" data-state={s.state}>
                  {body}
                </span>
              )}
            </li>
          </Fragment>
        )
      })}
    </ol>
  )
}
