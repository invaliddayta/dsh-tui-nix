import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { createTuiTestHarness, disposeTuiTestHarness } from './harness.ts'
import { HeadlessTerminal } from './headless-terminal.ts'

it('registers configured Pi providers beside direct DeepSeek without network access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-providers-'))
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FileSettingsProvider, { path: join(root, 'settings.yaml'), watch: false })
    await ctx.plugin(LlmDeepSeek)
    await ctx.plugin(LlmPiAi)
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek-official'])

    await ctx.settings.update('llm-pi-ai', {
      providers: {
        openai: { apiKeyEnv: 'OPENAI_API_KEY' },
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
        google: { apiKeyEnv: 'GEMINI_API_KEY' },
        openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' },
        local: {
          api: 'openai-completions',
          baseURL: 'http://127.0.0.1:1/v1',
          models: [{ id: 'local-test-model', contextWindow: 32768 }],
        },
      },
    })
    expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toEqual([
      'anthropic', 'deepseek-official', 'google', 'local', 'openai', 'openrouter',
    ])
    for (const provider of ['deepseek-official', 'openai', 'anthropic', 'google', 'openrouter']) {
      expect((await ctx.llm.listModels(provider)).length).toBeGreaterThan(0)
    }
    expect(await ctx.llm.resolveModelInfo('local', 'local-test-model')).toMatchObject({
      provider: 'local', id: 'local-test-model', context: { contextWindow: 32768 },
    })

    await ctx.settings.replace('llm-pi-ai', {})
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek-official'])
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

