import { describe, expect, it } from 'vitest'
import type { TalkProjectOption } from '../../../shared/talk'
import { dropQuery, matchTags, mentionAt } from './mentions'

const proj = (key: string, name: string, aliases: string[]): TalkProjectOption => ({
  key,
  name,
  stack: key.split(':')[0],
  cid: key.split(':')[1],
  needsYou: 0,
  openTasks: 0,
  agents: aliases.length,
  working: 0,
  agentList: aliases.map((alias) => ({ alias, role: alias === 'atlas' ? 'iOS release engineer' : `${alias} role`, status: 'idle' }))
})
const nyumba = proj('orcha-nyumba-connect:c1', 'nyumba-connect', ['atlas', 'qa'])
const fleet = proj('orcha-fleet:c2', 'fleet-mate', ['qa-lead', 'director'])
const names = (o: { alias?: string; projectName: string }[]): string[] => o.map((x) => x.alias ?? x.projectName)

describe('@-tagging', () => {
  it('finds the @query just before the caret, not an email or a finished word', () => {
    expect(mentionAt('ask @fil', 8)).toEqual({ start: 4, query: 'fil' })
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionAt('mail me@x', 9)).toBeNull()
    expect(mentionAt('ask @qa now', 11)).toBeNull()
  })

  it('offers projects and agents, filtered by name and then by role', () => {
    expect(names(matchTags([nyumba, fleet], null, 'ny', []))).toEqual(['nyumba-connect'])
    expect(names(matchTags([nyumba, fleet], null, 'qa', []))).toEqual(['qa', 'qa-lead'])
    expect(names(matchTags([nyumba, fleet], null, 'ios', []))).toEqual(['atlas'])
  })

  it('a project pill narrows the next @ to its agents; pills are not offered again', () => {
    const pills = [{ project: 'orcha-nyumba-connect:c1' }]
    expect(names(matchTags([nyumba, fleet], null, '', pills))).toEqual(['atlas', 'qa'])
    expect(names(matchTags([nyumba, fleet], null, '', [...pills, { project: 'orcha-nyumba-connect:c1', alias: 'atlas' }]))).toEqual(['qa'])
  })

  it('a one-project chat offers only its own agents', () => {
    expect(names(matchTags([nyumba, fleet], 'orcha-fleet:c2', '', []))).toEqual(['qa-lead', 'director'])
  })

  it('takes the @query out of the text when it becomes a pill', () => {
    expect(dropQuery('ask @atl about it', 8, 4)).toEqual({ text: 'ask about it', caret: 4 })
    expect(dropQuery('@atl', 4, 0)).toEqual({ text: '', caret: 0 })
  })
})
