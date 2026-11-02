import { describe, expect, it } from 'vitest'
import type { TalkConversation } from '../shared/talk'
import { HISTORY_TURNS, MEMORY_BATCH, NEW_TITLE, TalkEngine, agentCards, buildPrompt, compact, resolveLinks, isConfirmation, parseAnswer, type PortalResponse, type TalkProject } from './talkEngine'

const ctx = (over: Partial<TalkProject['ctx']> = {}): TalkProject['ctx'] => ({
  cid: 'c1',
  actor: 'h1',
  project: 'fleet-mate',
  owner: 'Hussein',
  agents: [{ alias: 'Ledger', role: 'developer', status: 'active', working_on: 'Paste trips' }],
  open_tasks: [{ id: 'aaaa1111-0000', ref: 'aaaa1111', title: 'Paste trips', status: 'in_progress', assignee: 'Ledger', href: '/tasks?task=aaaa1111-0000' }],
  recently_done: [],
  needs_you: [{ kind: 'verify', id: 'bbbb2222-0000', ref: 'bbbb2222', title: 'Dashboard totals', from: 'Ledger', task_id: 'bbbb2222-0000', href: '/tasks?task=bbbb2222-0000' }],
  ...over
})

const fleet: TalkProject = { stack: 'orcha-fleet', name: 'fleet-mate', apiPort: 8002, ctx: ctx() }
const slate: TalkProject = { stack: 'orcha-slate', name: 'Slate', apiPort: 8001, ctx: ctx({ cid: 'c2', project: 'Slate', needs_you: [], open_tasks: [] }) }

function rig(answers: string[], portal: (port: number, method: string, url: string, body?: unknown) => PortalResponse) {
  const db = new Map<string, TalkConversation>()
  const calls: { port: number; method: string; url: string; body?: unknown }[] = []
  const prompts: string[] = []
  let n = 0
  const engine = new TalkEngine({
    store: { get: async (id) => structuredClone(db.get(id) ?? null), put: async (c) => (db.set(c.id, structuredClone(c)), c) },
    projects: async () => [fleet, slate],
    ask: async (_s, prompt) => {
      prompts.push(prompt)
      const a = answers.shift()
      if (a === undefined) throw new Error('no answer')
      return a
    },
    portal: async (port, method, url, body) => {
      calls.push({ port, method, url, body })
      return portal(port, method, url, body)
    },
    newId: () => `id${++n}`,
    now: () => new Date('2026-11-02T10:00:00Z')
  })
  return { engine, db, calls, prompts }
}

const proposal = (over: Record<string, unknown> = {}) => ({
  action: 'create_task', item_kind: 'task', item_id: null, title: 'Fix totals', text: 'The sheet says 398.',
  read_back: 'Creating “Fix totals” for Ledger, done when totals match.', sensitive: [], decision: false,
  request: { method: 'POST', url: '/api/containers/c1/tasks', body: { title: 'Fix totals' } }, ...over
})

