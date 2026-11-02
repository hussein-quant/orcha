/** Talk to Orcha (GH-409): the side panel — a project's REAL page (a task, a plan, a question)
 *  drawn beside the chat, without the project's header and tabs (the portal's `panel=1` mode).
 *
 *  One dedicated WebContentsView, separate from the project's own view, so peeking never
 *  moves what the project tab shows. It is not registered as a portal view: its portal→host
 *  messages are dropped. The renderer reports where the panel is (CSS px); main scales by the
 *  host zoom. Every input is validated: a known running project, a UUID cid, a safe portal path.
 *  Pure apart from the injected window / view factory (talkPeek.test.ts). */
import { isSafePath } from '../shared/embed'
import type { Stack } from '../shared/types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface PeekView {
  webContents: { loadURL(url: string): Promise<void>; close?(): void; isDestroyed(): boolean; focus(): void }
  setBounds(r: { x: number; y: number; width: number; height: number }): void
  setVisible(v: boolean): void
  setBorderRadius?(r: number): void
}
export interface PeekWindow {
  contentView: { children: unknown[]; addChildView(v: unknown): void; removeChildView(v: unknown): void }
}
export interface TalkPeekDeps {
  window(): PeekWindow | null
  stackFor(project: string): Promise<Pick<Stack, 'project' | 'apiPort'> | null>
  makeView(origin: string, project: string): PeekView
  zoom(): number
  hostModalOpen(): boolean
  /** after a page loads, how long to let it settle before showing it (no half-drawn page) */
  settleMs?: number
}
export interface TalkPeek {
  /** show `raw` ({project, cid, path, rect}) or hide (null); false when refused */
  show(raw: unknown): Promise<boolean>
  modal(open: boolean): void
}

/** The page the panel loads: the path with the container, the full view and panel mode. */
export function peekUrl(origin: string, path: string, cid: string): string {
  const u = new URL(path, origin)
  u.searchParams.set('cid', cid)
  if (u.searchParams.has('task')) u.searchParams.set('full', '1')
  u.searchParams.set('panel', '1')
  u.searchParams.set('embed', 'desktop')
  return u.toString()
}

type Rect = { x: number; y: number; width: number; height: number }

function parseRect(r: unknown): Rect | null {
  if (!r || typeof r !== 'object') return null
  const o = r as Record<string, unknown>
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 20_000 ? v : null)
  const x = n(o.x)
  const y = n(o.y)
  const width = n(o.width)
  const height = n(o.height)
  return x === null || y === null || width === null || height === null ? null : { x, y, width, height }
}

export function createTalkPeek(d: TalkPeekDeps): TalkPeek {
  let current: { view: PeekView; origin: string; url: string; ready: boolean } | null = null
  let wanted = false

  const hide = (): void => {
    wanted = false
    current?.view.setVisible(false)
  }

  return {
    async show(raw) {
      if (raw === null || raw === undefined) {
        hide()
        return true
      }
      const o = raw as Record<string, unknown>
      const rect = parseRect(o.rect)
      if (typeof o.project !== 'string' || typeof o.cid !== 'string' || !UUID.test(o.cid) || !isSafePath(o.path) || !rect) return false
      const win = d.window()
      const stack = await d.stackFor(o.project)
      if (!win || !stack || stack.apiPort === null) return false
      const origin = `http://localhost:${stack.apiPort}`
      if (current && current.origin !== origin) {
        // another project: a fresh view (the preload is bound to one origin)
        win.contentView.removeChildView(current.view)
        if (!current.view.webContents.isDestroyed()) current.view.webContents.close?.()
        current = null
      }
      if (!current) current = { view: d.makeView(origin, stack.project), origin, url: '', ready: false }
      const view = current.view
      if (!win.contentView.children.includes(view)) win.contentView.addChildView(view)
      const z = d.zoom() || 1
      view.setBounds({ x: Math.round(rect.x * z), y: Math.round(rect.y * z), width: Math.round(rect.width * z), height: Math.round(rect.height * z) })
      try {
        view.setBorderRadius?.(Math.round(10 * z))
      } catch {
        /* square is fine */
      }
      const url = peekUrl(origin, o.path, o.cid)
      wanted = true
      if (url !== current.url) {
        // a new page: keep it hidden (the panel says Loading…) until it has drawn
        current.url = url
        current.ready = false
        view.setVisible(false)
        const mine = current
        void view.webContents
          .loadURL(url)
          .catch(() => undefined)
          .then(() => new Promise((r) => setTimeout(r, d.settleMs ?? 350)))
          .then(() => {
            if (current !== mine || mine.url !== url) return
            mine.ready = true
            if (wanted) view.setVisible(!d.hostModalOpen())
          })
        return true
      }
      if (current.ready) view.setVisible(!d.hostModalOpen())
      return true
    },
    modal(open) {
      if (current && wanted && current.ready) current.view.setVisible(!open)
    }
  }
}
