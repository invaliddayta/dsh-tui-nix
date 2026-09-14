import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createTuiTestHarness, disposeTuiTestHarness, type TuiHarnessOptions } from './harness.ts'
import { HeadlessTerminal } from './headless-terminal.ts'
import { persistSessionFork } from '../src/chat/session-fork.ts'

// The separate session-fork suite exercises real JSONL persistence. Here we
// control completion/failure so the actual editor and command routing can race.
vi.mock('../src/chat/session-fork.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/chat/session-fork.ts')>(),
  persistSessionFork: vi.fn(),
}))

let harness: Awaited<ReturnType<typeof createTuiTestHarness>>
let terminal: HeadlessTerminal
let handoff: ReturnType<typeof vi.fn>
const releases: Array<() => void> = []

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in fork tests') }))
  handoff = vi.fn(async () => { throw new Error('test host refused replacement') })
  vi.mocked(persistSessionFork).mockImplementation(async (ctx, source, boundary) =>
    ctx.sessions.fork(source, boundary, SessionId(`child-${ctx.sessions.list().length}`)))
})

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  if (harness) await disposeTuiTestHarness(harness)
  if (terminal) await terminal.dispose()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

async function start(options: TuiHarnessOptions = {}) {
  terminal = new HeadlessTerminal(110, 35)
  harness = await createTuiTestHarness(terminal, vi.fn(), {
    omitInitialLifecycle: true,
    handoffResume: handoff,
    beforeMount(session) {
      for (const turn of [1, 2]) {
        session.append('turn/start', { turn, trigger: { kind: 'message', source: { kind: 'user' } } })
        session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `Question ${turn}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      }
    },
    ...options,
  })
  // The upstream headless fake predates runMaintenance. Model its exclusion
  // contract explicitly here; production uses the pinned agent-loop primitive.
  let maintaining = false
  harness.agent.runMaintenance = vi.fn((async task => {
    if (maintaining || harness.agent.status !== 'idle') throw new Error('Agent is busy')
    maintaining = true
    try { return await task(new AbortController().signal) }
    finally { maintaining = false }
  }) as Agent['runMaintenance'])
  await terminal.waitForFrame(0)
}

function submit(text: string) {
  terminal.send(text)
  terminal.send('\r')
}

it('discovers /fork and forks the current conversation without model input or command log mutations', async () => {
  await start()
  expect(harness.ctx.commands.list(harness.agent).find(command => command.name === 'fork')).toBeDefined()
  const source = harness.session.snapshotEvents()
  submit('/fork')
  await vi.waitFor(() => expect(handoff).toHaveBeenCalledWith('child-1', '/workspace'))
  expect(persistSessionFork).toHaveBeenCalledWith(harness.ctx, harness.session, source.at(-1)!.seq)
  expect(harness.session.snapshotEvents()).toEqual(source)
  expect(harness.agent.sent).toHaveLength(0)
  expect(fetch).not.toHaveBeenCalled()
  await vi.waitFor(async () => expect(await terminal.snapshot()).toContain('Fork saved as child-1; use /resume'))
})

it('forks through an explicitly selected earlier turn', async () => {
  await start()
  submit('/fork --through-turn 1')
  await vi.waitFor(() => expect(handoff).toHaveBeenCalledOnce())
  const child = harness.ctx.sessions.get(SessionId('child-1'))!
  expect(child.header.parentSession).toBe(harness.session.id)
  expect(child.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(1)
  expect(child.snapshotEvents().some(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text === 'Question 2'))).toBe(false)
})

it.each(['/fork nonsense', '/fork --through-turn 0', '/fork --through-turn 20'])(
  'rejects invalid selection %s before persistence without logging the command', async command => {
    await start()
    const before = harness.session.snapshotEvents()
    submit(command)
    await vi.waitFor(async () => expect(await terminal.snapshot()).toContain('Fork failed:'))
    expect(persistSessionFork).not.toHaveBeenCalled()
    expect(handoff).not.toHaveBeenCalled()
    expect(harness.session.snapshotEvents()).toEqual(before)
  },
)

it('refuses an active turn', async () => {
  await start({ status: 'running' })
  submit('/fork')
  await vi.waitFor(async () => expect(await terminal.snapshot()).toContain('Finish or cancel the current turn'))
  expect(persistSessionFork).not.toHaveBeenCalled()
})

it('refuses an empty conversation', async () => {
  await start({ beforeMount() {} })
  submit('/fork')
  await vi.waitFor(async () => expect(await terminal.snapshot()).toContain('no completed turn'))
  expect(persistSessionFork).not.toHaveBeenCalled()
})

it('does not create a child without an in-place host', async () => {
  await start({ handoffResume: undefined })
  submit('/fork')
  await vi.waitFor(async () => expect(await terminal.snapshot()).toContain('host cannot switch sessions'))
  expect(persistSessionFork).not.toHaveBeenCalled()
})

it('reports write failures without leaving the terminal or losing subsequent input', async () => {
  await start()
  vi.mocked(persistSessionFork).mockRejectedValueOnce(new Error('disk full'))
  submit('/fork')
  await vi.waitFor(async () => expect(await terminal.snapshot()).toContain('disk full'))
  expect(handoff).not.toHaveBeenCalled()
  submit('still here')
  await vi.waitFor(() => expect(harness.agent.sent).toHaveLength(1))
})

it('waits for persistence and blocks duplicate forks and prompt submission during the write', async () => {
  await start()
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  releases.push(release)
  const persist = vi.mocked(persistSessionFork).getMockImplementation()!
  vi.mocked(persistSessionFork).mockImplementationOnce(async (...args) => {
    await barrier
    return persist(...args)
  })
  submit('/fork')
  await vi.waitFor(() => expect(persistSessionFork).toHaveBeenCalledOnce())
  submit('/fork')
  expect(handoff).not.toHaveBeenCalled()
  expect(persistSessionFork).toHaveBeenCalledOnce()
  expect(harness.agent.sent).toHaveLength(0)
  release()
  await vi.waitFor(() => expect(handoff).toHaveBeenCalledOnce())
})

it('does not hand off if a background turn starts when maintenance releases', async () => {
  await start()
  vi.mocked(persistSessionFork).mockImplementationOnce(async (ctx, source, boundary) => {
    const child = ctx.sessions.fork(source, boundary, SessionId('saved-child'))
    harness.agent.status = 'running'
    return child
  })
  submit('/fork')
  await vi.waitFor(async () => expect(await terminal.snapshot()).toContain('session switch cancelled'))
  expect(handoff).not.toHaveBeenCalled()
  expect(await terminal.snapshot()).toContain('Fork saved as saved-child')
})

it('does not hand off after UI disposal during a write', async () => {
  await start()
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  releases.push(release)
  const persist = vi.mocked(persistSessionFork).getMockImplementation()!
  vi.mocked(persistSessionFork).mockImplementationOnce(async (...args) => {
    await barrier
    return persist(...args)
  })
  submit('/fork')
  await vi.waitFor(() => expect(persistSessionFork).toHaveBeenCalledOnce())
  await harness.controller.dispose()
  release()
  await new Promise(resolve => setImmediate(resolve))
  expect(handoff).not.toHaveBeenCalled()
})