describe('Talk engine', () => {
  it('asks Claude with every project, links what it mentions and titles the chat', async () => {
    const r = rig([JSON.stringify({ reply: 'Ledger finished the dashboard totals.', links: [{ project: 'fleet-mate', ref: 'bbbb2222' }, { project: 'Slate', ref: '' }], action: null, title: 'Morning catch-up' })], () => ({ status: 200, body: {} }))
    const c = await r.engine.newConversation()
    r.db.set(c.id, c)
    const out = await r.engine.send({ id: c.id, text: 'what needs me?', via: 'voice', confirmPhrase: 'confirm' })
    expect(r.prompts[0]).toContain('## Project: fleet-mate')
    expect(r.prompts[0]).toContain('[verify] ref=bbbb2222 "Dashboard totals" from Ledger')
    expect(r.prompts[0]).toContain('## Project: Slate')
    expect(r.prompts[0]).toContain('Owner (spoken): what needs me?')
    expect(out.next).toBe('reply')
    expect(out.conversation.title).toBe('Morning catch-up')
    expect(out.turn.links).toEqual([
      { project: 'orcha-fleet', projectName: 'fleet-mate', cid: 'c1', label: 'Dashboard totals', path: '/tasks?task=bbbb2222-0000', kind: 'verify' },
      { project: 'orcha-slate', projectName: 'Slate', cid: 'c2', label: 'Slate', path: '/', kind: 'project' }
    ])
  })

  it('the draft is kept on the proposal; an edit is checked by the project again and replaces it', async () => {
    const r = rig([JSON.stringify({ reply: '', action: { project: 'fleet-mate', name: 'create_task', args: { title: 'Fix totals', definition_of_done: 'totals match' } } })], () => ({
      status: 200,
      body: { proposal: proposal() }
    }))
    const c = r.engine.newConversation()
    r.db.set(c.id, c)
    const first = await r.engine.send({ id: c.id, text: 'make a task', via: 'text', confirmPhrase: 'confirm' })
    expect(first.turn.proposal?.args).toEqual({ title: 'Fix totals', definition_of_done: 'totals match' })
    const edited = await r.engine.quick(c.id, 'orcha-fleet', 'c1', 'create_task', { title: 'Fix the totals', definition_of_done: 'totals match to the cent' })
    expect(r.calls.at(-1)).toMatchObject({ url: '/api/containers/c1/voice-first/propose', body: { args: { title: 'Fix the totals', definition_of_done: 'totals match to the cent' } } })
    expect(edited.turn.proposal?.status).toBe('pending')
    const old = edited.conversation.turns.find((t) => t.id === first.turn.id)?.proposal
    expect(old).toMatchObject({ status: 'declined', outcome: 'replaced' })
  })

  it('a suggested action becomes a project-validated proposal; yes runs it, records it and follows the new task', async () => {
    const r = rig([JSON.stringify({ reply: 'Sure.', action: { project: 'fleet-mate', name: 'create_task', args: { title: 'Fix totals' } } })], (_p, method, url) => {
      if (url.endsWith('/propose')) return { status: 200, body: { proposal: proposal() } }
      if (url.endsWith('/voice-first/actions')) return { status: 200, body: { voice_action_id: 'va1' } }
      if (url === '/api/containers/c1/tasks') return { status: 201, body: { task_id: 'new-task' } }
      return { status: 200, body: {} }
    })
    const c = r.engine.newConversation()
    r.db.set(c.id, c)
    const p = await r.engine.send({ id: c.id, text: 'make a task to fix the totals', via: 'text', confirmPhrase: 'confirm' })
    expect(p.next).toBe('confirm')
    expect(p.turn.text).toBe('Sure. Creating “Fix totals” for Ledger, done when totals match. Change anything, or shall I go ahead?')
    expect(r.calls[0]).toMatchObject({ port: 8002, url: '/api/containers/c1/voice-first/propose', body: { actor_agent_id: 'h1', action: 'create_task' } })

    const yes = await r.engine.send({ id: c.id, text: 'Yes please.', via: 'voice', confirmPhrase: 'confirm' })
    expect(yes.next).toBe('execute')
    const done = await r.engine.execute(c.id, 'make a task / yes')
    expect(done.turn.text).toBe('Done. Created “Fix totals” in fleet-mate.')
    expect(done.turn.links?.[0]).toMatchObject({ path: '/tasks?task=new-task', kind: 'task' })
    const urls = r.calls.map((x) => `${x.method} ${x.url}`)
    expect(urls).toEqual([
      'POST /api/containers/c1/voice-first/propose',
      'POST /api/containers/c1/voice-first/actions',
      'POST /api/containers/c1/tasks',
      'PATCH /api/containers/c1/voice-first/actions/va1'
    ])
    expect(done.conversation.watching).toEqual([{ project: 'orcha-fleet', projectName: 'fleet-mate', cid: 'c1', taskId: 'new-task', title: 'Fix totals', last: '' }])
  })

  it('risky actions need the confirm phrase; no cancels; decisions carry via voice', async () => {
    const risky = proposal({ action: 'approve_plan', item_kind: 'plan', item_id: 'aaaa1111-0000', decision: true, sensitive: ['deploy'], read_back: "Approving Ledger's plan.",
      request: { method: 'POST', url: '/api/decisions', body: { subject_type: 'plan_approval' } } })
    const r = rig([JSON.stringify({ reply: '', action: { project: 'fleet-mate', name: 'approve_plan', args: { task: 'aaaa1111' } } })], (_p, _m, url) =>
      url.endsWith('/propose') ? { status: 200, body: { proposal: risky } } : url.endsWith('/actions') ? { status: 200, body: { voice_action_id: 'va2' } } : { status: 201, body: {} })
    const c = r.engine.newConversation()
    r.db.set(c.id, c)
    await r.engine.send({ id: c.id, text: 'approve it', via: 'voice', confirmPhrase: 'ship it' })
    const yes = await r.engine.send({ id: c.id, text: 'yes', via: 'voice', confirmPhrase: 'ship it' })
    expect(yes.next).toBe('confirm')
    expect(yes.turn.text).toContain('Say "ship it"')
    const go = await r.engine.send({ id: c.id, text: 'ship it', via: 'voice', confirmPhrase: 'ship it' })
    expect(go.next).toBe('execute')
    await r.engine.execute(c.id, '...')
    expect(r.calls.find((x) => x.url === '/api/decisions')?.body).toEqual({ subject_type: 'plan_approval', via: 'voice', voice_action_id: 'va2' })
  })

  it('declining sends nothing', async () => {
    const r = rig([JSON.stringify({ action: { project: 'fleet-mate', name: 'create_task', args: {} } })], () => ({ status: 200, body: { proposal: proposal() } }))
    const c = r.engine.newConversation()
    r.db.set(c.id, c)
    await r.engine.send({ id: c.id, text: 'new task', via: 'text', confirmPhrase: 'confirm' })
    const no = await r.engine.send({ id: c.id, text: 'no', via: 'text', confirmPhrase: 'confirm' })
    expect(no.turn.text).toBe("Okay, I won't.")
    expect(no.conversation.turns.at(-2)?.proposal).toBeUndefined()
    expect(no.conversation.turns.find((t) => t.proposal)?.proposal?.status).toBe('declined')
    expect(r.calls).toHaveLength(1)
  })

  it('a missing detail comes back as the project’s question, not a proposal', async () => {
    const r = rig([JSON.stringify({ reply: '', action: { project: 'fleet-mate', name: 'create_task', args: { title: 'X' } } })], () => ({ status: 200, body: { say: "How will we know it's done?" } }))
    const c = r.engine.newConversation()
    r.db.set(c.id, c)
    const out = await r.engine.send({ id: c.id, text: 'task X', via: 'text', confirmPhrase: 'confirm' })
    expect(out).toMatchObject({ next: 'reply', turn: { text: "How will we know it's done?" } })
  })

  it('a scoped chat only sees its project', async () => {
    const r = rig([JSON.stringify({ reply: 'ok' })], () => ({ status: 200, body: {} }))
    const c = r.engine.newConversation('orcha-slate:c2')
    r.db.set(c.id, c)
    await r.engine.send({ id: c.id, text: 'hi', via: 'text', confirmPhrase: 'confirm' })
    expect(r.prompts[0]).toContain('## Project: Slate')
    // the other project's contents stay out; only its name is given, so it can be recognised
    expect(r.prompts[0]).not.toContain('## Project: fleet-mate')
    expect(r.prompts[0]).toContain('cannot see: fleet-mate')
  })

  it('the brain being down is said, not hidden', async () => {
    const r = rig([], () => ({ status: 200, body: {} }))
    const c = r.engine.newConversation()
    r.db.set(c.id, c)
    const out = await r.engine.send({ id: c.id, text: 'hi', via: 'text', confirmPhrase: 'confirm' })
    expect(out.turn).toMatchObject({ error: true })
    expect(out.turn.text).toContain("can't reach Claude")
  })

  it('followed work that comes back needs you gets an update card; finishing ends the follow', async () => {
    const r = rig([], () => ({ status: 200, body: {} }))
    const c: TalkConversation = { ...r.engine.newConversation(), watching: [{ project: 'orcha-fleet', projectName: 'fleet-mate', cid: 'c1', taskId: 't9', title: 'Fix totals', last: '' }] }
    r.db.set(c.id, c)
    const read = (status: string, needs: boolean) => async () => ({
      needs: needs ? [{ kind: 'verify' as const, id: 't9', ref: 't9', title: 'Fix totals', from: 'Ledger', task_id: 't9', href: '/tasks?task=t9' }] : [],
      watched: [{ id: 't9', title: 'Fix totals', status, assignee: 'Ledger', href: '/tasks?task=t9' }]
    })
    // first look: just where it stands
    let convs = [structuredClone(r.db.get(c.id)!)]
    expect(await r.engine.checkWatches(convs, read('in_progress', false))).toEqual([c.id])
    expect(r.db.get(c.id)!.turns).toHaveLength(0)
    convs = [structuredClone(r.db.get(c.id)!)]
    expect(await r.engine.checkWatches(convs, read('in_progress', false))).toEqual([])
    convs = [structuredClone(r.db.get(c.id)!)]
    await r.engine.checkWatches(convs, read('needs_verification', true))
    const turn = r.db.get(c.id)!.turns.at(-1)!
    expect(turn.update).toMatchObject({ kind: 'verify', taskId: 't9', from: 'Ledger', path: '/tasks?task=t9' })
    expect(turn.text).toContain('waiting on your check')
    convs = [structuredClone(r.db.get(c.id)!)]
    await r.engine.checkWatches(convs, read('completed', false))
    const saved = r.db.get(c.id)!
    expect(saved.turns.at(-1)?.update?.kind).toBe('done')
    expect(saved.watching).toEqual([])
  })
})

