import { useEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { chunkWrite, type TermApi } from '../../../shared/terminal'
import type { TermClient } from './termClient'
import { terminalShouldSkip } from './commandModel'

/** V2 dark tokens (styles.css @theme) mapped onto the terminal palette. The background is the
 *  dock surface (--color-card) so the terminal reads as part of the raised panel. */
export const TERMINAL_THEME: ITheme = {
  background: '#191a1d',
  foreground: '#e3e4e8',
  cursor: '#8d93f7',
  cursorAccent: '#191a1d',
  selectionBackground: 'rgba(141, 147, 247, 0.28)',
  selectionInactiveBackground: 'rgba(141, 147, 247, 0.16)',
  scrollbarSliderBackground: 'rgba(255, 255, 255, 0.10)',
  scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.18)',
  scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.24)',
  black: '#2b2d33',
  red: '#ee7070',
  green: '#4cb782',
  yellow: '#e2a336',
  blue: '#4ea7fc',
  magenta: '#b59cf7',
  cyan: '#4cc3c7',
  white: '#c9cbd2',
  brightBlack: '#6b6f7a',
  brightRed: '#f59090',
  brightGreen: '#6fd09f',
  brightYellow: '#f0bd5e',
  brightBlue: '#78bcfd',
  brightMagenta: '#cbb8fa',
  brightCyan: '#74d6d9',
  brightWhite: '#eeeff2'
}

/** Monospace only inside the terminal (D15). SF Mono / Menlo ship with macOS. */
export const TERMINAL_FONT = "'JetBrains Mono', 'SF Mono', SFMono-Regular, ui-monospace, Menlo, monospace"

/** One xterm bound to one pty. Kept mounted (hidden) while its tab is in the background so
 *  scrollback and TUI state survive tab switches; `visible` triggers a re-fit on show. */
export default function TerminalView({
  ptyId,
  api,
  client,
  visible,
  focusToken,
  exited
}: {
  ptyId: number
  api: TermApi
  client: TermClient
  visible: boolean
  /** Changes whenever the tab should grab keyboard focus (activation, open). */
  focusToken: number
  exited: boolean
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const exitedRef = useRef(exited)
  exitedRef.current = exited

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const term = new Terminal({
      theme: TERMINAL_THEME,
      fontFamily: TERMINAL_FONT,
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      allowProposedApi: false,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      scrollback: 5000,
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: 1
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // Links open in the user's browser through the validated https-only bridge.
    term.loadAddon(
      new WebLinksAddon((_e, uri) => {
        void window.orchaDesktop?.openExternal?.(uri)?.catch?.(() => {})
      })
    )
    // Host shortcuts (⌘K, ⌘1-9) and menu-bar accelerators (⌘T, ⌘W…) must not be eaten by
    // the terminal — every other key goes to the shell.
    term.attachCustomKeyEventHandler((e) => !terminalShouldSkip(e))
    term.open(el)
    termRef.current = term
    fitRef.current = fit

    const detach = client.attach(ptyId, (data) => term.write(data))
    const onData = term.onData((data) => {
      if (exitedRef.current) return
      for (const chunk of chunkWrite(data)) api.write(ptyId, chunk)
    })
    const onResize = term.onResize(({ cols, rows }) => api.resize(ptyId, cols, rows))

    let raf = 0
    const refit = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        if (!el.isConnected || el.clientWidth === 0 || el.clientHeight === 0) return
        try {
          fit.fit()
        } catch {
          // measuring while hidden can throw; the next resize re-fits
        }
      })
    }
    const ro = new ResizeObserver(refit)
    ro.observe(el)
    refit()
    // The pty was created at a default size; tell it the real one even if fit() was a no-op.
    api.resize(ptyId, term.cols, term.rows)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      detach()
      onData.dispose()
      onResize.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [ptyId, api, client])

  // A finished process leaves no live cursor behind (the exit bar says what happened).
  useEffect(() => {
    if (exited) termRef.current?.write('\x1b[?25l')
  }, [exited])

  useEffect(() => {
    if (!visible) return
    const id = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        // not measurable yet
      }
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [visible, focusToken])

  return (
    <div
      ref={hostRef}
      data-testid="terminal-view"
      data-pty={ptyId}
      className="orcha-xterm absolute inset-0 pl-3 pr-1 pt-2 pb-1"
      style={{ display: visible ? 'block' : 'none' }}
    />
  )
}
