import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { assertEntriesActivated } from '@deepseek-ai/dsh-app-boot'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import Authorization from '@deepseek-ai/dsh-authorization'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import * as Providers from '../src/providers/index.js'
import { createDialogs } from '../src/providers/dialog.js'
import { createTuiTestHarness, disposeTuiTestHarness } from './harness.ts'
import { HeadlessTerminal } from './headless-terminal.ts'

let terminal: HeadlessTerminal
let harness: Awaited<ReturnType<typeof createTuiTestHarness>>
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'provider-ui-'))
  terminal = new HeadlessTerminal(100, 32)
  harness = await createTuiTestHarness(terminal, vi.fn(), {
    omitInitialLifecycle: true,
    async configureContext(ctx) {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRegistry)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(FileSettingsProvider, { path: join(root, 'settings.yaml'), watch: false })
      await ctx.plugin(LocalCredentials, { path: join(root, 'credentials.yaml'), watch: false })
      await ctx.plugin(Authorization)
      await ctx.plugin(LlmPiAi)
    },
  })
  await harness.ctx.plugin(Providers)
  await terminal.waitForFrame(0)
})
afterEach(async () => {
  await disposeTuiTestHarness(harness)
  await terminal.dispose()
  await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})
const screen = async (text: string) => vi.waitFor(async () => expect(await terminal.snapshot()).toContain(text))

it('keeps typed and pasted secrets out of all terminal output and session events, including resize', async () => {
  const write = vi.spyOn(terminal, 'write')
  const ask = vi.spyOn(harness.ctx.userQuestions, 'ask')
  const controller = new AbortController()
  const ui = createDialogs(harness.ctx.tui, controller.signal)
  const result = ui.ask({ questions: [{ id: 'key', question: 'Secret API key' }] }, { redact: true })
  await screen('Secret API key')
  terminal.send('\x1b[200~sk-test-do-not-render\x1b[201~')
  await screen('****')
  terminal.resize(42, 16)
  await screen('Secret API key')
  terminal.send('\r')
  await expect(result).resolves.toEqual({ answers: [{ id: 'key', selected: [], custom: 'sk-test-do-not-render' }] })
  expect(write.mock.calls.flat().join('')).not.toContain('sk-test-do-not-render')
  expect(JSON.stringify(harness.session.snapshotEvents())).not.toContain('sk-test-do-not-render')
  expect(ask).not.toHaveBeenCalled()
})

it('supports filtering, default multi-selection, and cancellation without stuck overlays', async () => {
  const ui = createDialogs(harness.ctx.tui, new AbortController().signal)
  const result = ui.ask({ questions: [{ id: 'models', question: 'Pick models', multiSelect: true,
    options: [{ label: 'Alpha' }, { label: 'Beta' }], ...{ defaultSelected: ['Beta'], hideCustomInput: true },
  }] })
  await screen('[x] Beta')
  terminal.send('Alpha')
  await screen('1/1')
  terminal.send(' ')
  terminal.send('\r')
  await expect(result).resolves.toMatchObject({ answers: [{ selected: ['Beta', 'Alpha'] }] })
  const cancelled = ui.ask({ questions: [{ id: 'cancel', question: 'Cancel this' }] })
  const rejected = expect(cancelled).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  await screen('Cancel this')
  terminal.send('\x1b')
  await rejected
  const next = ui.ask({ questions: [{ id: 'empty', question: 'Empty local key' }] }, { redact: true })
  await screen('Empty local key')
  terminal.send('\r')
  await expect(next).resolves.toMatchObject({ answers: [{ custom: '' }] })
})

it('opens /provider and cancels without changing settings', async () => {
  const result = harness.ctx.commands.execute(harness.agent, '/provider', [], new AbortController().signal)
  await screen('Provider setup')
  terminal.send('\x1b')
  await expect(result).resolves.toMatchObject({ result: { kind: 'success', text: 'Provider setup cancelled.' } })
  expect(harness.ctx.settings.get('llm-pi-ai')).toMatchObject({ providers: {} })
})

it('signs into OpenAI with a fabricated API key entirely through private dialogs', async () => {
  const write = vi.spyOn(terminal, 'write')
  const result = harness.ctx.commands.execute(harness.agent, '/provider', [], new AbortController().signal)
  await screen('Provider setup'); terminal.send('\r')
  await screen('Choose a provider'); terminal.send('openai')
  await screen('> openai'); terminal.send('\r')
  await screen('Choose a sign-in method'); terminal.send('\r')
  await screen('Use this sign-in'); terminal.send('\r')
  await screen('API key')
  terminal.send('sk-native-ui-secret'); terminal.send('\r')
  await screen('Provider ready')
  terminal.send('\x1b[B'); terminal.send('\r')
  await expect(result).resolves.toMatchObject({ result: { kind: 'success' } })
  expect(harness.ctx.settings.get('llm-pi-ai')).toMatchObject({ providers: { openai: {} } })
  expect(await readFile(join(root, 'credentials.yaml'), 'utf8')).toContain('sk-native-ui-secret')
  expect(write.mock.calls.flat().join('')).not.toContain('sk-native-ui-secret')
  expect(JSON.stringify(harness.session.snapshotEvents())).not.toContain('sk-native-ui-secret')
  expect(await readFile(join(root, 'settings.yaml'), 'utf8')).not.toContain('sk-native-ui-secret')
  const logout = harness.ctx.commands.execute(harness.agent, '/provider', [], new AbortController().signal)
  await screen('Provider setup'); terminal.send('Sign out'); terminal.send('\r')
  await screen('Choose a provider to sign out'); terminal.send('\r')
  await screen('Remove stored sign-in'); terminal.send('\x1b[B'); terminal.send('\r')
  await expect(logout).resolves.toMatchObject({ result: { kind: 'success' } })
  expect(await harness.ctx.credentials.listRecords()).toEqual([])
  expect(harness.ctx.llm.listProviders().map(provider => provider.id)).not.toContain('openai')
})