describe('Talk pieces', () => {
  it('parses fenced JSON, prose and missing fields', () => {
    expect(parseAnswer('```json\n{"reply":"hi","links":[{"project":"A","ref":""}]}\n```')).toMatchObject({ reply: 'hi', links: [{ project: 'A', ref: '' }], action: null })
    expect(parseAnswer('Just words.')).toMatchObject({ reply: 'Just words.', action: null })
    expect(parseAnswer('{"reply":"x","action":{"project":"A","name":"accept"}}').action).toEqual({ project: 'A', name: 'accept', args: {} })
    // prose and a "correction" around two answers: the last answer wins, no raw JSON shown
    const leaked = '{"reply":"first","links":[],"action":null}\n</br>\n\nCorrection: here is the clean version:\n\n{"reply":"Great, it {is} \\"linked\\".","links":[{"project":"fleet-mate","ref":"178d614f"}],"action":null}'
    expect(parseAnswer('{"reply":"Opening it.","links":[],"action":null,"open":{"project":"A","ref":"ab12"}}').open).toEqual({ project: 'A', ref: 'ab12', what: '', label: '' })
    expect(parseAnswer(leaked)).toMatchObject({ reply: 'Great, it {is} "linked".', links: [{ project: 'fleet-mate', ref: '178d614f' }], action: null })
  })

  it('the confirm phrase', () => {
    expect(isConfirmation('Confirm.', 'confirm')).toBe(true)
    expect(isConfirmation('um, confirm it', 'confirm')).toBe(true)
    expect(isConfirmation('no wait', 'confirm')).toBe(false)
    expect(isConfirmation('yes', 'confirm')).toBeNull()
  })

  it('asks for a title only on a new chat', () => {
    const c: TalkConversation = { id: 'x', title: NEW_TITLE, createdAt: '', updatedAt: '', scope: null, turns: [] }
    expect(buildPrompt(c, [fleet], new Date())).toContain('"title"')
    expect(buildPrompt({ ...c, title: 'Done' }, [fleet], new Date())).not.toContain('"title"')
  })

  it('the summary lists every project workflow by id, so one can be linked straight away', () => {
    const c: TalkConversation = { id: 'x', title: 'Done', createdAt: '', updatedAt: '', scope: null, turns: [] }
    const wf = { id: 'f565196c-0895-4eda-b6d3-1cb98ffb7ff5', title: 'iOS release', status: 'active', accepted: 9, total: 13 }
    expect(buildPrompt(c, [{ ...fleet, workflows: [wf] }], new Date())).toContain(`- id=${wf.id} "iOS release" active, 9 of 13 steps accepted`)
    expect(buildPrompt(c, [{ ...fleet, workflows: [] }], new Date())).toContain('Workflows: none.')
    expect(buildPrompt(c, [fleet], new Date())).not.toContain('Workflows')
  })

  it('agent cards: state, current task and what it waits on, from the summary; unknown agents dropped', () => {
    const cards = agentCards([fleet, slate], [
      { project: 'fleet-mate', alias: '@ledger' },
      { project: 'fleet-mate', alias: 'nobody' },
      { project: 'orcha-fleet:c1', alias: 'Ledger' }
    ])
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      alias: 'Ledger',
      projectName: 'fleet-mate',
      status: 'active',
      needsCount: 1,
      task: { path: '/tasks?task=aaaa1111-0000', label: 'Paste trips' },
      needs: { path: '/tasks?task=bbbb2222-0000', kind: 'verify' }
    })
  })

  it('a tagged agent gets its card and is named to the model with its project', async () => {
    const r = rig([JSON.stringify({ reply: 'Ledger is on Paste trips.', links: [], action: null, open: null, look: [], agents: [] })], () => ({ status: 200, body: {} }))
    const c = r.engine.newConversation()
    r.db.set(c.id, c)
    const out = await r.engine.send({ id: c.id, text: '@Ledger how is it going?', via: 'text', confirmPhrase: 'confirm', mentions: [{ project: 'orcha-fleet:c1', alias: 'Ledger' }] })
    expect(r.prompts[0]).toContain('[tagged: agent @Ledger (fleet)]')
    expect(out.turn.agents?.map((a) => a.alias)).toEqual(['Ledger'])
    expect(out.conversation.turns[0].mentions).toEqual([{ project: 'orcha-fleet:c1', alias: 'Ledger' }])
  })

  it('a message to an agent opens its chat and posts the words there as the owner, with no voice-action record', async () => {
    const AGENT = '11111111-2222-4333-8444-555555555555'
    const CONV = '99999999-2222-4333-8444-555555555555'
    const draft = {
      action: 'message_agent', item_kind: 'agent', item_id: AGENT, title: 'Ledger', text: 'Check the build.', read_back: 'Sending Ledger a chat message: “Check the build.”',
      sensitive: [], decision: false, request: { method: 'POST', url: `/api/agents/${AGENT}/conversations`, body: { actor_agent_id: 'h1' } }
    }
    const r = rig([JSON.stringify({ reply: '', action: { project: 'fleet-mate', name: 'message_agent', args: { agent: 'Ledger', text: 'Check the build.' } } })], (_p, _m, url) =>
      url.endsWith('/propose') ? { status: 200, body: { proposal: draft } } : url.endsWith('/conversations') ? { status: 201, body: { conversation: { id: CONV } } } : { status: 201, body: {} }
    )
    const c = r.engine.newConversation()
    r.db.set(c.id, c)
    await r.engine.send({ id: c.id, text: 'tell Ledger to check the build', via: 'text', confirmPhrase: 'confirm' })
    const done = await r.engine.execute(c.id, 'yes')
    expect(r.calls.slice(1).map((x) => `${x.method} ${x.url}`)).toEqual([`POST /api/agents/${AGENT}/conversations`, `POST /api/conversations/${CONV}/turns`])
    expect(r.calls.at(-1)?.body).toEqual({ role: 'human', author_agent_id: 'h1', content: 'Check the build.' })
    expect(done.turn.text).toBe('Sent. Ledger answers in its chat.')
    expect(done.turn.links?.[0].path).toBe('/agents?agent=Ledger&tab=conversation')
  })

  it('an agent link opens its chat, or its runs', () => {
    const [chat, runs] = resolveLinks([fleet], [
      { project: 'fleet-mate', ref: 'ledger', what: 'agent' },
      { project: 'fleet-mate', ref: 'Ledger', what: 'agent_runs' }
    ])
    expect(chat.path).toBe('/agents?agent=Ledger&tab=conversation')
    expect(runs.path).toBe('/agents?agent=Ledger&tab=runs')
  })

  it('a one-project chat knows the names of the projects it cannot see', () => {
    const c: TalkConversation = { id: 'x', title: 'Done', createdAt: '', updatedAt: '', scope: 'orcha-fleet:c', turns: [] }
    expect(buildPrompt(c, [fleet], new Date(), undefined, ['Nyumba Connect', 'Slate'])).toContain('cannot see: Nyumba Connect, Slate')
    expect(buildPrompt({ ...c, scope: null }, [fleet], new Date(), undefined, [])).not.toContain('cannot see')
  })
})

