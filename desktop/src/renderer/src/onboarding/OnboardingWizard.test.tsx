// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OnboardingWizard from './OnboardingWizard'

beforeEach(() => {
  window.orchaDesktop = {
    listStacks: vi.fn().mockResolvedValue([]),
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
    pickFolder: vi.fn().mockResolvedValue({ folder: '/tmp/demo', mode: 'existing' }),
    inspectFolder: vi
      .fn()
      .mockResolvedValue({ initialized: false, writable: true, suggestedName: 'demo', isGitRepo: true }),
    provision: vi.fn().mockResolvedValue({ project: 'orcha-demo', apiPort: 8001, warnings: [] }),
    githubStatus: vi.fn().mockResolvedValue({ authenticated: false, gitInstalled: true }),
    githubRepos: vi.fn().mockResolvedValue([]),
    suggestCloneDest: vi.fn().mockResolvedValue({ parent: '/tmp/orcha-projects', repoName: 'demo' }),
    pickCloneDest: vi.fn().mockResolvedValue('/tmp/orcha-projects/demo'),
    cloneAndProvision: vi.fn().mockResolvedValue({ project: 'orcha-demo', apiPort: 8001, warnings: [] }),
    openOnboardingPortal: vi.fn().mockResolvedValue(undefined),
    openExternal: vi.fn().mockResolvedValue(undefined),
    onProvisionProgress: vi.fn().mockReturnValue(() => {}),
    onNavigate: vi.fn().mockReturnValue(() => {})
  }
})

async function continueToSource(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: /continue/i }))
  await waitFor(() => expect(screen.getByText(/where's the project/i)).toBeInTheDocument())
}

describe('OnboardingWizard — local folder source', () => {
  it('walks preflight → source → folder → details → provision and hands off to the portal', async () => {
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={onDone} />)

    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /local folder/i }))

    // Folder step
    await user.click(screen.getByRole('button', { name: /choose existing folder/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /next/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /next/i }))

    // Details step (name prefilled) → Create
    await waitFor(() => expect(screen.getByDisplayValue('demo')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /create project/i }))

    expect(window.orchaDesktop.provision).toHaveBeenCalledWith(
      expect.objectContaining({ folder: '/tmp/demo', mode: 'init', name: 'demo' })
    )
    // Success → portal handoff + onDone (isGitRepo: true → no pause on the git tip)
    await waitFor(() => expect(window.orchaDesktop.openOnboardingPortal).toHaveBeenCalledWith('orcha-demo'))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it('reconnects (mode upgrade) and skips the Details step for an already-initialized folder', async () => {
    ;(window.orchaDesktop.inspectFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
      initialized: true,
      writable: true,
      suggestedName: 'demo',
      isGitRepo: true
    })
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={onDone} />)

    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /local folder/i }))
    await user.click(screen.getByRole('button', { name: /choose existing folder/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /next/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /next/i }))

    // Reconnect fires straight from Folder's Next — no Details step, no "Create project" button.
    await waitFor(() =>
      expect(window.orchaDesktop.provision).toHaveBeenCalledWith(
        expect.objectContaining({ folder: '/tmp/demo', mode: 'upgrade' })
      )
    )
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it('shows the git-init tip and pauses on Continue for a non-git folder', async () => {
    ;(window.orchaDesktop.inspectFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
      initialized: false,
      writable: true,
      suggestedName: 'demo',
      isGitRepo: false
    })
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={onDone} />)

    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /local folder/i }))
    await user.click(screen.getByRole('button', { name: /choose existing folder/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /next/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /next/i }))
    await waitFor(() => expect(screen.getByDisplayValue('demo')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /create project/i }))

    expect(await screen.findByText(/git init.*unlocks the local code-source features/i)).toBeInTheDocument()
    // Paused — portal handoff waits on the explicit Continue click.
    expect(window.orchaDesktop.openOnboardingPortal).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /continue to portal/i }))
    await waitFor(() => expect(window.orchaDesktop.openOnboardingPortal).toHaveBeenCalledWith('orcha-demo'))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it('ignores progress events from a stale run id', async () => {
    type ProgressCb = (e: { runId: string; step: string; status: string; line?: string }) => void
    const holder: { cb: ProgressCb | null } = { cb: null }
    ;(window.orchaDesktop.onProvisionProgress as ReturnType<typeof vi.fn>).mockImplementation(
      (f: ProgressCb) => {
        holder.cb = f
        return () => {}
      }
    )
    render(<OnboardingWizard onDone={vi.fn()} />)
    await waitFor(() => expect(window.orchaDesktop.onProvisionProgress).toHaveBeenCalled())
    holder.cb?.({ runId: 'stale', step: 'compose-up', status: 'log', line: 'noise' })
    expect(screen.queryByText(/noise/)).not.toBeInTheDocument()
  })
})

