/** Storyboard (a): a faux fleet dashboard — a few agent cards with status pills. Pure CSS/DOM,
 *  no screenshots. Styled entirely from the app's design tokens so it themes correctly. */
export default function FleetDashboardFrame() {
  const agents: { alias: string; role: string; status: 'working' | 'idle' | 'blocked' }[] = [
    { alias: 'Atlas', role: 'Lead', status: 'working' },
    { alias: 'Sable', role: 'iOS', status: 'working' },
    { alias: 'Quill', role: 'Docs', status: 'idle' },
    { alias: 'Vex', role: 'QA', status: 'blocked' }
  ]
  const dot: Record<string, string> = {
    working: 'bg-ok',
    idle: 'bg-text/30',
    blocked: 'bg-warning'
  }
  return (
    <div className="flex h-full w-full flex-col gap-2 rounded-lg border border-border bg-bg p-3">
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-danger/60" />
        <span className="h-2 w-2 rounded-full bg-warning/60" />
        <span className="h-2 w-2 rounded-full bg-ok/60" />
        <span className="ml-2 text-[10px] text-text/40">Orcha stacks</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {agents.map((a) => (
          <div key={a.alias} className="flex flex-col gap-1 rounded-md border border-border bg-card px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${dot[a.status]}`} aria-hidden />
              <span className="truncate text-[11px] font-medium text-text">{a.alias}</span>
            </div>
            <span className="text-[10px] text-text/50">{a.role}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
