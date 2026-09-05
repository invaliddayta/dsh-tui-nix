import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { createTuiTestHarness, disposeTuiTestHarness } from './harness.ts'
import { HeadlessTerminal } from './headless-terminal.ts'

describe('packaged Harness compatibility', () => {
  let terminal: HeadlessTerminal
  let harness: Awaited<ReturnType<typeof createTuiTestHarness>>
  let handoff: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    terminal = new HeadlessTerminal(100, 32)
    handoff = vi.fn(async () => {})
    harness = await createTuiTestHarness(terminal, vi.fn(), {
      omitInitialLifecycle: true,
      config: { resumeScanConcurrency: 1 },
      handoffResume: handoff,
    })
    await terminal.waitForFrame(0)
  })

  afterEach(async () => {
    if (harness !== undefined) await disposeTuiTestHarness(harness)
    await terminal.dispose()
    vi.restoreAllMocks()
  })

  const question = (id: string) => ({
    id,
    question: `Choose ${id}`,
    options: [{ label: 'Safe' }, { label: 'Fast' }],
  })

  it('answers through the agent-scoped user-question service', async () => {
    const answer = harness.ctx.userQuestions.ask({
      agent: harness.agent,
      questions: [question('mode')],
    })
    await vi.waitFor(async () => expect(await terminal.snapshot()).toContain('Choose mode'))
    terminal.send('\x1b[B')
    terminal.send('\r')
    await expect(answer).resolves.toEqual({ answers: [{ id: 'mode', selected: ['Fast'] }] })
  })

  it('rejects queued and active questions on abort and accepts the next request', async () => {
    const active = new AbortController()
    const queued = new AbortController()
    const first = harness.ctx.userQuestions.ask({
      agent: harness.agent, questions: [question('active')], signal: active.signal,
    })
    const second = harness.ctx.userQuestions.ask({
      agent: harness.agent, questions: [question('queued')], signal: queued.signal,
    })
    const firstRejected = expect(first).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    const secondRejected = expect(second).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await vi.waitFor(async () => expect(await terminal.snapshot()).toContain('Choose active'))
    queued.abort()
    active.abort()
    await Promise.all([firstRejected, secondRejected])

    const next = harness.ctx.userQuestions.ask({ agent: harness.agent, questions: [question('next')] })
    await vi.waitFor(async () => expect(await terminal.snapshot()).toContain('Choose next'))
    terminal.send('\r')
    await expect(next).resolves.toEqual({ answers: [{ id: 'next', selected: ['Safe'] }] })
  })

  it('rejects already-aborted requests and unregisters the answerer on disposal', async () => {
    await expect(harness.ctx.userQuestions.ask({
      agent: harness.agent, questions: [question('aborted')], signal: AbortSignal.abort(),
    })).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    const pending = harness.ctx.userQuestions.ask({ agent: harness.agent, questions: [question('pending')] })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await harness.controller.dispose()
    await rejected
    await expect(harness.ctx.userQuestions.ask({
      agent: harness.agent, questions: [question('late')],
    })).rejects.toMatchObject({ code: 'NO_PROVIDER' })
  })

  it('reads live sessions using the current Session API', async () => {
    expect(harness.session).not.toHaveProperty('events')
    terminal.send('/resume')
    terminal.send('\r')
    await vi.waitFor(async () => {
      const screen = await terminal.snapshot()
      expect(screen).toContain('Resume session')
      expect(screen).toContain('current')
      expect(screen).not.toContain('Unreadable session')
    })
  })

  it('lists a stored session beside a corrupt one and hands off to its own workspace', async () => {
    const saved = {
      ...harness.session.header, id: SessionId('saved-session'), createdAt: 100, cwd: '/saved-workspace',
    }
    const corrupt = { ...saved, id: SessionId('corrupt-session') }
    const query = harness.ctx.sessionQuery
    vi.spyOn(query, 'listSessions').mockResolvedValue([
      { header: saved, live: false, persisted: true },
      { header: corrupt, live: false, persisted: true },
    ])
    const read = vi.spyOn(query, 'readSession').mockImplementation(async id => {
      if (id === corrupt.id) throw new Error('corrupt log')
      return {
        session: saved,
        inheritedEventCount: SessionLogOffset(0),
        events: [{
          type: 'session/title', seq: 0, time: 200,
          data: { title: 'Saved work', messageSeqs: [], source: { kind: 'fallback' } },
        }],
      }
    })
    // Current persistence no longer exposes locate(); the TUI must use query.
    harness.ctx.provide('sessionPersistence', {} as never)
    terminal.send('/resume')
    terminal.send('\r')
    await vi.waitFor(async () => expect(await terminal.snapshot()).toContain('Resume session'))
    terminal.send('\t')
    await vi.waitFor(async () => {
      const screen = await terminal.snapshot()
      expect(screen).toContain('Saved work')
      expect(screen).toContain('Unreadable session')
    })
    terminal.send('Saved work')
    await vi.waitFor(async () => expect(await terminal.snapshot()).not.toContain('Unreadable session'))
    terminal.send('\r')
    await vi.waitFor(() => expect(handoff).toHaveBeenCalledWith(saved.id, saved.cwd))
    expect(read.mock.calls.filter(([id]) => id === saved.id)).toHaveLength(2)
  })

  it('stops scheduling resume reads when the picker is cancelled', async () => {
    const first = { ...harness.session.header, id: SessionId('first') }
    const second = { ...first, id: SessionId('second') }
    const query = harness.ctx.sessionQuery
    vi.spyOn(query, 'listSessions').mockResolvedValue([
      { header: first, live: false, persisted: true },
      { header: second, live: false, persisted: true },
    ])
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof query.readSession>>>()
    const read = vi.spyOn(query, 'readSession').mockReturnValue(pending.promise)
    terminal.send('/resume')
    terminal.send('\r')
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    terminal.send('\x1b')
    await vi.waitFor(async () => expect(await terminal.snapshot()).not.toContain('Resume session'))
    pending.resolve({ session: first, inheritedEventCount: SessionLogOffset(0), events: [] })
    await new Promise(resolve => setImmediate(resolve))
    expect(read).toHaveBeenCalledOnce()
    expect(handoff).not.toHaveBeenCalled()
  })
})
