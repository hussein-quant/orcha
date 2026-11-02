/** The Talk orb (GH-409): a soft blue sphere with drifting cloud, like ChatGPT's voice mode.
 *  listening — swells with your voice · speaking — moves with Orcha's voice ·
 *  thinking — a slow breath · idle — still. Driven per frame from `voiceLevel` through CSS
 *  variables (never a React re-render). prefers-reduced-motion: a calm, static orb. */
import { useEffect, useRef } from 'react'
import { voiceLevel } from './voice'

export type OrbMode = 'idle' | 'listening' | 'speaking' | 'thinking'

export function Orb({ mode, size = 120 }: { mode: OrbMode; size?: number }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      el.style.setProperty('--orb-scale', '1')
      return
    }
    let raf = 0
    let smooth = 0
    let t = 0
    const frame = (): void => {
      t += 1 / 60
      const target =
        mode === 'thinking' ? 0.2 + 0.14 * Math.sin(t * 2.4) : mode === 'idle' ? 0.04 + 0.03 * Math.sin(t * 1.2) : voiceLevel.value
      smooth += (target - smooth) * (target > smooth ? 0.35 : 0.1)
      el.style.setProperty('--orb-scale', (1 + smooth * 0.16).toFixed(3))
      el.style.setProperty('--orb-drift', `${((t * (mode === 'listening' ? 22 : mode === 'speaking' ? 30 : 10)) % 360).toFixed(1)}deg`)
      el.style.setProperty('--orb-rise', `${(Math.sin(t * 0.9) * 6 + smooth * 18).toFixed(1)}%`)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [mode])
  return (
    <div className="talk-orb" data-mode={mode} aria-hidden="true" style={{ width: size, height: size }}>
      <div className="talk-orb-core" ref={ref}>
        <div className="talk-orb-cloud" />
      </div>
    </div>
  )
}
