import { Card } from '../../ui/Card'
import { FolderOpen, FolderGit2 } from 'lucide-react'

export type ProjectSource = 'local' | 'github'

/** First fork in the wizard: where does the project come from. Local folder keeps the
 *  original onboarding path (FolderStep → DetailsStep); From GitHub clones first
 *  (GithubSourceStep), then rejoins the SAME provision step as local. */
export default function SourceStep({ onChoose }: { onChoose: (source: ProjectSource) => void }) {
  return (
    <div className="flex flex-col gap-4 animate-slide-in">
      <h2 className="text-lg font-semibold">Where's the project?</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <button type="button" onClick={() => onChoose('local')} className="text-left">
          <Card className="flex h-full flex-col gap-2 transition-colors duration-[var(--duration-base)] hover:border-accent">
            <FolderOpen className="h-5 w-5 text-accent" />
            <span className="font-medium">Local folder</span>
            <span className="text-xs text-text/60">Pick an existing folder, or create a new one.</span>
          </Card>
        </button>
        <button type="button" onClick={() => onChoose('github')} className="text-left">
          <Card className="flex h-full flex-col gap-2 transition-colors duration-[var(--duration-base)] hover:border-accent">
            <FolderGit2 className="h-5 w-5 text-accent" />
            <span className="font-medium">From GitHub</span>
            <span className="text-xs text-text/60">Clone one of your repos, or paste a URL.</span>
          </Card>
        </button>
      </div>
    </div>
  )
}