describe('OnboardingWizard — From GitHub source', () => {
  it('gh-authenticated: lists repos, picks one, clones, then provisions', async () => {
    ;(window.orchaDesktop.githubStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      authenticated: true,
      gitInstalled: true
    })
    ;(window.orchaDesktop.githubRepos as ReturnType<typeof vi.fn>).mockResolvedValue([
      { nameWithOwner: 'open-orcha/orcha', description: 'The orcha CLI' }
    ])
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={onDone} />)

    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /from github/i }))

    await waitFor(() => expect(screen.getByText('open-orcha/orcha')).toBeInTheDocument())
    await user.click(screen.getByText('open-orcha/orcha'))

    await waitFor(() => expect(screen.getByRole('button', { name: /choose destination/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /choose destination/i }))
    await waitFor(() => expect(screen.getByText('/tmp/orcha-projects/demo')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /clone.*continue/i }))

    expect(window.orchaDesktop.cloneAndProvision).toHaveBeenCalledWith({
      repoUrl: 'https://github.com/open-orcha/orcha',
      dest: '/tmp/orcha-projects/demo'
    })
    await waitFor(() => expect(window.orchaDesktop.openOnboardingPortal).toHaveBeenCalledWith('orcha-demo'))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it('falls back to the URL field alone when gh is not authenticated', async () => {
    ;(window.orchaDesktop.githubStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      authenticated: false,
      gitInstalled: true
    })
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} />)

    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /from github/i }))

    await waitFor(() => expect(screen.getByText(/no authenticated gh cli/i)).toBeInTheDocument())
    expect(window.orchaDesktop.githubRepos).not.toHaveBeenCalled()
    expect(screen.getByLabelText(/repository url/i)).toBeInTheDocument()
  })

  it('rejects an invalid repo URL inline (ssh/http/garbage never reach the main process)', async () => {
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} />)

    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /from github/i }))

    const urlField = await screen.findByLabelText(/repository url/i)
    await user.type(urlField, 'git@github.com:open-orcha/orcha.git')
    expect(await screen.findByText(/ssh urls aren.t supported/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /choose destination/i })).not.toBeInTheDocument()
  })

  it('refuses a non-empty destination (pickCloneDest resolves null) without crashing', async () => {
    ;(window.orchaDesktop.pickCloneDest as ReturnType<typeof vi.fn>).mockRejectedValue({
      code: 'DEST_NOT_EMPTY'
    })
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} />)

    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /from github/i }))
    const urlField = await screen.findByLabelText(/repository url/i)
    await user.type(urlField, 'https://github.com/open-orcha/orcha')

    await waitFor(() => expect(screen.getByRole('button', { name: /choose destination/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /choose destination/i }))

    expect(await screen.findByText(/isn.t empty/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /clone.*continue/i })).toBeDisabled()
  })

  it('streams clone-repo progress into the same provisioning UI', async () => {
    ;(window.orchaDesktop.githubStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      authenticated: true,
      gitInstalled: true
    })
    ;(window.orchaDesktop.githubRepos as ReturnType<typeof vi.fn>).mockResolvedValue([
      { nameWithOwner: 'open-orcha/orcha', description: null }
    ])
    type ProgressCb = (e: { runId: string; step: string; status: string; line?: string }) => void
    const holder: { cb: ProgressCb | null } = { cb: null }
    ;(window.orchaDesktop.onProvisionProgress as ReturnType<typeof vi.fn>).mockImplementation(
      (f: ProgressCb) => {
        holder.cb = f
        return () => {}
      }
    )
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={vi.fn()} />)

    await continueToSource(user)
    await user.click(screen.getByRole('button', { name: /from github/i }))
    await waitFor(() => expect(screen.getByText('open-orcha/orcha')).toBeInTheDocument())
    await user.click(screen.getByText('open-orcha/orcha'))
    await waitFor(() => expect(screen.getByRole('button', { name: /choose destination/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /choose destination/i }))
    await waitFor(() => expect(screen.getByText('/tmp/orcha-projects/demo')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /clone.*continue/i }))

    holder.cb?.({ runId: 'r1', step: 'clone-repo', status: 'log', line: 'Receiving objects: 42%' })
    expect(await screen.findByText(/receiving objects: 42%/i)).toBeInTheDocument()
  })
})
