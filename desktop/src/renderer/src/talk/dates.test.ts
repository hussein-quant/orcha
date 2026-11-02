import { describe, expect, it } from 'vitest'
import { dayLabel, daysAgo, groupBy, groupLabel, sameDay, shortWhen } from './dates'

const now = new Date(2026, 10, 2, 15, 0) // Mon 2 Nov 2026, 15:00 local
const at = (y: number, m: number, d: number, h = 10): string => new Date(y, m, d, h).toISOString()

describe('talk dates', () => {
  it('counts calendar days, not 24-hour spans', () => {
    expect(daysAgo(at(2026, 10, 2, 0), now)).toBe(0)
    expect(daysAgo(at(2026, 10, 1, 23), now)).toBe(1)
    expect(sameDay(at(2026, 10, 2, 1), at(2026, 10, 2, 23))).toBe(true)
  })

  it('labels transcript days', () => {
    expect(dayLabel(at(2026, 10, 2), now)).toBe('Today')
    expect(dayLabel(at(2026, 10, 1), now)).toBe('Yesterday')
    expect(dayLabel(at(2026, 9, 29), now)).toBe(new Date(2026, 9, 29).toLocaleDateString(undefined, { weekday: 'long' }))
    expect(dayLabel(at(2025, 0, 5), now)).toContain('2025')
    expect(dayLabel('nonsense', now)).toBe('')
  })

  it('groups the conversation list', () => {
    expect(groupLabel(at(2026, 10, 2), now)).toBe('Today')
    expect(groupLabel(at(2026, 10, 1), now)).toBe('Yesterday')
    expect(groupLabel(at(2026, 9, 30), now)).toBe('Previous 7 days')
    expect(groupLabel(at(2026, 9, 10), now)).toBe('Previous 30 days')
    expect(groupLabel(at(2026, 7, 1), now)).toBe(new Date(2026, 7, 1).toLocaleDateString(undefined, { month: 'long' }))
    expect(groupLabel(at(2025, 7, 1), now)).toContain('2025')
  })

  it('short row times', () => {
    expect(shortWhen(at(2026, 10, 1), now)).toBe('Yesterday')
    expect(shortWhen(at(2026, 10, 2, 9), now)).toMatch(/\d/)
  })

  it('splits items into consecutive labelled runs', () => {
    expect(groupBy([1, 2, 5, 6, 1], (n) => (n < 3 ? 'low' : 'high'))).toEqual([
      { label: 'low', items: [1, 2] },
      { label: 'high', items: [5, 6] },
      { label: 'low', items: [1] }
    ])
  })
})
