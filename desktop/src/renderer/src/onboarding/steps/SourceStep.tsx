import { ChevronRight, FolderGit2, FolderOpen } from 'lucide-react'
import { ObButton, StepFooter, StepHeader } from '../ui'

export type ProjectSource = 'local' | 'github'

const OPTIONS: {
  key: ProjectSource
  icon: typeof FolderOpen
  title: string
  body: string
}[] = [
  {
    key: 'local',
    icon: FolderOpen,
    title: 'Local folder',
    body: 'Use a folder on this Mac, or create a new one.'
  },
  {
    key: 'github',
    icon: FolderGit2,
    title: 'From GitHub',
    body: 'Clone one of your repositories, or paste a URL.'
  }
]

/** First fork: where the project's code comes from. Two list rows (no selection cards);
 *  choosing one moves straight on. */
export default function SourceStep({
  selected = null,
  onChoose,
  onBack
}: {
  selected?: ProjectSource | null
  onChoose: (source: ProjectSource) => void
  onBack?: () => void
}) {
  return (
    <>
      <StepHeader title="Where’s your code?" subtitle="Quorate sets the project up in a folder on this Mac." />
      <div className="ob-list">
        {OPTIONS.map((o) => (
          <button
            key={o.key}
            type="button"
            className="ob-row"
            data-selected={selected === o.key}
            onClick={() => onChoose(o.key)}
            style={{ minHeight: 56 }}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border text-text-2">
              <o.icon className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <span className="ob-row-main">
              <span className="ob-row-title">{o.title}</span>
              <span className="ob-row-sub">{o.body}</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-text-3" aria-hidden="true" />
          </button>
        ))}
      </div>
      {onBack && (
        <StepFooter
          left={
            <ObButton variant="ghost" onClick={onBack}>
              Back
            </ObButton>
          }
        />
      )}
    </>
  )
}