describe('packaged Harness compatibility', () => {
  let terminal: HeadlessTerminal
  let harness: Awaited<ReturnType<typeof createTuiTestHarness>>
  let handoff: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    terminal = new HeadlessTerminal(100, 32)
    handoff = vi.fn(async () => {})
    // Keep every scan off the developer's durable title cache.
    process.env.DSH_TUI_RESUME_TITLE_CACHE = 'off'
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
    delete process.env.DSH_TUI_RESUME_TITLE_CACHE
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
    const titles = vi.spyOn(query, 'readTitleSnapshots').mockResolvedValue([
      {
        sessionId: saved.id,
        status: 'fulfilled',
        value: {
          session: saved,
          title: {
            title: 'Saved work',
            messageSeqs: [],
            source: { kind: 'fallback' },
            eventSeq: SessionSeq(0),
            updatedAt: 1,
          },
          lastActivityAt: 200,
        },
      },
      { sessionId: corrupt.id, status: 'rejected', reason: new Error('corrupt log') },
    ])
    // The scan resolves rows without whole-log reads; only the chosen row's
    // preflight fully reads (and replay-validates) its log.
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
    expect(titles).toHaveBeenCalledTimes(1)
    expect(titles).toHaveBeenCalledWith([saved.id, corrupt.id], expect.anything())
    expect(read.mock.calls.filter(([id]) => id === saved.id)).toHaveLength(1)
  })

  it('stops scheduling resume reads when the picker is cancelled', async () => {
    const first = { ...harness.session.header, id: SessionId('first') }
    const second = { ...first, id: SessionId('second') }
    const query = harness.ctx.sessionQuery
    vi.spyOn(query, 'listSessions').mockResolvedValue([
      { header: first, live: false, persisted: true },
      { header: second, live: false, persisted: true },
    ])
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof query.readTitleSnapshots>>>()
    const titles = vi.spyOn(query, 'readTitleSnapshots').mockReturnValue(pending.promise)
    terminal.send('/resume')
    terminal.send('\r')
    await vi.waitFor(() => expect(titles).toHaveBeenCalledOnce())
    terminal.send('\x1b')
    await vi.waitFor(async () => expect(await terminal.snapshot()).not.toContain('Resume session'))
    pending.resolve([])
    await new Promise(resolve => setImmediate(resolve))
    expect(titles).toHaveBeenCalledOnce()
    expect(handoff).not.toHaveBeenCalled()
  })

  it('serves a warm scan from the durable title cache without log reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tui-resume-cache-'))
    try {
      process.env.DSH_TUI_RESUME_TITLE_CACHE = join(root, 'resume-titles.json')
      const stored = {
        ...harness.session.header, id: SessionId('cached-session'), createdAt: 100, cwd: '/cached-workspace',
      }
      const record = {
        header: stored, live: false, persisted: true, revision: SessionPersistenceRevision('rev-one'),
      }
      const query = harness.ctx.sessionQuery
      vi.spyOn(query, 'listSessions').mockResolvedValue([record])
      const read = vi.spyOn(query, 'readSession')
      const titles = vi.spyOn(query, 'readTitleSnapshots').mockResolvedValue([{
        sessionId: stored.id,
        status: 'fulfilled',
        value: {
          session: stored,
          title: {
            title: 'Cached work',
            messageSeqs: [],
            source: { kind: 'fallback' },
            eventSeq: SessionSeq(0),
            updatedAt: 1,
          },
          lastActivityAt: 500,
        },
      }])
      const cold = async (): Promise<void> => {
        terminal.send('/resume')
        terminal.send('\r')
        await vi.waitFor(async () => expect(await terminal.snapshot()).toContain('Resume session'))
        terminal.send('\t')
        await vi.waitFor(async () => expect(await terminal.snapshot()).toContain('Cached work'))
      }
      await cold()
      expect(titles).toHaveBeenCalledTimes(1)
      expect(titles).toHaveBeenCalledWith([stored.id], expect.anything())
      // The cold scan publishes its fold before the picker reopens.
      await vi.waitFor(async () =>
        expect(await readFile(process.env.DSH_TUI_RESUME_TITLE_CACHE!, 'utf8')).toContain('Cached work'))
      terminal.send('\x1b')
      await vi.waitFor(async () => expect(await terminal.snapshot()).not.toContain('Resume session'))
      await cold()
      // The second scan serves every row from the revision-keyed cache.
      expect(titles).toHaveBeenCalledTimes(1)
      expect(read).not.toHaveBeenCalled()
      // Titles are conversation content: the cache is owner-only.
      expect((await stat(process.env.DSH_TUI_RESUME_TITLE_CACHE!)).mode & 0o777).toBe(0o600)
      expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])

      // A changed artifact revision invalidates its row.
      vi.mocked(query.listSessions).mockResolvedValue([
        { ...record, revision: SessionPersistenceRevision('rev-two') },
      ])
      terminal.send('\x1b')
      await vi.waitFor(async () => expect(await terminal.snapshot()).not.toContain('Resume session'))
      await cold()
      expect(titles).toHaveBeenCalledTimes(2)
      await vi.waitFor(async () =>
        expect(await readFile(process.env.DSH_TUI_RESUME_TITLE_CACHE!, 'utf8')).toContain('rev-two'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('shows cached rows before uncached title reads settle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tui-resume-cache-'))
    try {
      const path = join(root, 'resume-titles.json')
      process.env.DSH_TUI_RESUME_TITLE_CACHE = path
      const warm = { ...harness.session.header, id: SessionId('warm-session'), createdAt: 100, cwd: '/w' }
      const cold = { ...warm, id: SessionId('cold-session') }
      await writeFile(path, JSON.stringify({
        v: 1, titles: { [warm.id]: { rev: 'warm-rev', title: 'Warm title', lastActivityAt: 300 } },
      }))
      const query = harness.ctx.sessionQuery
      vi.spyOn(query, 'listSessions').mockResolvedValue([
        { header: warm, live: false, persisted: true, revision: SessionPersistenceRevision('warm-rev') },
        { header: cold, live: false, persisted: true, revision: SessionPersistenceRevision('cold-rev') },
      ])
      const pending = Promise.withResolvers<Awaited<ReturnType<typeof query.readTitleSnapshots>>>()
      const titles = vi.spyOn(query, 'readTitleSnapshots').mockReturnValue(pending.promise)
      terminal.send('/resume')
      terminal.send('\r')
      await vi.waitFor(() => expect(titles).toHaveBeenCalledWith([cold.id], expect.anything()))
      terminal.send('\t')
      await vi.waitFor(async () => expect(await terminal.snapshot()).toContain('Warm title'))
      pending.resolve([{ sessionId: cold.id, status: 'rejected', reason: new Error('late') }])
      await vi.waitFor(async () => expect(await terminal.snapshot()).toContain('Unreadable session'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