describe('memory', () => {
  it('folds turns that left the window into notes, MEMORY_BATCH at a time', async () => {
    const turns = Array.from({ length: HISTORY_TURNS + MEMORY_BATCH }, (_, i) => ({ id: `t${i}`, who: 'you' as const, text: `m${i}`, at: '2026-11-02T10:00:00.000Z' }))
    let saved: TalkConversation | null = { id: 'c', title: 'x', createdAt: '', updatedAt: '', scope: null, turns }
    const prompts: string[] = []
    const engine = new TalkEngine({
      store: { get: async () => saved, put: async (c) => (saved = c) },
      projects: async () => [],
      ask: async (_s, p, kind) => {
        prompts.push(`${kind}:${p}`)
        return JSON.stringify({ memory: '- wants m0 done' })
      },
      portal: async () => ({ status: 200, body: {} }),
      newId: () => 'id',
      now: () => new Date('2026-11-02T10:00:00Z')
    })
    expect(await engine.remember('c')).toBe(true)
    expect(saved!.memory).toEqual({ text: '- wants m0 done', upto: `t${MEMORY_BATCH - 1}` })
    expect(prompts[0]).toMatch(/^memory:/)
    expect(prompts[0]).toContain('m0')
    expect(prompts[0]).not.toContain(`m${MEMORY_BATCH}`)
    // nothing new left the window: no model call
    expect(await engine.remember('c')).toBe(false)
    expect(prompts).toHaveLength(1)
    // the notes go into the prompt
    expect(buildPrompt(saved!, [], new Date())).toContain('- wants m0 done')
  })
})

