// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'

/** Captured onNavigate listener so tests can simulate main→renderer IPC (e.g. the
 *  File→Add Project menu item) without a real Electron process. */
let navigateListener: ((nav: { target: 'onboarding' | 'manager'; variant?: string }) => void) | null = null
/** Captured onPortalActive listener so tests can simulate main's "which portal view is
 *  showing" broadcast (tray/notification/deep-link can change it without a click here). */
let portalActiveListener: ((active: { project: string | null }) => void) | null = null

function stub(stacks: unknown[]) {
  navigateListener = null
  portalActiveListener = null
  window.orchaDesktop = {
    listStacks: vi.fn().mockResolvedValue(stacks),
    startStack: vi.fn(),
    stopStack: vi.fn(),
    resetStack: vi.fn(),
    portalShow: vi.fn(),
    portalHide: vi.fn(),
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
    }),
    onPortalActive: vi.fn().mockImplementation((cb) => {
      portalActiveListener = cb
      return () => {}
    }),
    portalGet: vi.fn().mockRejectedValue({ code: 'PORTAL_REQUEST_FAILED', status: 404 }),
    portalPost: vi.fn().mockRejectedValue({ code: 'PORTAL_REQUEST_FAILED', status: 404 })
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
    // "Add project…" (header, ManagerView) vs "Add project" (rail icon button) both match
    // /add project/i — target the header's ellipsis copy specifically.
    await waitFor(() => expect(screen.getByRole('button', { name: /add project…/i })).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /add project…/i }))
    await waitFor(() => expect(screen.getByText(/add a project/i)).toBeInTheDocument())

    // add-project variant offers a Cancel back to the manager (first-run onboarding has none —
    // there's nowhere to cancel to before any stack exists).
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    await waitFor(() => expect(screen.getByText(/orcha stacks/i)).toBeInTheDocument())
  })

  it('clicking the rail\'s Add project button also opens the wizard, hiding any embedded portal first', async () => {
    stub([
      { project: 'orcha-x', projectShort: 'x', apiPort: 8000, dbPort: 5432, portalStatus: 'Up', running: true, folder: null }
    ])
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'x' })).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Add project' }))
    await waitFor(() => expect(screen.getByText(/add a project/i)).toBeInTheDocument())
    expect(window.orchaDesktop.portalHide).toHaveBeenCalled()
  })

  it('clicking a stack in the rail calls portalShow for that project', async () => {
    stub([
      { project: 'orcha-x', projectShort: 'x', apiPort: 8000, dbPort: 5432, portalStatus: 'Up', running: true, folder: null }
    ])
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'x' })).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'x' }))
    expect(window.orchaDesktop.portalShow).toHaveBeenCalledWith('orcha-x')
  })

  it('clicking All projects in the rail calls portalHide', async () => {
    stub([
      { project: 'orcha-x', projectShort: 'x', apiPort: 8000, dbPort: 5432, portalStatus: 'Up', running: true, folder: null }
    ])
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'All projects' })).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'All projects' }))
    expect(window.orchaDesktop.portalHide).toHaveBeenCalled()
  })

  it('mirrors main\'s onPortalActive into the rail\'s active highlight', async () => {
    stub([
      { project: 'orcha-x', projectShort: 'x', apiPort: 8000, dbPort: 5432, portalStatus: 'Up', running: true, folder: null }
    ])
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'x' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'All projects' })).toHaveAttribute('aria-pressed', 'true')

    expect(portalActiveListener).not.toBeNull()
    portalActiveListener?.({ project: 'orcha-x' })

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'x' })).toHaveAttribute('aria-pressed', 'true')
    )
    expect(screen.getByRole('button', { name: 'All projects' })).toHaveAttribute('aria-pressed', 'false')
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