it.each(['', 'sk-wizard-fabricated-key'])('configures a custom endpoint with private key input %j', async (apiKey) => {
  const write = vi.spyOn(terminal, 'write')
  vi.spyOn(harness.ctx.llm, 'discoverModels').mockResolvedValue([{ id: 'local-model', contextWindow: 32768 }])
  const result = harness.ctx.commands.execute(harness.agent, '/provider', [], new AbortController().signal)
  await screen('Provider setup'); terminal.send('\x1b[B'); terminal.send('\r')
  await screen('What do you want to do?'); terminal.send('\r')
  await screen('Which kind'); terminal.send('\x1b[B'); terminal.send('\r')
  await screen('Enter a route name'); terminal.send('local'); terminal.send('\r')
  await screen('Enter the API key')
  terminal.send(`\x1b[200~${apiKey}\x1b[201~`)
  if (apiKey) await screen('*'.repeat(apiKey.length))
  terminal.send('\r')
  await screen('Enter the baseURL'); terminal.send('http://127.0.0.1:1234/v1'); terminal.send('\r')
  await screen('Choose the wire protocol'); terminal.send('\r')
  await screen('Select the models'); terminal.send(' '); terminal.send('\r')
  await screen('Write this provider'); terminal.send('\r')
  await screen('Switch to the new provider'); terminal.send('\x1b[B'); terminal.send('\r')
  await expect(result).resolves.toMatchObject({ result: { kind: 'success', text: 'Provider setup added. Use /model to select an enabled provider.' } })
  expect(harness.ctx.settings.get('llm-pi-ai')).toMatchObject({ providers: { local: { baseURL: 'http://127.0.0.1:1234/v1', models: [{ id: 'local-model', contextWindow: 32768 }] } } })
  expect(await readFile(join(root, 'settings.yaml'), 'utf8')).toContain('LOCAL_API_KEY')
  expect(await readFile(join(root, 'credentials.yaml'), 'utf8')).toContain(apiKey || 'local')
  if (apiKey) {
    expect(write.mock.calls.flat().join('')).not.toContain(apiKey)
    expect(JSON.stringify(harness.session.snapshotEvents())).not.toContain(apiKey)
    expect(await readFile(join(root, 'settings.yaml'), 'utf8')).not.toContain(apiKey)
  }
  expect(harness.ctx.llm.listProviders().map(p => p.id)).toContain('local')
})

it('cancels a waiting browser flow and allows another provider command', async () => {
  vi.spyOn(harness.ctx.authorization, 'begin').mockImplementation(async request => {
    request.interaction.notify({ message: 'Waiting for browser approval', code: 'test-code' })
    await new Promise<void>(resolve => request.signal!.addEventListener('abort', () => resolve(), { once: true }))
    return { status: 'cancelled' }
  })
  const result = harness.ctx.commands.execute(harness.agent, '/provider', [], new AbortController().signal)
  await screen('Provider setup'); terminal.send('\r')
  await screen('Choose a provider'); terminal.send('openai-codex'); terminal.send('\r')
  await screen('Choose a sign-in method'); terminal.send('\r')
  await screen('Use this sign-in'); terminal.send('\r')
  await screen('Waiting for browser approval'); terminal.send('\x1b')
  await expect(result).resolves.toMatchObject({ result: { kind: 'success', text: 'Provider sign-in cancelled.' } })
  const next = harness.ctx.commands.execute(harness.agent, '/provider', [], new AbortController().signal)
  await screen('Provider setup'); terminal.send('\x1b')
  await expect(next).resolves.toMatchObject({ result: { kind: 'success' } })
})

it.each(['provider', 'private'])('does not retain /%s secrets in editor history or command events', async (name) => {
  harness.ctx.commands.register({
    name: 'private', recordInput: false, description: 'Private test command',
    handler: () => ({ kind: 'error', text: 'Private command rejected.' }),
  })
  terminal.send('/help'); terminal.send('\r')
  await screen('Keyboard shortcuts')
  terminal.send(`/${name} sk-accidental-secret`); terminal.send('\r')
  await screen(name === 'provider' ? 'Use /provider without arguments' : 'Private command rejected.')
  terminal.send('\x1b[A')
  await vi.waitFor(async () => expect(await terminal.snapshot()).toMatch(/dsh >\s+\/help\s/))
  expect(await terminal.snapshot()).not.toContain('sk-accidental-secret')
  expect(JSON.stringify(harness.session.snapshotEvents())).not.toContain('sk-accidental-secret')
  expect(harness.agent.sent).toHaveLength(0)
})

it('passes the boot audit before the asynchronously created TUI is available', async () => {
  const ctx = new Context()
  const register = vi.fn()
  try {
    ctx.provide('commands', { register } as never)
    for (const service of ['settings', 'credentials', 'authorization', 'llm']) ctx.provide(service, {} as never)
    const plugin = ctx.plugin(Providers)
    await new Promise(resolve => setImmediate(resolve))
    expect(ctx.get('tui')).toBeUndefined()
    await expect(assertEntriesActivated({
      loader: { entries: () => [{ fiber: plugin, options: { name: '@dsh-tui/providers' } }] },
    } as unknown as Context, 'dsh')).resolves.toBeUndefined()
    expect(register).not.toHaveBeenCalled()
    ctx.provide('tui', harness.ctx.tui)
    await vi.waitFor(() => expect(register).toHaveBeenCalledOnce())
    expect(register.mock.calls[0]?.[0]).toMatchObject({ name: 'provider' })
  } finally { await ctx.fiber.dispose() }
})
