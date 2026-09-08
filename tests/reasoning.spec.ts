import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { createTuiTestHarness, disposeTuiTestHarness } from './harness.ts'
import { HeadlessTerminal } from './headless-terminal.ts'

let terminal: HeadlessTerminal
let harness: Awaited<ReturnType<typeof createTuiTestHarness>>
const ctrlT = '\x14'

beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in reasoning tests') }))
  terminal = new HeadlessTerminal(100, 32)
  harness = await createTuiTestHarness(terminal, vi.fn(), {
    omitInitialLifecycle: true,
    agentOptions: { provider: 'xai', model: 'grok-4.6' },
    async configureContext(ctx) {
      await ctx.plugin(ToolRegistry)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmPiAi, { providers: {
        xai: {},
        zai: {},
        local: {
          api: 'openai-completions', baseURL: 'http://127.0.0.1:1/v1',
          models: [{ id: 'plain', contextWindow: 32768, reasoningEfforts: false }],
        },
      } })
    },
  })
  await terminal.waitForFrame(0)
})

afterEach(async () => {
  if (harness !== undefined) await disposeTuiTestHarness(harness)
  await terminal.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function selection(assemble = true) {
  if (assemble) await harness.ctx.systemPrompt.assemble(assembleContextFor(harness.agent))
  return agentEvents(harness.ctx, harness.agent).waterfall(
    'agent/request', { turn: 0, step: 0, signal: new AbortController().signal },
    async () => ({ provider: 'xai', model: 'grok-4.6' }),
  )
}

it('cycles Grok effort from chat, preserves the draft, and changes the next request', async () => {
  terminal.send('unfinished prompt')
  for (const effort of ['low', 'medium', 'high', 'xhigh', undefined]) {
    terminal.send(ctrlT)
    await vi.waitFor(async () => {
      const current = await selection()
      expect(current.provider).toBe('xai')
      expect(current.model).toBe('grok-4.6')
      expect(current.reasoningEffort).toBe(effort)
      const screen = await terminal.snapshot()
      expect(screen).toContain('unfinished prompt')
      if (effort !== undefined) expect(screen).toContain(`grok-4.6 ${effort}`)
      else expect(screen).not.toContain('grok-4.6 xhigh')
      expect(screen).not.toContain('Reasoning effort:')
      expect(screen).not.toContain('Model selected:')
      expect(screen).not.toContain('Model is already')
    })
  }
  expect(harness.agent.sent).toHaveLength(0)
  expect(fetch).not.toHaveBeenCalled()
})

it('serializes rapid presses and uses the selected provider catalog, not hard-coded Grok levels', async () => {
  for (let i = 0; i < 4; i++) terminal.send(ctrlT)
  await vi.waitFor(async () => expect((await selection()).reasoningEffort).toBe('xhigh'))
  terminal.send('/model zai/glm-5.3-flash')
  terminal.send('\r')
  await vi.waitFor(async () => expect((await selection()).provider).toBe('zai'))
  const reasoning = (await harness.ctx.llm.resolveModelInfo('zai', 'glm-5.3-flash')).reasoning!
  for (const effort of reasoning.efforts) {
    terminal.send(ctrlT)
    await vi.waitFor(async () => expect((await selection()).reasoningEffort).toBe(effort.id))
  }
})

it.each(['\x14', '\x1b[116;5u', '\x1b[116;5:1u'])('cycles once for Ctrl+T %j with repeat/release events', async (press) => {
  terminal.send(press)
  terminal.send('\x1b[116;5:2u')
  terminal.send('\x1b[116;5:3u')
  // A queued command is a barrier: check after every key event has been processed.
  terminal.send('/model missing-model')
  terminal.send('\r')
  await vi.waitFor(async () => expect(await terminal.snapshot()).toContain('Unknown model: missing-model'))
  expect((await selection()).reasoningEffort).toBe('low')
})

it('ignores orphan releases and no longer uses Shift+Tab to change effort', async () => {
  terminal.send('\x1b[116;5:3u')
  terminal.send('\x1b[116;5:2u')
  terminal.send('\x1b[Z')
  terminal.send('/model missing-model')
  terminal.send('\r')
  await vi.waitFor(async () => expect(await terminal.snapshot()).toContain('Unknown model: missing-model'))
  expect((await selection()).reasoningEffort).toBeUndefined()
})

it('switches and reselects models silently while retaining validation errors', async () => {
  for (let i = 0; i < 2; i++) {
    terminal.send('/model zai/glm-5.3-flash')
    terminal.send('\r')
    await vi.waitFor(async () => {
      expect((await selection()).provider).toBe('zai')
      expect(await terminal.snapshot()).toContain('glm-5.3-flash')
    })
  }
  terminal.send('/model missing-model')
  terminal.send('\r')
  await vi.waitFor(async () => {
    const screen = await terminal.snapshot()
    expect(screen).toContain('Unknown model: missing-model')
    expect(screen).not.toContain('Model selected:')
    expect(screen).not.toContain('Model is already')
    expect(screen).not.toContain('New steps will use it.')
  })
  expect((await selection()).provider).toBe('zai')
})

it('leaves effort changes in the model picker uncommitted until Enter', async () => {
  terminal.send('/model')
  terminal.send('\r')
  await vi.waitFor(async () => expect(await terminal.snapshot()).toContain('Select model'))
  terminal.send('\x1b[116;5:1u')
  terminal.send('\x1b[116;5:2u')
  terminal.send('\x1b[116;5:3u')
  await vi.waitFor(async () => expect(await terminal.snapshot()).toMatch(/Grok 4\.6.*Low/))
  expect((await selection()).reasoningEffort).toBeUndefined()
  terminal.send('\x1b')
  await vi.waitFor(async () => expect(await terminal.snapshot()).not.toContain('Select model'))
  expect((await selection()).reasoningEffort).toBeUndefined()
  terminal.send(ctrlT)
  await vi.waitFor(async () => expect((await selection()).reasoningEffort).toBe('low'))
  terminal.send('/model')
  terminal.send('\r')
  await vi.waitFor(async () => expect(await terminal.snapshot()).toContain('Select model'))
  terminal.send(ctrlT)
  await vi.waitFor(async () => expect(await terminal.snapshot()).toMatch(/Grok 4\.6.*Medium/))
  terminal.send('\r')
  await vi.waitFor(async () => expect((await selection()).reasoningEffort).toBe('medium'))
})

it('explains models without adjustable effort instead of reporting a model-selection error', async () => {
  terminal.send('/model local/plain')
  terminal.send('\r')
  await vi.waitFor(async () => expect((await selection()).model).toBe('plain'))
  terminal.send(ctrlT)
  await vi.waitFor(async () => expect(await terminal.snapshot())
    .toContain('local/plain does not advertise adjustable reasoning effort.'))
  expect((await selection()).reasoningEffort).toBeUndefined()
})

it('applies a mid-turn change to the next step, not an already assembled request', async () => {
  expect((await selection()).reasoningEffort).toBeUndefined()
  harness.agent.status = 'running'
  terminal.send(ctrlT)
  await vi.waitFor(async () => expect(await terminal.snapshot()).toContain('grok-4.6 low'))
  expect((await selection(false)).reasoningEffort).toBeUndefined()
  expect((await selection()).reasoningEffort).toBe('low')
})

it('reports a capability lookup failure and accepts the next cycle', async () => {
  await vi.waitFor(async () => expect(await terminal.snapshot()).toContain('0% context'))
  const lookup = vi.spyOn(harness.ctx.llm, 'resolveModelInfo')
    .mockRejectedValueOnce(new Error('catalog temporarily unavailable'))
  terminal.send(ctrlT)
  await vi.waitFor(async () => expect(await terminal.snapshot())
    .toContain('Could not change reasoning effort: catalog temporarily unavailable'))
  expect((await selection()).reasoningEffort).toBeUndefined()
  lookup.mockRestore()
  terminal.send(ctrlT)
  await vi.waitFor(async () => expect((await selection()).reasoningEffort).toBe('low'))
})
