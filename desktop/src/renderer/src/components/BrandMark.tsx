import { useId } from 'react'

/** Embodent mark geometry, in the 1254-unit space of resources/logo-mark.svg: a head circle
 *  over a thick arch. Drawn twice, clipped to the left (light) and right (grey) halves. */
const HEAD = { cx: 627, cy: 299, r: 146 }
const ARCH = 'M366 940 L366 838 A261 261 0 0 1 888 838 L888 940'
export const MARK_LIGHT = '#ECEDF1'
export const MARK_GREY = '#7C808A'
export const MARK_TILE = '#121314'

/** The tile is a square centred on the figure (744×898 units, centre 627,602) with margin. */
const TILE = { x: -98, y: -123, side: 1450, rx: 326 }

/** The Embodent product mark, always on its own dark rounded tile (#121314) so the light half
 *  reads on both the light and the dark canvas. Square: `size` is the side. Decorative
 *  (aria-hidden) — the product name next to it is the accessible text. */
export function BrandMark({ size = 18, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '')
  const fig = (
    <>
      <circle cx={HEAD.cx} cy={HEAD.cy} r={HEAD.r} />
      <path d={ARCH} fill="none" strokeWidth={222} strokeLinecap="round" />
    </>
  )
  return (
    <svg
      viewBox={`${TILE.x} ${TILE.y} ${TILE.side} ${TILE.side}`}
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
      data-testid="brand-mark"
    >
      <defs>
        <clipPath id={`${id}-l`}>
          <rect x={TILE.x} y={TILE.y} width={627 - TILE.x} height={TILE.side} />
        </clipPath>
        <clipPath id={`${id}-r`}>
          <rect x={627} y={TILE.y} width={TILE.x + TILE.side - 627} height={TILE.side} />
        </clipPath>
      </defs>
      <rect x={TILE.x} y={TILE.y} width={TILE.side} height={TILE.side} rx={TILE.rx} fill={MARK_TILE} />
      <g clipPath={`url(#${id}-l)`} fill={MARK_LIGHT} stroke={MARK_LIGHT}>
        {fig}
      </g>
      <g clipPath={`url(#${id}-r)`} fill={MARK_GREY} stroke={MARK_GREY}>
        {fig}
      </g>
    </svg>
  )
}
