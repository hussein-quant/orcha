import { describe, expect, it, vi } from 'vitest'
import type { TalkApi, TalkConversation, TalkReply } from '../../../shared/talk'
import { DEFAULT_TALK_PREFS } from './prefs'
import { TalkSession } from './session'

const conv: TalkConversation = { id: 'c', title: 'New chat', createdAt: '', updatedAt: '', scope: null, turns: [] }

function rig() {
  let ev: { onSpeechStart(): void; onUtterance(wav: Blob): void } | null = null
  const calls: string[] = []
  const listener = {
    hearing: false,
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    mute: vi.fn(),
    finish: vi.fn(),
    setAuto: vi.fn((on: boolean) => calls.push(`auto:${on}`)),
    hold: vi.fn((on: boolean) => {
      calls.push(`hold:${on}`)
      listener.hearing = on
      if (on) ev?.onSpeechStart()
      else if (long) ev?.onUtterance(new Blob(['x']))
    })
  }
  let long = true
  const api = {
    speech: vi.fn(async () => ({ installed: true, ready: true, reason: null })),
    create: vi.fn(async () => conv),
    listen: vi.fn(async () => 'what needs me'),
    send: vi.fn(async (): Promise<TalkReply> => ({
      conversation: { ...conv, turns: [{ id: 't', who: 'orcha', text: 'Two things.', at: '' }] },
      turn: { id: 't', who: 'orcha', text: 'Two things.', at: '' },
      next: 'reply'
    })),
    projects: vi.fn(async () => []),
    list: vi.fn(async () => [])
  } as unknown as TalkApi
  const speak = vi.fn(async () => undefined)
  const session = new TalkSession({
    api,
    prefs: () => DEFAULT_TALK_PREFS,
    listener: (e) => {
      ev = e
      return listener
    },
    speaker: () => ({ speak, stop: vi.fn() }),
    defaultScope: () => null,
    setTimer: () => 0,
    clearTimer: () => undefined,
    now: () => 0
  })
  return { session, listener, api, speak, calls, short: () => (long = false) }
}

describe('hold Space to talk', () => {
  it('starts voice push-to-talk only, records while held, sends on release and reads the reply', async () => {
    const r = rig()
    await r.session.holdStart()
    expect(r.calls).toEqual(['auto:false', 'hold:true'])
    expect(r.session.getState()).toMatchObject({ voice: true, handsFree: false, phase: 'hearing' })
    r.session.holdEnd()
    await vi.waitFor(() => expect(r.api.send).toHaveBeenCalled())
    expect(r.api.send).toHaveBeenCalledWith(expect.objectContaining({ text: 'what needs me', via: 'voice' }))
    await vi.waitFor(() => expect(r.speak).toHaveBeenCalledWith('Two things.'))
    // push-to-talk: after the reply it waits for the next press, not listening on its own
    await vi.waitFor(() => expect(r.session.getState().phase).toBe('idle'))
  })

  it('a tap too short to be speech sends nothing and goes back to idle', async () => {
    const r = rig()
    r.short()
    await r.session.holdStart()
    r.session.holdEnd()
    expect(r.session.getState().phase).toBe('idle')
    expect(r.api.listen).not.toHaveBeenCalled()
  })

  it('the orb switches push-to-talk to hands-free', async () => {
    const r = rig()
    await r.session.holdStart()
    r.short()
    r.session.holdEnd()
    await r.session.tap()
    expect(r.calls).toContain('auto:true')
    expect(r.session.getState().handsFree).toBe(true)
  })
})

describe('voice that is not set up yet', () => {
  const notInstalled = { installed: false, ready: false, reason: 'Voice needs a one-time setup.', canInstall: true }

  it('asks first and installs nothing on its own', async () => {
    const r = rig()
    vi.mocked(r.api.speech).mockResolvedValue(notInstalled)
    const install = vi.fn()
    Object.assign(r.api, { installSpeech: install, onInstallProgress: () => () => undefined })
    await r.session.startVoice()
    expect(r.session.getState()).toMatchObject({ install: { step: 'ask' }, voice: false, error: null })
    expect(install).not.toHaveBeenCalled()
    expect(r.listener.start).not.toHaveBeenCalled()
    r.session.dismissInstall()
    expect(r.session.getState().install).toBeNull()
  })

  it('on Install: shows progress, then turns voice on', async () => {
    const r = rig()
    vi.mocked(r.api.speech).mockResolvedValueOnce(notInstalled)
    let progress: (line: string) => void = () => undefined
    let finish: () => void = () => undefined
    Object.assign(r.api, {
      onInstallProgress: (cb: (line: string) => void) => ((progress = cb), () => undefined),
      installSpeech: vi.fn(() => new Promise((res) => (finish = () => res({ installed: true, ready: true, reason: null }))))
    })
    await r.session.startVoice()
    const running = r.session.installVoice()
    progress('[orcha] downloading Kokoro …')
    expect(r.session.getState().install).toEqual({ step: 'running', line: '[orcha] downloading Kokoro …' })
    finish()
    await running
    expect(r.session.getState()).toMatchObject({ install: null, voice: true })
    expect(r.listener.start).toHaveBeenCalled()
  })

  it('a failed install says why and can be tried again', async () => {
    const r = rig()
    vi.mocked(r.api.speech).mockResolvedValueOnce(notInstalled)
    Object.assign(r.api, { onInstallProgress: () => () => undefined, installSpeech: vi.fn(async () => Promise.reject(new Error('orcha voice install exited 1'))) })
    await r.session.startVoice()
    await r.session.installVoice()
    expect(r.session.getState()).toMatchObject({ install: { step: 'failed', error: 'orcha voice install exited 1' }, voice: false })
  })
})
