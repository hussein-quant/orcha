import { describe, expect, it } from 'vitest'
import { PAUSE_MS, Vad, splitSentences } from './voice'

describe('Talk listening', () => {
  it('waits however long for speech, ignores a click, ends after a natural pause', () => {
    const v = new Vad()
    let t = 0
    for (; t < 120_000; t += 20) expect(v.push(false, t)).toBeNull() // two minutes of silence: still waiting
    expect(v.push(true, t)).toBeNull() // a click
    expect(v.push(false, (t += 20))).toBeNull()
    let started = false
    for (let i = 0; i < 20; i++) if (v.push(true, (t += 20)) === 'start') started = true
    expect(started).toBe(true)
    // a short thinking pause mid-sentence does not end the turn
    for (let i = 0; i < (PAUSE_MS - 400) / 20; i++) expect(v.push(false, (t += 20))).toBeNull()
    expect(v.push(true, (t += 20))).toBeNull()
    let ended = false
    for (let i = 0; i < (PAUSE_MS + 200) / 20; i++) if (v.push(false, (t += 20)) === 'end') ended = true
    expect(ended).toBe(true)
  })

  it('speaks a reply sentence by sentence', () => {
    expect(splitSentences('Done. Created “Fix totals” in fleet-mate. Want me to assign it to Ledger?')).toEqual([
      'Done. Created “Fix totals” in fleet-mate.',
      'Want me to assign it to Ledger?'
    ])
  })
})
