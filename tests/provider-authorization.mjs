// node tests/provider-authorization.mjs RUNTIME_ROOT [COMPILED_AUTHORIZATION_JS]
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

assert(process.argv[2], 'Expected runtime root containing node_modules')
const runtime = resolve(process.argv[2])
const requireRuntime = createRequire(join(runtime, 'package.json'))
const load = name => import(pathToFileURL(requireRuntime.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: LlmRuntime } = await load('@deepseek-ai/dsh-llm')
const { FileSettingsProvider } = await load('@deepseek-ai/dsh-settings-file')
const { LocalCredentialProvider } = await load('@deepseek-ai/dsh-credentials-local')
const { credentialKey } = await load('@deepseek-ai/dsh-credentials')
const { AuthorizationService } = await load('@deepseek-ai/dsh-authorization')
const { UserQuestionError } = await load('@deepseek-ai/dsh-user-questions')
const PiAi = await load('@deepseek-ai/dsh-llm-pi-ai')

globalThis.fetch = async () => { throw new Error('Network forbidden in authorization smoke') }
const root = await mkdtemp(join(tmpdir(), 'provider-authorization-'))
const contexts = []
let count = 0
const key = credentialKey('llm-pi-ai', 'openai')
const record = { kind: 'api-key', value: 'offline-fabricated-key' }
const answer = custom => ({ answers: [{ id: 'authorization', selected: [], custom }] })
const idle = { ask: async () => { throw new Error('Unexpected question') }, notify() {} }
const fresh = () => new AbortController().signal
async function boot({ native = false, base = {}, user = {} } = {}) {
  const dir = await mkdtemp(join(root, 'case-'))
  const path = join(dir, 'settings.json')
  await writeFile(path, JSON.stringify({ 'llm-pi-ai': user }))
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path, watch: false })
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, 'credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  if (native) await ctx.plugin(PiAi, base)
  else ctx.settings.register('llm-pi-ai', PiAi.Config, { base })
  // Authorization must use the supplied private overlay, never the model-facing seam.
  ctx.on('user-questions/request', () => { throw new Error('Authorization escaped the private overlay') })
  return { ctx, path, dir }
}
function flow(ctx, run) {
  ctx.authorization.registerFlow({ key, label: 'Offline test', methods: [{ id: 'test', label: 'Test' }], run })
  return ctx.authorization.describe(key)
}
async function section(path) {
  return JSON.parse(await readFile(path, 'utf8'))['llm-pi-ai']
}
function passed(label) {
  count++
  console.log(`PASS: ${label}`)
}
try {
  let modulePath = join(runtime, 'node_modules/@dsh-tui/providers/lib/authorization.js')
  if (process.argv[3]) {
    modulePath = join(root, 'authorization.mjs')
    await copyFile(resolve(process.argv[3]), modulePath)
    await symlink(join(runtime, 'node_modules'), join(root, 'node_modules'), 'dir')
  }
  const { authorizeProvider } = await import(pathToFileURL(modulePath).href)
  const { getBuiltinProviders, getBuiltinModels } = await import(pathToFileURL(
    join(runtime, 'node_modules/@earendil-works/pi-ai/dist/providers/all.js'),
  ).href)
  const catalogs = getBuiltinProviders().map(provider => [provider, getBuiltinModels(provider)])
    .filter(([, models]) => models.length > 0)
  const catalogHost = await boot({ native: true, user: {
    providers: Object.fromEntries(catalogs.map(([provider]) => [provider, {}])),
  } })
  for (const [provider, catalog] of catalogs) {
    const expected = [...new Set(catalog.map(model => model.id))].sort()
    assert.deepEqual((await catalogHost.ctx.llm.listModels(provider)).map(model => model.id).sort(), expected, provider)
    assert.deepEqual((await catalogHost.ctx.llm.discoverModels('llm-pi-ai', { provider }))
      .map(model => model.id).sort(), expected, `${provider} wizard discovery`)
  }
  const flash = getBuiltinModels('zai').find(model => model.id === 'glm-5.3-flash')
  assert(flash, 'Z.ai catalog must include GLM-5.3-Flash')
  assert.deepEqual(flash.input, ['text', 'image'])
  assert.equal(flash.contextWindow, 1000000)
  assert(getBuiltinModels('openai').some(model => model.id === 'gpt-6-astra'))
  await catalogHost.ctx.settings.update('llm-pi-ai', {
    providers: { zai: { models: [{ id: 'glm-5.3' }] } },
  })
  assert.deepEqual((await catalogHost.ctx.llm.listModels('zai')).map(model => model.id), ['glm-5.3'])
  passed(`all ${catalogs.length} nonempty provider catalogs reach model selection and wizard discovery; explicit selections remain respected`)
  const native = await boot({ native: true })
  const entries = native.ctx.authorization.list()
  const oauth = entries.filter(entry => entry.methods.some(method => method.id === 'oauth'))
  assert(oauth.length > 3, 'Native OAuth catalog should exceed the former three-provider restriction')
  for (const provider of ['openai-codex', 'anthropic', 'xai']) {
    assert(oauth.some(entry => entry.key === credentialKey('llm-pi-ai', provider)))
  }
  assert(entries.some(entry => entry.methods.some(method => method.id === 'api-key')))
  console.log(`Native catalog: ${entries.length} flows, ${oauth.length} OAuth providers (${oauth.map(entry => entry.key).join(', ')})`)
  const nativeEntry = native.ctx.authorization.describe(key)
  assert(nativeEntry.methods.some(method => method.id === 'api-key'))
  assert.equal(await authorizeProvider(native.ctx, nativeEntry, 'api-key', {
    notify() {},
    async ask(request, options) {
      assert.equal(request.questions[0].id, 'authorization')
      assert.equal(options.redact, true)
      return answer('offline-fabricated-key')
    },
  }, fresh()), 'authorized')
  assert((await native.ctx.credentials.describeRecord(key)).configured)
  assert.deepEqual((await section(native.path)).providers.openai, {})
  assert(native.ctx.llm.listConfigurableProviders().some(entry => entry.provider === 'openai'))
  passed('native PiAI API-key flow writes shared credentials and enables a missing profile offline')

  const original = {
    unknownSectionField: { retained: true },
    providers: {
      openai: {
        apiKeyEnv: 'OLD_KEY_REF', displayName: 'Preserved name', baseURL: 'https://example.invalid/v1',
        models: [{ id: 'gpt-4o', contextWindow: 128000 }],
        unknownProfileField: { retained: true },
      },
      anthropic: { displayName: 'Other provider' },
    },
  }
  const successful = await boot({ user: original })
  let promptCount = 0
  let notices = 0
  const entry = flow(successful.ctx, async session => {
    assert.equal(session.method, 'test')
    session.notify({ message: 'Offline notice', url: 'https://example.invalid', code: 'TEST' })
    assert.equal(await session.prompt({ kind: 'select', message: 'Choose', options: [
      { id: 'second-id', label: 'Second label', description: 'Choice detail' },
      { id: 'first-id', label: 'First label' },
    ] }), 'second-id')
    for (const kind of ['secret', 'text']) {
      assert.equal(await session.prompt({ kind, message: 'Sensitive input', placeholder: 'Placeholder' }), '  fabricated  ')
    }
    await successful.ctx.credentials.modifyRecord(key, async () => record)
  })
  assert.equal(await authorizeProvider(successful.ctx, entry, 'test', {
    notify(notice) { assert.equal(notice.code, 'TEST'); notices++ },
    async ask(request, options) {
      const question = request.questions[0]
      assert.equal(question.id, 'authorization')
      assert.equal(request.agent, undefined)
      assert.equal(request.signal.aborted, false)
      promptCount++
      if (question.options) {
        assert.equal(options.redact, false)
        assert.equal(question.options[0].description, 'Choice detail')
        return { answers: [{ id: question.id, selected: ['Second label'] }] }
      }
      assert.equal(options.redact, true)
      assert.equal(question.detail, 'Placeholder')
      return answer('  fabricated  ')
    },
  }, fresh()), 'authorized')
  assert.equal(promptCount, 3)
  assert.equal(notices, 1)
  const expected = structuredClone(original)
  delete expected.providers.openai.apiKeyEnv
  assert.deepEqual(await section(successful.path), expected)
  assert((await successful.ctx.credentials.describeRecord(key)).configured)
  assert.equal((await stat(join(successful.dir, 'credentials.yaml'))).mode & 0o777, 0o600)
  passed('deterministic flow maps selection IDs, redacts text/secret, preserves answers and unrelated settings')

  for (const mode of ['escape', 'attempt', 'prompt', 'failure', 'before', 'after-commit', 'after-settlement']) {
    const test = await boot()
    const before = await readFile(test.path, 'utf8')
    const controller = new AbortController()
    const promptAbort = new AbortController()
    if (mode === 'after-settlement') test.ctx.on('authorization/settled', () => controller.abort())
    let ran = false
    const testEntry = flow(test.ctx, async session => {
      ran = true
      if (mode === 'after-commit' || mode === 'after-settlement') {
        await test.ctx.credentials.modifyRecord(key, async () => record)
        if (mode === 'after-commit') controller.abort()
        return
      }
      await session.prompt({ kind: 'text', message: 'Private input', signal: promptAbort.signal })
      throw new Error('Must not continue past rejected prompt')
    })
    if (mode === 'before') controller.abort()
    const result = authorizeProvider(test.ctx, testEntry, 'test', {
      notify() {},
      async ask(request, options) {
        assert.equal(options.redact, true)
        if (mode === 'attempt') controller.abort()
        if (mode === 'prompt') promptAbort.abort()
        if (mode === 'attempt' || mode === 'prompt') assert.equal(request.signal.aborted, true)
        if (mode === 'failure') throw new Error('fabricated-sensitive-error')
        throw new UserQuestionError('fabricated-sensitive-error', 'ASK_ABORTED')
      },
    }, controller.signal)
    if (mode === 'prompt' || mode === 'failure') {
      await assert.rejects(result, error => error.message === 'Provider authorization failed.' && error.cause === undefined)
    } else assert.equal(await result, 'cancelled')
    if (mode === 'before') assert.equal(ran, false)
    assert.equal(await readFile(test.path, 'utf8'), before)
    if (mode !== 'after-commit' && mode !== 'after-settlement') {
      assert.equal((await test.ctx.credentials.describeRecord(key)).configured, false)
    }
  }
  passed('Esc declines; attempt abort cancels; retired prompt and genuine failures stay failures; cancellation never writes profiles')

  for (const user of [{}, { providers: { openai: { apiKeyEnv: 'USER_REF' } } }]) {
    const test = await boot({ base: { providers: { openai: { apiKeyEnv: 'BASE_REF' } } }, user })
    let ran = false
    const testEntry = flow(test.ctx, async () => { ran = true })
    const before = await readFile(test.path, 'utf8')
    await assert.rejects(authorizeProvider(test.ctx, testEntry, 'test', idle, fresh()), /composition-base apiKeyEnv/)
    assert.equal(ran, false)
    assert.equal(await readFile(test.path, 'utf8'), before)
  }
  passed('inherited apiKeyEnv is refused before login, including when hidden by a user override')

  const updated = await boot({ base: { providers: { openai: { displayName: 'Base name' } } } })
  const updatedEntry = flow(updated.ctx, async session => {
    const retired = new AbortController()
    retired.abort()
    await assert.rejects(session.prompt({ kind: 'text', message: 'Retired', signal: retired.signal }))
    assert.equal(session.signal.aborted, false)
    await updated.ctx.settings.mutate('llm-pi-ai', [
      { op: 'set', path: ['providers', 'openai', 'displayName'], value: 'Concurrent name' },
      { op: 'set', path: ['unknown'], value: { retained: true } },
    ])
    await updated.ctx.credentials.modifyRecord(key, async () => record)
  })
  assert.equal(await authorizeProvider(updated.ctx, updatedEntry, 'test', idle, fresh()), 'authorized')
  assert.deepEqual(await section(updated.path), {
    providers: { openai: { displayName: 'Concurrent name' } }, unknown: { retained: true },
  })
  passed('retiring one prompt does not cancel the flow; settings changed during login are preserved')

  const foreign = { ...entry, key: credentialKey('other-owner', 'openai') }
  await assert.rejects(authorizeProvider(successful.ctx, foreign, 'test', idle, fresh()), /Unsupported authorization provider/)
  passed('foreign authorization scopes are refused')
  console.log(`${count} authorization checks passed; no live OAuth attempted`)
} finally {
  for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}
