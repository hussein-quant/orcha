import { GitBranch, Laptop, Smartphone, Users } from 'lucide-react'
import { ObButton, OrchaMark, StepFooter, StepHeader } from '../ui'

const FEATURES = [
  {
    icon: Users,
    title: 'A team of agents',
    body: 'Several agents work on one project at once, each with its own role.'
  },
  {
    icon: GitBranch,
    title: 'Review in place',
    body: 'Read their changes and comment right on the diff.'
  },
  {
    icon: Laptop,
    title: 'Runs on this Mac',
    body: 'Your code and your agents stay on your machine.'
  },
  {
    icon: Smartphone,
    title: 'Check in from your phone',
    body: 'Pair your phone to answer requests on the go.'
  }
]

/** First-run welcome: product mark, a Display title, four one-line capabilities and one
 *  primary. Calm by design — no typewriter, no emoji, no card grid. */
export default function WelcomeStep({ onContinue }: { onContinue: () => void }) {
  return (
    <>
      <div className="flex flex-col gap-5">
        <OrchaMark size={44} />
        <StepHeader
          size="xl"
          title="Welcome to Quorate"
          subtitle="Your agent fleet, on your machine. Setting up your first project takes a couple of minutes."
        />
      </div>
      <ul className="m-0 flex list-none flex-col gap-4 p-0">
        {FEATURES.map((f) => (
          <li key={f.title} className="flex items-start gap-3">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border text-text-2">
              <f.icon className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <div className="flex min-w-0 flex-col">
              <span className="text-[13px] font-medium text-text">{f.title}</span>
              <span className="text-[13px] text-text-3">{f.body}</span>
            </div>
          </li>
        ))}
      </ul>
      <StepFooter
        hint={
          <>
            Press <span className="ob-kbd">↵</span>
          </>
        }
      >
        <ObButton variant="primary" data-onb-primary="true" onClick={onContinue}>
          Get started
        </ObButton>
      </StepFooter>
    </>
  )
}
