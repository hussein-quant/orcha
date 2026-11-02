/** Talk to Orcha (GH-409): dates for going back through chats — day dividers in a transcript,
 *  date groups in the conversation list, message times. Local time; pure (dates.test.ts). */

const DAY = 86_400_000

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function parse(iso: string): Date | null {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? new Date(t) : null
}

/** whole calendar days between `iso` and `now` (0 = today, 1 = yesterday) */
export function daysAgo(iso: string, now = new Date()): number | null {
  const d = parse(iso)
  return d ? Math.round((startOfDay(now) - startOfDay(d)) / DAY) : null
}

export function sameDay(a: string, b: string): boolean {
  const x = parse(a)
  const y = parse(b)
  return !!x && !!y && startOfDay(x) === startOfDay(y)
}

/** A transcript's day divider: Today · Yesterday · Monday · Monday 27 October · 27 October 2025 */
export function dayLabel(iso: string, now = new Date()): string {
  const d = parse(iso)
  const n = daysAgo(iso, now)
  if (!d || n === null) return ''
  if (n === 0) return 'Today'
  if (n === 1) return 'Yesterday'
  if (n > 1 && n < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
}

/** The conversation list's groups: Today · Yesterday · Previous 7 days · Previous 30 days · October · October 2025 */
export function groupLabel(iso: string, now = new Date()): string {
  const d = parse(iso)
  const n = daysAgo(iso, now)
  if (!d || n === null) return 'Earlier'
  if (n <= 0) return 'Today'
  if (n === 1) return 'Yesterday'
  if (n < 7) return 'Previous 7 days'
  if (n < 30) return 'Previous 30 days'
  return d.getFullYear() === now.getFullYear()
    ? d.toLocaleDateString(undefined, { month: 'long' })
    : d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

/** 14:05 */
export function timeLabel(iso: string): string {
  const d = parse(iso)
  return d ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : ''
}

/** A row's short time: 14:05 today · Yesterday · Mon · 27 Oct · 27 Oct 2025 */
export function shortWhen(iso: string, now = new Date()): string {
  const d = parse(iso)
  const n = daysAgo(iso, now)
  if (!d || n === null) return ''
  if (n <= 0) return timeLabel(iso)
  if (n === 1) return 'Yesterday'
  if (n < 7) return d.toLocaleDateString(undefined, { weekday: 'short' })
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Full date and time for a tooltip. */
export function fullWhen(iso: string): string {
  const d = parse(iso)
  return d ? d.toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
}

/** Items in order, split into labelled runs (`label` of consecutive items that share it). */
export function groupBy<T>(items: T[], label: (t: T) => string): { label: string; items: T[] }[] {
  const out: { label: string; items: T[] }[] = []
  for (const it of items) {
    const l = label(it)
    const last = out[out.length - 1]
    if (last && last.label === l) last.items.push(it)
    else out.push({ label: l, items: [it] })
  }
  return out
}
