import { ObButton, StatusGlyph, StepFooter, StepHeader, tildify } from '../ui'

/** Last screen: what was created (one definition list, real values only) and one primary
 *  that opens the project on its next useful screen — its Agents when a fleet was just
 *  created, otherwise the Overview, which explains the next step for an empty project. */
export default function FinishStep({
  project,
  folder = null,
  portalUrl,
  agents,
  codeSourceBound = false,
  opening = false,
  onOpen
}: {
  project: string
  folder?: string | null
  portalUrl: string
  /** Aliases of the agents created on the Agents step (empty when skipped/unavailable). */
  agents: string[]
  /** True once bindCodeSource connected the project to its local git repo. */
  codeSourceBound?: boolean
  opening?: boolean
  onOpen: (path: string) => void
}) {
  const name = project.replace(/^orcha-/, '')
  const path = agents.length > 0 ? '/agents' : '/'
  const rows: [string, React.ReactNode][] = [
    ['Project', name],
    ...(folder
      ? ([
          [
            'Folder',
            <span className="font-mono text-[12.5px]" title={folder}>
              {tildify(folder)}
            </span>
          ]
        ] as [string, React.ReactNode][])
      : []),
    ['Portal', <span className="font-mono text-[12.5px]">{portalUrl.replace(/^https?:\/\//, '')}</span>],
    [
      'Agents',
      agents.length > 0 ? agents.join(', ') : <span className="text-text-3">None yet — add them from the project</span>
    ],
    ...(codeSourceBound ? ([['Code source', 'Local repository']] as [string, React.ReactNode][]) : [])
  ]

  return (
    <>
      <div className="flex flex-col gap-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-full border border-border">
          <StatusGlyph state="done" />
        </span>
        <StepHeader
          title={`${name} is ready`}
          subtitle={
            agents.length > 0
              ? 'Your agents are set up. Give them their first task from the project.'
              : 'The project is running. Next, add agents and give them a first task.'
          }
        />
      </div>
      <dl className="ob-list m-0">
        {rows.map(([k, v]) => (
          <div key={k} className="ob-row" style={{ minHeight: 38 }}>
            <dt className="w-28 shrink-0 text-text-3">{k}</dt>
            <dd className="m-0 min-w-0 flex-1 truncate text-text">{v}</dd>
          </div>
        ))}
      </dl>
      <StepFooter hint={agents.length > 0 ? 'Opens Agents' : 'Opens Overview'}>
        <ObButton variant="primary" data-onb-primary="true" disabled={opening} onClick={() => onOpen(path)}>
          {opening ? 'Opening…' : `Open ${name}`}
        </ObButton>
      </StepFooter>
    </>
  )
}
