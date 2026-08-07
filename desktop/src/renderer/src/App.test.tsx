// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'

/** Captured onNavigate listener so tests can simulate main→renderer IPC (e.g. the
 *  File→Add Project menu item) without a real Electron process. */
let navigateListener: ((nav: { target: 'onboarding' | 'manager'; variant?: string }) => void) | null = null

function stub(stacks: unknown[]) {
  navigateListener = null
  window.orchaDesktop = {
    listStacks: vi.fn().mockResolvedValue(stacks),
    startStack: vi.fn(),
    stopStack: vi.fn(),
    resetStack: vi.fn(),
    openPortal: vi.fn(),
    listAttention: vi.fn().mockResolvedValue([]),
    openManager: vi.fn(),
    quitApp: vi.fn(),
    preflight: vi.fn().mockResolvedValue({ docker: 'ok', autoStarted: false, hint: null }),
    probePrereqs: vi
      .fn()
      .mockResolvedValue({ homebrew: true, dockerEngine: true, orcha: true, claude: true, codex: true, apiKey: true }),
    installPrereqs: vi.fn().mockResolvedValue({ ok: true, completed: [] }),
    onInstallProgress: vi.fn().mockReturnValue(() => {}),
    pickFolder: vi.fn().mockResolvedValue(null),
    inspectFolder: vi
      .fn()
      .mockResolvedValue({ initialized: false, writable: true, suggestedName: 'x', isGitRepo: true }),
    provision: vi.fn().mockResolvedValue({ project: 'orcha-x', apiPort: 8000, warnings: [] }),
    githubStatus: vi.fn().mockResolvedValue({ authenticated: false, gitInstalled: true }),
    githubRepos: vi.fn().mockResolvedValue([]),
    suggestCloneDest: vi.fn().mockResolvedValue({ parent: '/tmp/orcha-projects', repoName: 'repo' }),
    pickCloneDest: vi.fn().mockResolvedValue(null),
    cloneAndProvision: vi.fn().mockResolvedValue({ project: 'orcha-repo', apiPort: 8000, warnings: [] }),
    openOnboardingPortal: vi.fn(),
    openExternal: vi.fn(),
    onProvisionProgress: vi.fn().mockReturnValue(() => {}),
    onNavigate: vi.fn().mockImplementation((cb) => {
      navigateListener = cb
      return () => {}
    })
  } as never
}

describe('App single-window host', () => {
  beforeEach(() => vi.useRealTimers())

  it('starts in onboarding mode when there are no stacks', async () => {
    stub([])
    render(<App />)
    await waitFor(() => expect(screen.getByText(/set up orcha/i)).toBeInTheDocument())
  })

  it('starts in manager mode when stacks exist', async () => {
    stub([
      {
        project: 'orcha-x',
        projectShort: 'x',
        apiPort: 8000,
        dbPort: 5432,
        portalStatus: 'Up',
        running: true,
        folder: null
      }
    ])
    render(<App />)
    await waitFor(() => expect(screen.getByText(/orcha stacks/i)).toBeInTheDocument())
  })

  it('clicking the manager\'s Add project button opens the wizard in add-project framing, with Cancel back to the manager', async () => {
    stub([
      { project: 'orcha-x', projectShort: 'x', apiPort: 8000, dbPort: 5432, portalStatus: 'Up', running: true, folder: null }
    ])
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: /add project/i })).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /add project/i }))
    await waitFor(() => expect(screen.getByText(/add a project/i)).toBeInTheDocument())

    // add-project variant offers a Cancel back to the manager (first-run onboarding has none —
    // there's nowhere to cancel to before any stack exists).
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    await waitFor(() => expect(screen.getByText(/orcha stacks/i)).toBeInTheDocument())
  })

  it('File→Add Project (main-process menu IPC) switches an already-running manager into the wizard', async () => {
    stub([
      { project: 'orcha-x', projectShort: 'x', apiPort: 8000, dbPort: 5432, portalStatus: 'Up', running: true, folder: null }
    ])
    render(<App />)
    await waitFor(() => expect(screen.getByText(/orcha stacks/i)).toBeInTheDocument())

    // Simulate main's sendToManager('orcha:navigate', { target: 'onboarding', variant: 'add-project' }).
    expect(navigateListener).not.toBeNull()
    navigateListener?.({ target: 'onboarding', variant: 'add-project' })

    await waitFor(() => expect(screen.getByText(/add a project/i)).toBeInTheDocument())
  })
})
