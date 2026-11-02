/** Talk to Orcha settings (GH-409), saved for this Mac in the manager window's storage. */
import { useEffect, useState } from 'react'
import { TALK_HOTKEYS, type TalkHotkey } from '../../../shared/talk'

export interface TalkPrefs {
  /** the voice replies are read in ("" = the best installed: Kokoro, then Mac voices) */
  voice: string
  /** words per minute, 0 = the voice's default */
  rate: number
  /** seconds to undo a confirmed action before it is sent (0 = at once) */
  undoSeconds: number
  /** said to go ahead with merge / deploy / publish / submit-for-review actions */
  confirmPhrase: string
  /** system-wide: open Talk and start talking, or interrupt */
  hotkey: TalkHotkey
  /** a new chat covers every project, or only the one open on screen */
  newChatScope: 'all' | 'current'
}

export const TALK_PREFS_KEY = 'orcha:talk'
const EVENT = 'orcha:talk-prefs'

export const DEFAULT_TALK_PREFS: TalkPrefs = {
  voice: '',
  rate: 0,
  undoSeconds: 5,
  confirmPhrase: 'confirm',
  hotkey: 'Control+Alt+Space',
  newChatScope: 'all'
}

export const HOTKEY_LABEL: Record<TalkHotkey, string> = {
  'Control+Alt+Space': '⌃⌥Space',
  'Control+Shift+Space': '⌃⇧Space',
  'Alt+Shift+Space': '⌥⇧Space'
}

const clamp = (v: unknown, lo: number, hi: number, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d

export function normalizeTalkPrefs(raw: unknown): TalkPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof TalkPrefs, unknown>>
  const d = DEFAULT_TALK_PREFS
  const phrase = typeof r.confirmPhrase === 'string' ? r.confirmPhrase.trim().toLowerCase().slice(0, 40) : ''
  return {
    voice: typeof r.voice === 'string' ? r.voice.slice(0, 64) : d.voice,
    rate: typeof r.rate === 'number' && r.rate > 0 ? clamp(r.rate, 120, 320, 0) : 0,
    undoSeconds: clamp(r.undoSeconds, 0, 30, d.undoSeconds),
    confirmPhrase: phrase.length >= 3 ? phrase : d.confirmPhrase,
    hotkey: (TALK_HOTKEYS as readonly unknown[]).includes(r.hotkey) ? (r.hotkey as TalkHotkey) : d.hotkey,
    newChatScope: r.newChatScope === 'current' ? 'current' : 'all'
  }
}

export function readTalkPrefs(): TalkPrefs {
  try {
    const raw = localStorage.getItem(TALK_PREFS_KEY)
    return normalizeTalkPrefs(raw ? JSON.parse(raw) : null)
  } catch {
    return { ...DEFAULT_TALK_PREFS }
  }
}

export function writeTalkPrefs(patch: Partial<TalkPrefs>): TalkPrefs {
  const next = normalizeTalkPrefs({ ...readTalkPrefs(), ...patch })
  try {
    localStorage.setItem(TALK_PREFS_KEY, JSON.stringify(next))
  } catch {
    /* storage blocked: lasts for this session */
  }
  window.dispatchEvent(new Event(EVENT))
  return next
}

export function useTalkPrefs(): [TalkPrefs, (p: Partial<TalkPrefs>) => void] {
  const [p, setP] = useState(readTalkPrefs)
  useEffect(() => {
    const on = (): void => setP(readTalkPrefs())
    window.addEventListener(EVENT, on)
    return () => window.removeEventListener(EVENT, on)
  }, [])
  return [p, (patch) => setP(writeTalkPrefs(patch))]
}
