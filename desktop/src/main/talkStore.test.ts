import { mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TalkConversation, TalkTurn } from '../shared/talk'
import { TalkStore, ftsQuery } from './talkStore'

const turn = (id: string, who: TalkTurn['who'], text: string, at = '2026-11-02T10:00:00.000Z'): TalkTurn => ({ id, who, text, at })
const conv = (id: string, turns: TalkTurn[], updatedAt = '2026-11-02T10:00:00.000Z'): TalkConversation => ({
  id,
  title: `Chat ${id}`,
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt,
  scope: null,
  turns
})

let store: TalkStore | null = null
afterEach(() => {
  store?.close()
  store = null
})

describe('TalkStore (SQLite)', () => {
  it('keeps every turn in order, updates changed turns, and lists newest first with a preview', async () => {
    store = new TalkStore(':memory:')
    await store.put(conv('a', [turn('1', 'you', 'hello')], '2026-11-01T10:00:00.000Z'))
    await store.put(conv('b', [turn('2', 'you', 'other')], '2026-11-02T10:00:00.000Z'))
    const a = (await store.get('a'))!
    await store.put({ ...a, turns: [...a.turns, turn('3', 'orcha', 'hi there')], updatedAt: '2026-11-03T10:00:00.000Z' })
    // a turn changes (a proposal is confirmed): updated in place, order kept
    await store.put({ ...a, turns: [turn('1', 'you', 'hello'), { ...turn('3', 'orcha', 'hi there'), error: true }], updatedAt: '2026-11-03T10:00:00.000Z' })
    const got = (await store.get('a'))!
    expect(got.turns.map((t) => t.id)).toEqual(['1', '3'])
    expect(got.turns[1].error).toBe(true)
    expect((await store.list()).map((s) => [s.id, s.preview, s.scope])).toEqual([
      ['a', 'hi there', null],
      ['b', 'other', null]
    ])
  })

  it('keeps memory and what a chat follows', async () => {
    store = new TalkStore(':memory:')
    await store.put({ ...conv('a', [turn('1', 'you', 'x')]), memory: { text: '- likes short replies', upto: '1' }, watching: [{ project: 'p', projectName: 'P', cid: 'c', taskId: 't', title: 'T', last: null }] as never })
    const got = (await store.get('a'))!
    expect(got.memory).toEqual({ text: '- likes short replies', upto: '1' })
    expect(await store.watchingIds()).toEqual(['a'])
  })

  it('searches every message by word prefixes, newest first, and forgets deleted chats', async () => {
    store = new TalkStore(':memory:')
    await store.put(conv('a', [turn('1', 'you', 'Open the App Privacy task', '2026-11-01T10:00:00.000Z')]))
    await store.put(conv('b', [turn('2', 'orcha', 'The privacy form is done', '2026-11-02T10:00:00.000Z'), turn('3', 'you', 'thanks')]))
    const hits = await store.search('priv')
    expect(hits.map((h) => [h.conversationId, h.turnId, h.who])).toEqual([
      ['b', '2', 'orcha'],
      ['a', '1', 'you']
    ])
    expect(hits[0].snippet).toContain('\u0001privacy\u0002')
    expect(await store.search('app priv')).toHaveLength(1)
    expect(await store.search('  ')).toEqual([])
    await store.remove('a')
    expect((await store.search('priv')).map((h) => h.conversationId)).toEqual(['b'])
  })

  it('drops chats that never got a message', async () => {
    store = new TalkStore(':memory:')
    await store.put(conv('empty', []))
    await store.put(conv('full', [turn('1', 'you', 'x')]))
    await store.dropEmpty()
    expect((await store.list()).map((s) => s.id)).toEqual(['full'])
  })

  it('keeps a snapshot', () => {
    store = new TalkStore(':memory:')
    expect(store.snapshot('projects')).toBeNull()
    store.saveSnapshot('projects', [{ name: 'A' }])
    expect(store.snapshot<{ name: string }[]>('projects')?.data).toEqual([{ name: 'A' }])
  })

  it('imports conversations.json once', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'talk-'))
    writeFileSync(path.join(dir, 'conversations.json'), JSON.stringify({ version: 1, conversations: [conv('old', [turn('1', 'you', 'from before')])] }))
    store = new TalkStore(dir)
    expect((await store.get('old'))?.turns[0].text).toBe('from before')
    expect(existsSync(path.join(dir, 'conversations.json'))).toBe(false)
    expect(existsSync(path.join(dir, 'conversations.json.imported'))).toBe(true)
  })

  it('turns words into a safe prefix query', () => {
    expect(ftsQuery('App "privacy" OR*')).toBe('"app"* "privacy"* "or"*')
    expect(ftsQuery('—')).toBeNull()
  })
})
