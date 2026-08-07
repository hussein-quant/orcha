// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FinishStep from './FinishStep'

describe('FinishStep', () => {
  it('renders a staggered summary and fires onOpenPortal on the CTA', async () => {
    const onOpenPortal = vi.fn()
    const user = userEvent.setup()
    render(
      <FinishStep
        project="orcha-demo"
        portalUrl="http://localhost:8001"
        fleetCreated
        onOpenPortal={onOpenPortal}
      />
    )

    expect(screen.getByText('orcha-demo is ready')).toBeInTheDocument()
    expect(screen.getByText('http://localhost:8001')).toBeInTheDocument()
    expect(screen.getByText('Created')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /open your portal/i }))
    expect(onOpenPortal).toHaveBeenCalled()
  })

  it('shows "Not created" when no fleet was made', () => {
    render(
      <FinishStep project="orcha-demo" portalUrl="http://localhost:8001" fleetCreated={false} onOpenPortal={vi.fn()} />
    )
    expect(screen.getByText('Not created')).toBeInTheDocument()
  })
})
