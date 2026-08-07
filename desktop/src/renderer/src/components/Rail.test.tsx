// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Rail from './Rail'
import type { Stack } from '../../../shared/types'

const stacks: Stack[] = [
  {
    project: 'orcha-quantal-ehr',
    projectShort: 'quantal-ehr',
    apiPort: 8001,
    dbPort: 5435,
    portalStatus: 'Up 4 hours',
    running: true,
    folder: null
  },
  {
    project: 'orcha-demo',
    projectShort: 'demo',
    apiPort: null,
    dbPort: null,
    portalStatus: 'Exited (0) 2 days ago',
    running: false,
    folder: null
  }
]

function renderRail(overrides: Partial<React.ComponentProps<typeof Rail>> = {}) {
  const onSelectStack = vi.fn()
  const onSelectHome = vi.fn()
  const onAddProject = vi.fn()
  render(
    <Rail
      stacks={stacks}
      activeProject={null}
      attentionCounts={new Map()}
      onSelectStack={onSelectStack}
      onSelectHome={onSelectHome}
      onAddProject={onAddProject}
      {...overrides}
    />
  )
  return { onSelectStack, onSelectHome, onAddProject }
}

describe('Rail', () => {
  it('renders one entry per stack, plus All projects and Add project', () => {
    renderRail()
    expect(screen.getByRole('button', { name: 'quantal-ehr' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'demo' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'All projects' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add project' })).toBeInTheDocument()
  })

  it('marks All projects as active when activeProject is null', () => {
    renderRail({ activeProject: null })
    expect(screen.getByRole('button', { name: 'All projects' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'quantal-ehr' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('marks the matching stack as active and All projects as inactive', () => {
    renderRail({ activeProject: 'orcha-quantal-ehr' })
    expect(screen.getByRole('button', { name: 'quantal-ehr' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'demo' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'All projects' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('clicking a stack calls onSelectStack with that stack', async () => {
    const { onSelectStack } = renderRail()
    await userEvent.click(screen.getByRole('button', { name: 'quantal-ehr' }))
    expect(onSelectStack).toHaveBeenCalledWith(stacks[0])
  })

  it('clicking All projects calls onSelectHome', async () => {
    const { onSelectHome } = renderRail()
    await userEvent.click(screen.getByRole('button', { name: 'All projects' }))
    expect(onSelectHome).toHaveBeenCalledTimes(1)
  })

  it('clicking Add project calls onAddProject', async () => {
    const { onAddProject } = renderRail()
    await userEvent.click(screen.getByRole('button', { name: 'Add project' }))
    expect(onAddProject).toHaveBeenCalledTimes(1)
  })

  it('shows an attention badge count for a stack with pending items', () => {
    renderRail({ attentionCounts: new Map([['orcha-quantal-ehr', 3]]) })
    expect(screen.getByText('3')).toBeInTheDocument()
  })
})
