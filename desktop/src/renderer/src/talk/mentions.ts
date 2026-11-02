/** Talk to Orcha (GH-409): @-tagging in the composer. Typing "@" lists the projects this chat
 *  covers and their agents, filtered as you type (name, then role). A pick becomes a pill in the
 *  box: a project pill narrows the next "@" to that project's agents; an agent pill names the
 *  agent with its project, so the same alias in two projects is never ambiguous.
 *  Pure (mentions.test.ts). */
import type { TalkMention, TalkProjectOption } from '../../../shared/talk'

export interface TagOption extends TalkMention {
  kind: 'project' | 'agent'
  projectName: string
  icon: TalkProjectOption['icon']
  /** an agent's role (agents only) */
  role?: string
}

/** The "@query" being typed just before the caret, or null. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([\w.-]*)$/.exec(text.slice(0, caret))
  return m ? { start: caret - m[2].length - 1, query: m[2] } : null
}

/** What "@query" offers: projects (until one is picked) and agents (of the picked project, else
 *  of every covered project), minus what is already a pill. Name matches first, then roles. */
export function matchTags(projects: TalkProjectOption[], scope: string | null, query: string, pills: TalkMention[], max = 8): TagOption[] {
  const covered = projects.filter((p) => !scope || p.key === scope)
  const picked = pills.find((t) => !t.alias)?.project
  const projectTags: TagOption[] = picked || covered.length < 2 ? [] : covered.map((p) => ({ kind: 'project', project: p.key, projectName: p.name, icon: p.icon }))
  const agentTags: TagOption[] = covered
    .filter((p) => !picked || p.key === picked)
    .flatMap((p) => (p.agentList ?? []).map((a): TagOption => ({ kind: 'agent', project: p.key, projectName: p.name, icon: p.icon, alias: a.alias, role: a.role })))
  const options = [...projectTags, ...agentTags].filter((o) => !pills.some((t) => t.project === o.project && (t.alias ?? '') === (o.alias ?? '')))
  const q = query.toLowerCase()
  const name = (o: TagOption): string => (o.alias ?? o.projectName).toLowerCase()
  const rank = (o: TagOption): number =>
    name(o).startsWith(q) ? 0 : name(o).includes(q) ? 1 : (o.role ?? '').toLowerCase().includes(q) ? 2 : -1
  return options
    .map((o) => ({ o, r: rank(o) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r)
    .slice(0, max)
    .map((x) => x.o)
}

/** Take the "@query" (from `start` to the caret) out of the text → the new text and caret. */
export function dropQuery(text: string, caret: number, start: number): { text: string; caret: number } {
  const before = text.slice(0, start)
  const after = text.slice(caret)
  const joined = before.endsWith(' ') && after.startsWith(' ') ? before + after.slice(1) : before + after
  return { text: joined, caret: start }
}

export const pillKey = (t: TalkMention): string => `${t.project}/${t.alias ?? ''}`
