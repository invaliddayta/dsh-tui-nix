import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentEvents, assembleContextFor, type ModelSelection } from '@deepseek-ai/dsh-agent'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { createTuiTestHarness, disposeTuiTestHarness } from './harness.ts'
import { HeadlessTerminal } from './headless-terminal.ts'

let directory: string
let settingsPath: string
const sessions: Array<Awaited<ReturnType<typeof createTuiTestHarness>>> = []
const releases: Array<() => void> = []
const profileRoute = { provider: 'xai', model: 'grok-4.6' }
const otherRoute = { provider: 'zai', model: 'glm-5.3-flash' }

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in model preference tests') }))
  directory = mkdtempSync(join(tmpdir(), 'dsh-last-model-'))
  settingsPath = join(directory, 'settings.json')
  writeFileSync(settingsPath, JSON.stringify({ unrelated: { preserve: 'user setting' } }))
})

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const session of sessions.splice(0)) {
    await disposeTuiTestHarness(session)
    await session.terminal.dispose()
  }
  rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const stored = () => JSON.parse(readFileSync(settingsPath, 'utf8'))
async function start(cwd: string, restored?: ModelSelection) {
  const terminal = new HeadlessTerminal(100, 32)
  const session = await createTuiTestHarness(terminal, vi.fn(), {
    cwd, omitInitialLifecycle: true, agentOptions: profileRoute,
    beforeMount: log => {
      if (restored) log.append('request/header', { header: { config: restored }, reason: 'resume' })
    },
    async configureContext(ctx) {
      await ctx.plugin(FileSettingsProvider, { path: settingsPath, watch: false })
      await ctx.plugin(AgentDefaultModel, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
      await ctx.plugin(ToolRegistry)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmPiAi, { providers: { xai: {}, zai: {} } })
    },
  })
  sessions.push(session)
  await terminal.waitForFrame(0)
  return session
}

async function selection(session: Awaited<ReturnType<typeof start>>) {
  await session.ctx.systemPrompt.assemble(assembleContextFor(session.agent))
  return agentEvents(session.ctx, session.agent).waterfall(
    'agent/request', { turn: 0, step: 0, signal: new AbortController().signal },
    async () => profileRoute,
  )
}

function choose(session: Awaited<ReturnType<typeof start>>, route: ModelSelection) {
  session.terminal.send(`/model ${route.provider}/${route.model}`)
  session.terminal.send('\r')
}

it('keeps the profile fallback before any preference and restores a choice in another project/context', async () => {
  const first = await start('/project-one')
  expect(await selection(first)).toEqual(profileRoute)
  expect(stored()['agent-default-model']).toBeUndefined()
  choose(first, otherRoute)
  await vi.waitFor(() => expect(stored()['agent-default-model']).toMatchObject(otherRoute))
  const second = await start('/project-two')
  expect(await selection(second)).toMatchObject(otherRoute)
  expect(stored().unrelated).toEqual({ preserve: 'user setting' })
  expect(fetch).not.toHaveBeenCalled()
  expect(first.agent.sent).toHaveLength(0)
  expect(second.agent.sent).toHaveLength(0)
})

it('retains a resumed session route without overwriting the newer global preference', async () => {
  writeFileSync(settingsPath, JSON.stringify({ 'agent-default-model': otherRoute }))
  const resumed = await start('/resumed-project', profileRoute)
  expect(await selection(resumed)).toEqual(profileRoute)
  await resumed.controller.dispose()
  expect(stored()['agent-default-model']).toEqual(otherRoute)
  const fresh = await start('/new-project')
  expect(await selection(fresh)).toEqual(otherRoute)
})

it('explicitly reselecting the resumed model makes it the next-session default', async () => {
  writeFileSync(settingsPath, JSON.stringify({ 'agent-default-model': otherRoute }))
  const resumed = await start('/resumed-project', profileRoute)
  choose(resumed, profileRoute)
  await vi.waitFor(() => expect(stored()['agent-default-model']).toMatchObject(profileRoute))
})

it('persists rapid reasoning selections in order and restores their effort', async () => {
  const first = await start('/project-one')
  first.terminal.send('\x14')
  first.terminal.send('\x14')
  first.terminal.send('\x14')
  await vi.waitFor(() => expect(stored()['agent-default-model']).toEqual({ ...profileRoute, reasoningEffort: 'high' }))
  const second = await start('/project-two')
  expect(await selection(second)).toEqual({ ...profileRoute, reasoningEffort: 'high' })
})

it('does not persist picker previews, cancellation or invalid model input', async () => {
  const session = await start('/project-one')
  const before = readFileSync(settingsPath, 'utf8')
  session.terminal.send('/model')
  session.terminal.send('\r')
  await vi.waitFor(async () => expect(await session.terminal.snapshot()).toContain('Select model'))
  session.terminal.send('\x14')
  session.terminal.send('\x1b')
  await vi.waitFor(async () => expect(await session.terminal.snapshot()).not.toContain('Select model'))
  session.terminal.send('/model does-not-exist')
  session.terminal.send('\r')
  await vi.waitFor(async () => expect(await session.terminal.snapshot()).toContain('Unknown model: does-not-exist'))
  expect(readFileSync(settingsPath, 'utf8')).toBe(before)
})

it('warns on persistence failure, keeps the session selection and permits later successful saves', async () => {
  const session = await start('/project-one')
  vi.spyOn(session.ctx.agentDefaultModel, 'saveSelection').mockRejectedValueOnce(new Error('read-only settings'))
  choose(session, otherRoute)
  await vi.waitFor(async () => expect(await session.terminal.snapshot()).toContain('could not save the startup default'))
  expect(await selection(session)).toMatchObject(otherRoute)
  expect(stored()['agent-default-model']).toBeUndefined()
  choose(session, profileRoute)
  await vi.waitFor(() => expect(stored()['agent-default-model']).toMatchObject(profileRoute))
})

it('drains an accepted pending write before terminal shutdown completes', async () => {
  const session = await start('/project-one')
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  releases.push(release)
  const save = session.ctx.agentDefaultModel.saveSelection.bind(session.ctx.agentDefaultModel)
  vi.spyOn(session.ctx.agentDefaultModel, 'saveSelection').mockImplementation(async next => {
    await barrier
    await save(next)
  })
  choose(session, otherRoute)
  await vi.waitFor(async () => expect(await selection(session)).toMatchObject(otherRoute))
  const closing = session.controller.dispose()
  expect(stored()['agent-default-model']).toBeUndefined()
  release()
  await closing
  expect(stored()['agent-default-model']).toMatchObject(otherRoute)
})