describe('looking into tabs', () => {
  it('reads what it asked for (ids resolved from refs), then answers from it', async () => {
    const project: TalkProject = {
      stack: 'orcha-fleet',
      name: 'fleet-mate',
      apiPort: 8002,
      ctx: ctx({ open_tasks: [{ id: 'aaaa1111-0000-0000-0000-000000000000', ref: 'aaaa1111', title: 'Trip counts', status: 'in_progress', assignee: 'Ledger', href: '/tasks?task=aaaa1111' }] })
    }
    let saved: TalkConversation | null = { id: 'c', title: 'x', createdAt: '', updatedAt: '', scope: null, turns: [] }
    const prompts: string[] = []
    const answers = [
      JSON.stringify({ reply: '', links: [], action: null, open: null, look: [{ project: 'fleet-mate', what: 'workflows', id: '' }, { project: 'fleet-mate', what: 'thread', id: 'aaaa1111' }, { project: 'fleet-mate', what: 'thread', id: '../x' }] }),
      JSON.stringify({ reply: 'One workflow runs today: Nightly build.', links: [], action: null, open: null, look: [] })
    ]
    const looks: string[] = []
    const engine = new TalkEngine({
      store: { get: async () => saved, put: async (c) => (saved = c) },
      projects: async () => [project],
      ask: async (_s, p) => {
        prompts.push(p)
        return answers.shift() as string
      },
      look: async (_p, what, id) => {
        looks.push(`${what}:${id}`)
        return what === 'workflows' ? { workflows: [{ name: 'Nightly build', status: 'running' }] } : { messages: [] }
      },
      portal: async () => ({ status: 200, body: {} }),
      newId: () => `id${prompts.length}`,
      now: () => new Date('2026-11-02T10:00:00Z')
    })
    const r = await engine.send({ id: 'c', text: 'What workflows do I have today?', via: 'text', confirmPhrase: 'confirm' })
    expect(looks).toEqual(['workflows:', 'thread:aaaa1111-0000-0000-0000-000000000000'])
    expect(prompts[1]).toContain('Nightly build')
    expect(r.turn.text).toBe('One workflow runs today: Nightly build.')
    expect(r.turn.looked?.map((l) => l.label)).toEqual(['Workflows', 'Thread: Trip counts'])
  })

  it('compacts what it read', () => {
    const big = { items: Array.from({ length: 50 }, (_, i) => ({ n: i, body: 'x'.repeat(1000), empty: null })) }
    const out = compact(big, 100_000)
    expect(out).toContain('…20 more')
    expect(out).not.toContain('empty')
    expect(out).not.toContain('x'.repeat(500))
    expect(compact('y'.repeat(50), 10)).toBe('yyyyyyyyyy… (cut)')
  })
})

