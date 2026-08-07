// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FleetStep from './FleetStep'
import type { RosterSuggestResponse } from '../../../../shared/types'

const SUGGEST_PAYLOAD: RosterSuggestResponse = {
  available: true,
  project_kind: 'ios',
  signals: ['ios/', 'Package.swift'],
  suggestions: [
    { alias: 'Atlas', role: 'Lead', focus: 'Coordination', is_main: true, rationale: 'found ios/ + Package.swift' },
    { alias: 'Sable', role: 'iOS', focus: 'SwiftUI views', is_main: false, rationale: 'found ios/' }
  ]
}

function stubOrchaDesktop(overrides: Partial<typeof window.orchaDesktop> = {}) {
  window.orchaDesktop = {
    portalGet: vi.fn(),
    portalPost: vi.fn(),
    ...overrides
  } as never
}

describe('FleetStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders suggestions from a stubbed suggest payload, Atlas leads with the crown affordance', async () => {
    const portalGet = vi
      .fn()
      .mockResolvedValueOnce({ containers: [{ id: 'c1' }] }) // resolveContainerId
      .mockResolvedValueOnce(SUGGEST_PAYLOAD) // roster/suggest
      .mockResolvedValueOnce({ agents: [{ id: 'h1', kind: 'human' }] }) // resolveHumanAgentId
    stubOrchaDesktop({ portalGet })

    render(<FleetStep apiPort={8001} onDone={vi.fn()} onUnavailable={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Atlas')).toBeInTheDocument())
    expect(screen.getByText('Sable')).toBeInTheDocument()
    expect(screen.getByText(/found ios\/ \+ package\.swift/i)).toBeInTheDocument()
    expect(screen.getByLabelText('Lead agent')).toBeInTheDocument()
  })

  it('toggles suggestions and posts accept with only the selected ones', async () => {
    const portalGet = vi
      .fn()
      .mockResolvedValueOnce({ containers: [{ id: 'c1' }] })
      .mockResolvedValueOnce(SUGGEST_PAYLOAD)
      .mockResolvedValueOnce({ agents: [{ id: 'h1', kind: 'human' }] })
    const portalPost = vi.fn().mockResolvedValue({ created: ['Atlas'] })
    stubOrchaDesktop({ portalGet, portalPost })

    const user = userEvent.setup()
    render(<FleetStep apiPort={8001} onDone={vi.fn()} onUnavailable={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Sable')).toBeInTheDocument())
    // Both on by default.
    expect(screen.getByLabelText('Include Atlas')).toBeChecked()
    expect(screen.getByLabelText('Include Sable')).toBeChecked()

    await user.click(screen.getByLabelText('Include Sable'))
    expect(screen.getByLabelText('Include Sable')).not.toBeChecked()

    await user.click(screen.getByRole('button', { name: /create fleet/i }))

    await waitFor(() =>
      expect(portalPost).toHaveBeenCalledWith(8001, '/api/containers/c1/roster/suggest/accept', {
        suggestions: [SUGGEST_PAYLOAD.suggestions[0]],
        actor_agent_id: 'h1'
      })
    )
    await waitFor(() => expect(screen.getByText(/fleet created/i)).toBeInTheDocument())
  })

  it('auto-skips silently when the suggest endpoint 404s (older/open CLI portal)', async () => {
    const portalGet = vi
      .fn()
      .mockResolvedValueOnce({ containers: [{ id: 'c1' }] })
      .mockRejectedValueOnce({ code: 'PORTAL_REQUEST_FAILED', status: 404 })
    stubOrchaDesktop({ portalGet })

    const onUnavailable = vi.fn()
    render(<FleetStep apiPort={8001} onDone={vi.fn()} onUnavailable={onUnavailable} />)

    await waitFor(() => expect(onUnavailable).toHaveBeenCalled())
  })

  it('auto-skips when available is false', async () => {
    const portalGet = vi
      .fn()
      .mockResolvedValueOnce({ containers: [{ id: 'c1' }] })
      .mockResolvedValueOnce({ available: false, project_kind: 'unknown', signals: [], suggestions: [] })
    stubOrchaDesktop({ portalGet })

    const onUnavailable = vi.fn()
    render(<FleetStep apiPort={8001} onDone={vi.fn()} onUnavailable={onUnavailable} />)

    await waitFor(() => expect(onUnavailable).toHaveBeenCalled())
  })
})
