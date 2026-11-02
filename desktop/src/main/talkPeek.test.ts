import { describe, expect, it, vi } from 'vitest'
import { createTalkPeek, peekUrl, type PeekView } from './talkPeek'

const CID = 'e8b78ee9-0a6b-4520-8143-ddc1eddab117'
const TASK = '178d614f-d532-4a98-8175-b3d4e34b6810'

function rig(opts: { modal?: boolean } = {}) {
  const children: unknown[] = []
  const views: (PeekView & { loads: string[]; visible: boolean | null; bounds: unknown })[] = []
  const peek = createTalkPeek({
    window: () => ({
      contentView: {
        children,
        addChildView: (v) => children.push(v),
        removeChildView: (v) => children.splice(children.indexOf(v), 1)
      }
    }),
    stackFor: async (p) => (p === 'orcha-fleet' ? { project: p, apiPort: 8002 } : p === 'orcha-slate' ? { project: p, apiPort: 8001 } : null),
    makeView: () => {
      const v = {
        loads: [] as string[],
        visible: null as boolean | null,
        bounds: null as unknown,
        webContents: { loadURL: async (u: string) => void v.loads.push(u), isDestroyed: () => false, focus: () => undefined, close: vi.fn() },
        setBounds: (r: unknown) => void (v.bounds = r),
        setVisible: (b: boolean) => void (v.visible = b)
      }
      views.push(v)
      return v
    },
    zoom: () => 2,
    hostModalOpen: () => opts.modal === true,
    settleMs: 0
  })
  return { peek, views, children }
}

const rect = { x: 500, y: 40, width: 400, height: 700 }

describe('Talk side panel', () => {
  it('loads the real task page in panel mode, scaled to the host zoom', async () => {
    const r = rig()
    expect(await r.peek.show({ project: 'orcha-fleet', cid: CID, path: `/tasks?task=${TASK}`, rect })).toBe(true)
    const v = r.views[0]
    expect(v.loads).toHaveLength(1)
    const u = new URL(v.loads[0])
    expect(u.origin).toBe('http://localhost:8002')
    expect(Object.fromEntries(u.searchParams)).toEqual({ task: TASK, cid: CID, full: '1', panel: '1', embed: 'desktop' })
    expect(v.bounds).toEqual({ x: 1000, y: 80, width: 800, height: 1400 })
    expect(v.visible).toBe(false) // hidden until the page has drawn
    await vi.waitFor(() => expect(v.visible).toBe(true))
  })

  it('a new rect only moves it; the same page is not reloaded; null hides it', async () => {
    const r = rig()
    await r.peek.show({ project: 'orcha-fleet', cid: CID, path: `/tasks?task=${TASK}`, rect })
    await r.peek.show({ project: 'orcha-fleet', cid: CID, path: `/tasks?task=${TASK}`, rect: { ...rect, width: 300 } })
    expect(r.views[0].loads).toHaveLength(1)
    expect(await r.peek.show(null)).toBe(true)
    expect(r.views[0].visible).toBe(false)
  })

  it('another project gets a fresh view (the preload is bound to one origin)', async () => {
    const r = rig()
    await r.peek.show({ project: 'orcha-fleet', cid: CID, path: '/', rect })
    await r.peek.show({ project: 'orcha-slate', cid: CID, path: '/', rect })
    expect(r.views).toHaveLength(2)
    expect(r.children).toEqual([r.views[1]])
  })

  it('refuses unknown projects, bad ids, unsafe paths and bad rects', async () => {
    const r = rig()
    expect(await r.peek.show({ project: 'nope', cid: CID, path: '/', rect })).toBe(false)
    expect(await r.peek.show({ project: 'orcha-fleet', cid: 'x', path: '/', rect })).toBe(false)
    expect(await r.peek.show({ project: 'orcha-fleet', cid: CID, path: 'https://evil.test/', rect })).toBe(false)
    expect(await r.peek.show({ project: 'orcha-fleet', cid: CID, path: '/', rect: { x: -1, y: 0, width: 1, height: 1 } })).toBe(false)
    expect(r.views).toHaveLength(0)
  })

  it('stays hidden under a host dialog', async () => {
    const r = rig({ modal: true })
    await r.peek.show({ project: 'orcha-fleet', cid: CID, path: '/', rect })
    await new Promise((res) => setTimeout(res, 5))
    expect(r.views[0].visible).toBe(false)
  })

  it('builds the panel URL', () => {
    expect(peekUrl('http://localhost:8005', '/requests?req=abc', CID)).toBe(`http://localhost:8005/requests?req=abc&cid=${CID}&panel=1&embed=desktop`)
  })
})
