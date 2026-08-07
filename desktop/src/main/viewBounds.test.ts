import { describe, it, expect } from 'vitest'
import { computeViewBounds, RAIL_WIDTH } from './viewBounds'

describe('computeViewBounds', () => {
  it('offsets the view by the rail width and fills the remaining window', () => {
    const bounds = computeViewBounds({ width: 1200, height: 800 })
    expect(bounds).toEqual({ x: RAIL_WIDTH, y: 0, width: 1200 - RAIL_WIDTH, height: 800 })
  })

  it('recomputes as the window resizes', () => {
    expect(computeViewBounds({ width: 900, height: 600 })).toEqual({
      x: RAIL_WIDTH,
      y: 0,
      width: 900 - RAIL_WIDTH,
      height: 600
    })
  })

  it('honors a custom rail width', () => {
    expect(computeViewBounds({ width: 1000, height: 500 }, 200)).toEqual({
      x: 200,
      y: 0,
      width: 800,
      height: 500
    })
  })

  it('clamps to zero width instead of going negative when the window is narrower than the rail', () => {
    const bounds = computeViewBounds({ width: 40, height: 300 })
    expect(bounds.x).toBe(40)
    expect(bounds.width).toBe(0)
    expect(bounds.width).toBeGreaterThanOrEqual(0)
  })

  it('clamps a zero-size window to zero-size bounds', () => {
    expect(computeViewBounds({ width: 0, height: 0 })).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })

  it('never returns a negative x, width, or height for degenerate input', () => {
    const bounds = computeViewBounds({ width: -10, height: -5 })
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.width).toBeGreaterThanOrEqual(0)
    expect(bounds.height).toBeGreaterThanOrEqual(0)
  })
})
