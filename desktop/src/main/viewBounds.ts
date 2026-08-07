/** Pure bounds math for the embedded portal WebContentsView. Kept side-effect-free (no
 *  Electron imports) so it's unit-testable without a running app — index.ts calls this on
 *  window creation, on 'resize', and whenever the rail width could change. */
import { RAIL_WIDTH } from '../shared/types'

export interface Size {
  width: number
  height: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export { RAIL_WIDTH }

/** Compute the embedded portal view's bounds: the window's content area minus the rail
 *  reserved on the left. Clamped to zero so a window shrunk below the rail width never
 *  yields a negative-width view (Electron throws on negative bounds). */
export function computeViewBounds(windowSize: Size, railWidth: number = RAIL_WIDTH): Rect {
  const x = Math.max(0, Math.min(railWidth, windowSize.width))
  const width = Math.max(0, windowSize.width - x)
  const height = Math.max(0, windowSize.height)
  return { x, y: 0, width, height }
}
