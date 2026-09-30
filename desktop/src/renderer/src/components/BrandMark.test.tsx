// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BrandMark } from './BrandMark'
import { OrchaMark } from './OrchaMark'
import { OrchaMark as OnboardingOrchaMark } from '../onboarding/ui'
import { PRODUCT_NAME } from '../../../shared/brand'
import master from '../../../../resources/logo-mark.svg?raw'
import indexHtml from '../../index.html?raw'

describe('BrandMark (Quorate orca)', () => {
  it('renders the orca at the requested height, ~1.8:1 wide, decorative', () => {
    render(<BrandMark size={18} className="shrink-0" />)
    const svg = screen.getByTestId('brand-mark')
    expect(svg.getAttribute('height')).toBe('18')
    expect(svg.getAttribute('width')).toBe('33')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveClass('shrink-0')
    // Silhouette (with cream keyline) + cream patches — not the old three-segment ring.
    const paths = svg.querySelectorAll('path')
    expect(paths).toHaveLength(2)
    expect(paths[0].getAttribute('stroke')).toBe('#F6F2EC')
    expect(paths[1].getAttribute('fill-rule')).toBe('evenodd')
  })

  it('uses the same geometry as resources/logo-mark.svg', () => {
    const ds = [...master.matchAll(/ d="([^"]+)"/g)].map((m) => m[1])
    render(<BrandMark />)
    const got = [...screen.getByTestId('brand-mark').querySelectorAll('path')].map((p) => p.getAttribute('d'))
    expect(got).toEqual(ds)
  })

  it('keeps the OrchaMark API as a compat alias (components + onboarding re-export)', () => {
    expect(OrchaMark).toBe(BrandMark)
    expect(OnboardingOrchaMark).toBe(BrandMark)
  })
})

describe('renderer branding', () => {
  it('product name is Quorate and the window title follows it', () => {
    expect(PRODUCT_NAME).toBe('Quorate')
    expect(indexHtml).toContain('<title>Quorate</title>')
  })
})