describe('links beyond tasks', () => {
  it('links workflows, questions, agents and whole tabs; refuses what it cannot vouch for', () => {
    const p: TalkProject = { stack: 'orcha-nyumba', name: 'nyumba-connect', apiPort: 8005, ctx: ctx({ agents: [{ alias: 'atlas', role: 'dev', status: 'idle', working_on: null }] }) }
    const wf = '11111111-2222-4333-8444-555555555555'
    const links = resolveLinks([p], [
      { project: 'nyumba-connect', ref: wf, what: 'workflow', label: 'iOS release' },
      { project: 'nyumba-connect', ref: wf, what: 'request', label: '' },
      { project: 'nyumba-connect', ref: '@atlas', what: 'agent', label: '' },
      { project: 'nyumba-connect', ref: '', what: 'routines', label: '' },
      { project: 'nyumba-connect', ref: '../etc', what: 'workflow', label: 'x' },
      { project: 'nyumba-connect', ref: 'ghost', what: 'agent', label: '' }
    ])
    expect(links.map((l) => [l.kind, l.path, l.label])).toEqual([
      ['workflow', `/workflows/${wf}`, 'iOS release'],
      ['request', `/requests?req=${wf}`, 'Question'],
      ['agent', '/agents?agent=atlas&tab=conversation', 'atlas'],
      ['page', '/routines', 'Routines']
    ])
  })
})
