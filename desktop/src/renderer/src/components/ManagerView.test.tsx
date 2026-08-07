// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ManagerView from './ManagerView'
import type { Stack } from '../../../shared/types'

const runningStack: Stack = {
  project: 'orcha-quantal-ehr',
  projectShort: 'quantal-ehr',
  apiPort: 8001,
  dbPort: 5435,
  portalStatus: 'Up 4 hours',
  running: true,
  folder: '/Users/x/dev/quantal-ehr'
}

beforeEach(() => {
  window.orchaDesktop = {
    listStacks: vi.fn().mockResolvedValue([runningStack]),
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
    openOnboardingPortal: vi.fn().mockResolvedValue(undefined),
    openExternal: vi.fn().mockResolvedValue(undefined),
    onProvisionProgress: vi.fn().mockReturnValue(() => {}),
    onNavigate: vi.fn().mockReturnValue(() => {}),
    onPortalActive: vi.fn().mockReturnValue(() => {}),
    portalGet: vi.fn(),
    portalPost: vi.fn()
  }
})

describe('ManagerView', () => {
  it('renders an Add project button in the header once stacks exist', async () => {
    render(<ManagerView onCreate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('quantal-ehr')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /add project/i })).toBeInTheDocument()
  })

  it('calls onCreate when Add project is clicked', async () => {
    const onCreate = vi.fn()
    render(<ManagerView onCreate={onCreate} />)
    await waitFor(() => expect(screen.getByText('quantal-ehr')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /add project/i }))
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  it('omits the header Add-project button on the empty state (EmptyState carries its own CTA)', async () => {
    ;(window.orchaDesktop.listStacks as ReturnType<typeof vi.fn>).mockResolvedValue([])
    render(<ManagerView onCreate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/no orcha stacks yet/i)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /^add project/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /create your first project/i })).toBeInTheDocument()
  })
})
