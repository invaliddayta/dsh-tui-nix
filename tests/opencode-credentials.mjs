// node tests/opencode-credentials.mjs RUNTIME_ROOT [SOURCE_OR_COMPILED_BRIDGE_PATH]
import assert from 'node:assert/strict'
import { chmod, copyFile, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspect } from 'node:util'

assert(process.argv[2], 'Expected runtime root containing node_modules')
const runtime = resolve(process.argv[2])
const requireRuntime = createRequire(join(runtime, 'package.json'))
const load = name => import(pathToFileURL(requireRuntime.resolve(name)).href)
const root = await mkdtemp(join(tmpdir(), 'opencode-credentials-'))
const originalFetch = globalThis.fetch
const originalConnect = Socket.prototype.connect
let networkAttempts = 0
const forbidNetwork = () => { networkAttempts++; throw new Error('Network forbidden in OpenCode credential tests') }
globalThis.fetch = forbidNetwork
Socket.prototype.connect = forbidNetwork
const contexts = []
let count = 0
function passed(label) { count++; console.log(`PASS: ${label}`) }
const owned = /owned by OpenCode/
const unsafe = /Cannot read the OpenCode credential store safely/
const marker = 'SYNTHETIC_SECRET_MUST_NOT_APPEAR'
function assertDescription(actual, expected, code) {
  const { diagnostic, ...metadata } = actual
  assert.deepEqual(metadata, { writable: false, owner: 'OpenCode', ...expected })
  if (code) {
    assert.deepEqual(Object.keys(diagnostic).sort(), ['code', 'message'])
    assert.equal(diagnostic.code, code)
    assert.equal(typeof diagnostic.message, 'string')
    assert(diagnostic.message.length > 0)
  } else assert.equal(diagnostic, undefined)
  assert.doesNotMatch(inspect(actual, { depth: null }), /synthetic-|SYNTHETIC_SECRET_MUST_NOT_APPEAR/)
}

try {
  const { Context } = await load('@deepseek-ai/cordis')
  const { credentialKey, credentialRef } = await load('@deepseek-ai/dsh-credentials')
  const { createLaunchEnvironmentSnapshot } = await load('@deepseek-ai/dsh-launch-environment')
  const { default: LlmRuntime } = await load('@deepseek-ai/dsh-llm')
  const { FileSettingsProvider } = await load('@deepseek-ai/dsh-settings-file')
  const PiAi = await load('@deepseek-ai/dsh-llm-pi-ai')
  let modulePath = join(runtime, 'node_modules/dsh-credentials-opencode/lib/index.js')
  if (process.argv[3]) {
    const source = resolve(process.argv[3])
    modulePath = join(root, `opencode-credentials${extname(source) === '.ts' ? '.ts' : '.mjs'}`)
    await copyFile(source, modulePath)
    await symlink(join(runtime, 'node_modules'), join(root, 'node_modules'), 'dir')
  }
  const { default: OpenCodeCredentialProvider } = await import(pathToFileURL(modulePath).href)
  const key = route => credentialKey('llm-pi-ai', route)
  const deepseek = credentialRef('DEEPSEEK_API_KEY')
  const nativeRef = credentialRef('OFFLINE_NATIVE_KEY')
  const customKey = credentialKey('custom-adapter', 'route')
  const records = {
    [key('zai')]: { provider: 'zhipuai', type: 'api' },
    [key('openai-codex')]: { provider: 'openai', type: 'oauth' },
    [key('xai')]: { provider: 'xai', type: 'oauth' },
    [key('anthropic')]: { provider: 'anthropic', type: 'oauth' },
    [key('absent-route')]: { provider: 'absent-provider', type: 'api' },
    [customKey]: { provider: 'custom', type: 'api' },
  }
  const refs = { [deepseek]: 'deepseek', OFFLINE_ABSENT_KEY: 'absent-provider' }
  const grant = provider => ({
    type: 'oauth', access: `synthetic-${provider}-access`, refresh: `synthetic-${provider}-refresh`,
    expires: Date.now() + 86400000, accountId: `synthetic-${provider}-account`,
    extra: { preserved: [true, 7, null], tenant: 'offline' },
  })
  const auth = {
    zhipuai: { type: 'api', key: 'synthetic-zai-key' },
    deepseek: { type: 'api', key: 'synthetic-deepseek-key' },
    custom: { type: 'api', key: 'synthetic-custom-key' },
    openai: grant('openai'), xai: grant('xai'), anthropic: grant('anthropic'),
    // A matching provider name alone must not create an implicit binding.
    openrouter: { type: 'api', key: 'synthetic-unmapped-opencode-key' },
  }
  const authPath = join(root, 'auth.json')
  const localPath = join(root, 'credentials.yaml')
  const settingsPath = join(root, 'settings.json')
  const writeAuth = value => writeFile(authPath, JSON.stringify(value), { mode: 0o600 })
  await writeAuth(auth)
  await writeFile(localPath, JSON.stringify({
    version: 1,
    refs: { [deepseek]: 'synthetic-stale-native-ref' },
    records: Object.fromEntries(Object.keys(records).map(recordKey => [recordKey, { kind: 'api-key', key: `synthetic-stale-${recordKey}` }])),
  }), { mode: 0o600 })
  const ctx = new Context()
  contexts.push(ctx)
  // Never consult the invoking user's API keys or dotenv layers.
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([]))
  await ctx.plugin(OpenCodeCredentialProvider, { path: localPath, watch: false, authPath, records, refs })
  const credentials = ctx.credentials
  const snapshot = async () => ({
    local: await readFile(localPath, 'utf8'),
    auth: await readFile(authPath, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return undefined
      throw error
    }),
    localMode: (await stat(localPath)).mode & 0o777,
    authMode: await stat(authPath).then(value => value.mode & 0o777).catch(error => {
      if (error.code === 'ENOENT') return undefined
      throw error
    }),
  })
  const unchanged = async operation => {
    const before = await snapshot()
    await operation()
    assert.deepEqual(await snapshot(), before, 'Credential operations must not alter either store')
  }
  await unchanged(async () => {
    assert.deepEqual(await credentials.readRecord(key('zai')), { kind: 'api-key', key: auth.zhipuai.key })
    for (const route of ['openai-codex', 'xai', 'anthropic']) {
      assert.deepEqual(await credentials.readRecord(key(route)), {
        kind: 'grant', payload: auth[records[key(route)].provider],
      })
      assertDescription(await credentials.describeRecord(key(route)), { configured: true, kind: 'grant', expiresAt: auth[records[key(route)].provider].expires })
    }
    assert.deepEqual(await credentials.resolve(deepseek), { value: auth.deepseek.key, source: 'opencode' })
    assertDescription(await credentials.describe(deepseek), { configured: true, source: 'opencode' })
    assertDescription(await credentials.describeRecord(key('zai')), { configured: true, kind: 'api-key' })
    assertDescription(await credentials.describeRecord(key('absent-route')), { configured: false }, 'MISSING_CREDENTIAL')
    assertDescription(await credentials.describe(credentialRef('OFFLINE_ABSENT_KEY')), { configured: false }, 'MISSING_CREDENTIAL')
    assert.deepEqual(await credentials.readRecord(customKey), { kind: 'api-key', key: auth.custom.key })
    assertDescription(await credentials.describeRecord(customKey), { configured: true, kind: 'api-key' })
    assert.equal(await credentials.readRecord(key('route')), undefined)
    assert.equal(await credentials.readRecord(key('openai')), undefined)
    assert.equal(await credentials.readRecord(key('openrouter')), undefined)
  })
  passed('explicit API and DeepSeek ref mappings; OpenAI-to-Codex, xAI and Anthropic OAuth payloads preserved; descriptions read-only')

  async function refuseWrites() {
    let callbacks = 0
    await unchanged(async () => {
      for (const recordKey of Object.keys(records)) {
        await assert.rejects(credentials.modifyRecord(recordKey, async () => {
          callbacks++
          return { kind: 'grant', payload: grant('must-not-refresh') }
        }), owned)
        await assert.rejects(credentials.deleteRecord(recordKey), owned)
      }
      for (const ref of Object.keys(refs)) {
        await assert.rejects(credentials.set(credentialRef(ref), 'synthetic-replacement'), owned)
        await assert.rejects(credentials.unset(credentialRef(ref)), owned)
      }
    })
    assert.equal(callbacks, 0, 'Mapped modify must refuse before invoking the refresh callback')
  }
  await refuseWrites()
  passed('mapped modify/delete/set/unset refuse, including absent credentials, without callbacks or file changes')

  const authBeforeNative = await readFile(authPath, 'utf8')
  await credentials.set(nativeRef, 'synthetic-native-value')
  assert.deepEqual(await credentials.resolve(nativeRef), { value: 'synthetic-native-value', source: 'file' })
  assert.equal((await credentials.describe(nativeRef)).writable, true)
  const nativeRecord = { kind: 'api-key', key: 'synthetic-native-record' }
  await credentials.modifyRecord(key('openrouter'), async current => {
    assert.equal(current, undefined)
    return nativeRecord
  })
  assert.deepEqual(await credentials.readRecord(key('openrouter')), nativeRecord)
  assert.deepEqual(await credentials.describeRecord(key('openrouter')), { configured: true, kind: 'api-key', writable: true })
  const listed = await credentials.listRecords()
  assert.deepEqual(listed, [
    { key: key('openrouter'), kind: 'api-key' },
    ...Object.entries(records).filter(([, binding]) => auth[binding.provider]).map(([key, binding]) => ({ key, kind: binding.type === 'api' ? 'api-key' : 'grant' })),
  ])
  assert(!JSON.stringify(listed).includes('synthetic-'), 'List must contain identifiers and kinds only')
  await credentials.modifyRecord(key('openrouter'), async current => {
    assert.deepEqual(current, nativeRecord)
    return { kind: 'grant', payload: { native: true } }
  })
  assert.deepEqual(await credentials.readRecord(key('openrouter')), { kind: 'grant', payload: { native: true } })
  await credentials.deleteRecord(key('openrouter'))
  await credentials.unset(nativeRef)
  assert.equal(await credentials.readRecord(key('openrouter')), undefined)
  assert.equal(await credentials.resolve(nativeRef), undefined)
  assert.equal((await stat(localPath)).mode & 0o777, 0o600)
  assert.equal((await stat(authPath)).mode & 0o777, 0o600)
  assert.equal(await readFile(authPath, 'utf8'), authBeforeNative)
  passed('unmapped native refs and records remain writable; listing exposes no values; owner-only files preserved')

  const updated = structuredClone(auth)
  updated.deepseek.key = 'synthetic-updated-deepseek'
  updated.zhipuai.key = 'synthetic-updated-zai'
  updated.openai.access = 'synthetic-updated-access'
  await writeAuth(updated)
  await unchanged(async () => {
    assert.equal((await credentials.resolve(deepseek)).value, updated.deepseek.key)
    assert.equal((await credentials.readRecord(key('zai'))).key, updated.zhipuai.key)
    assert.deepEqual((await credentials.readRecord(key('openai-codex'))).payload, updated.openai)
  })
  for (const removeFile of [false, true]) {
    if (removeFile) await rm(authPath)
    else await writeAuth({})
    await unchanged(async () => {
      for (const recordKey of Object.keys(records)) {
        assert.equal(await credentials.readRecord(recordKey), undefined)
        assertDescription(await credentials.describeRecord(recordKey), { configured: false }, 'MISSING_CREDENTIAL')
      }
      assert.equal(await credentials.resolve(deepseek), undefined)
      assertDescription(await credentials.describe(deepseek), { configured: false }, 'MISSING_CREDENTIAL')
      assert.deepEqual(await credentials.listRecords(), [])
    })
    await refuseWrites()
  }
  passed('updates, removed entries and removed auth file re-read immediately; stale native records and refs never win')

  await credentials.modifyRecord(key('openrouter'), async () => nativeRecord)
  await credentials.set(nativeRef, 'synthetic-native-value')
  async function unavailableStore() {
    for (const read of [() => credentials.readRecord(key('zai')), () => credentials.resolve(deepseek)]) {
      await assert.rejects(read(), error => {
        assert.match(error.message, unsafe)
        assert.doesNotMatch(inspect(error, { depth: null }), /synthetic-|SYNTHETIC_SECRET_MUST_NOT_APPEAR/)
        assert.equal(error.cause, undefined)
        return true
      })
    }
    for (const recordKey of Object.keys(records)) {
      assertDescription(await credentials.describeRecord(recordKey), { configured: false }, 'STORE_UNAVAILABLE')
    }
    assertDescription(await credentials.describe(deepseek), { configured: false }, 'STORE_UNAVAILABLE')
    assert.deepEqual(await credentials.listRecords(), [{ key: key('openrouter'), kind: 'api-key' }])
    assert.deepEqual(await credentials.readRecord(key('openrouter')), nativeRecord)
    assert.deepEqual(await credentials.describeRecord(key('openrouter')), { configured: true, kind: 'api-key', writable: true })
    assert.deepEqual(await credentials.resolve(nativeRef), { value: 'synthetic-native-value', source: 'file' })
    assert.equal((await credentials.describe(nativeRef)).writable, true)
  }
  await writeAuth(auth)
  await chmod(authPath, 0o644)
  await unchanged(unavailableStore)
  await chmod(authPath, 0o600)
  for (const text of [`{"${marker}":`, 'null', '[]', '"not-an-object"']) {
    await writeFile(authPath, text)
    await unchanged(unavailableStore)
    await refuseWrites()
  }
  passed('unsafe/malformed stores fail closed on direct reads, describe safely, and preserve native listing and reads')

  for (const [provider, entry, code] of [
    ['zhipuai', grant('wrong-type'), 'AUTH_TYPE_CHANGED'],
    ['openai', { type: 'api', key: 'synthetic-wrong-type' }, 'AUTH_TYPE_CHANGED'],
    ['deepseek', grant('wrong-ref-type'), 'AUTH_TYPE_CHANGED'],
    ['zhipuai', { type: 'api', key: 'opencode-oauth-dummy-key' }, 'INVALID_CREDENTIAL'],
    ['deepseek', { type: 'api', key: 'opencode-oauth-dummy-key' }, 'INVALID_CREDENTIAL'],
    ['zhipuai', { type: 'api', key: '' }, 'INVALID_CREDENTIAL'],
    ['zhipuai', marker, 'INVALID_CREDENTIAL'],
    ['openai', { ...auth.openai, access: '' }, 'INVALID_CREDENTIAL'],
    ['openai', { ...auth.openai, refresh: marker.length }, 'INVALID_CREDENTIAL'],
    ['openai', { ...auth.openai, expires: marker }, 'INVALID_CREDENTIAL'],
  ]) {
    await writeAuth({ ...auth, [provider]: entry })
    await unchanged(async () => {
      const read = provider === 'deepseek' ? () => credentials.resolve(deepseek)
        : () => credentials.readRecord(key(provider === 'openai' ? 'openai-codex' : 'zai'))
      await assert.rejects(read(), error => {
        assert.equal(error.code, code)
        assert.doesNotMatch(inspect(error, { depth: null }), /synthetic-|SYNTHETIC_SECRET_MUST_NOT_APPEAR/)
        return true
      })
      const description = provider === 'deepseek' ? await credentials.describe(deepseek)
        : await credentials.describeRecord(key(provider === 'openai' ? 'openai-codex' : 'zai'))
      assertDescription(description, { configured: false }, code)
      const healthy = Object.entries(records).filter(([, binding]) => auth[binding.provider] && binding.provider !== provider)
      const listing = await credentials.listRecords()
      assert.deepEqual(listing, [
        { key: key('openrouter'), kind: 'api-key' },
        ...healthy.map(([key, binding]) => ({ key, kind: binding.type === 'api' ? 'api-key' : 'grant' })),
      ])
      assert.doesNotMatch(inspect(listing), /synthetic-|SYNTHETIC_SECRET_MUST_NOT_APPEAR/)
      for (const [recordKey, binding] of healthy) {
        const source = auth[binding.provider]
        assert.deepEqual(await credentials.readRecord(recordKey), binding.type === 'api'
          ? { kind: 'api-key', key: source.key } : { kind: 'grant', payload: source })
      }
      assert.deepEqual(await credentials.readRecord(key('openrouter')), nativeRecord)
      if (provider !== 'deepseek') assert.deepEqual(await credentials.resolve(deepseek), { value: auth.deepseek.key, source: 'opencode' })
    })
  }
  passed('wrong credential types, dummy/empty API keys and malformed OAuth fields reject without native fallback or writes')

  for (const expires of [1, Date.now() + 240000]) {
    const expiring = { ...auth.openai, expires }
    await writeAuth({ ...auth, openai: expiring })
    await unchanged(async () => {
      assertDescription(await credentials.describeRecord(key('openai-codex')), { configured: true, kind: 'grant', expiresAt: expires }, 'REFRESH_REQUIRED')
      assert.deepEqual(await credentials.readRecord(key('openai-codex')), { kind: 'grant', payload: expiring })
      assert((await credentials.listRecords()).some(entry => entry.key === key('openai-codex') && entry.kind === 'grant'))
    })
    await refuseWrites()
  }
  passed('expired and within-five-minute grants remain configured with expiry and refresh diagnostics, without refresh callbacks')

  await writeAuth(auth)
  await writeFile(settingsPath, JSON.stringify({ 'llm-pi-ai': { providers: {
    zai: {}, 'openai-codex': {}, xai: {}, anthropic: {}, deepseek: { apiKeyEnv: deepseek },
  } } }))
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path: settingsPath, watch: false })
  // Capture the actual registered adapter to exercise Pi auth without dispatching an inference request.
  let adapter
  const registerAdapter = ctx.llm.registerAdapter.bind(ctx.llm)
  ctx.llm.registerAdapter = (routes, value) => { adapter = value; return registerAdapter(routes, value) }
  await ctx.plugin(PiAi)
  assert(adapter, 'Pi must register the mapped settings routes')
  const { models, profiles } = adapter.current()
  await unchanged(async () => {
    assert.equal((await models.getAuth('zai')).auth.apiKey, auth.zhipuai.key)
    const apiKey = await adapter.config.resolveApiKey('deepseek', profiles.get('deepseek'))
    assert.equal(apiKey, auth.deepseek.key)
    assert.equal((await models.getAuth('deepseek', { apiKey })).auth.apiKey, auth.deepseek.key)
  })
  const expired = structuredClone(auth)
  for (const provider of ['openai', 'xai', 'anthropic']) expired[provider].expires = 1
  await writeAuth(expired)
  await unchanged(async () => {
    for (const route of ['openai-codex', 'xai', 'anthropic']) {
      const [model] = models.getModels(route)
      assert(model, `${route} must expose a model from mapped settings`)
      await assert.rejects(models.getAuth(model), error => {
        assert.match(inspect(error, { depth: null }), owned)
        return true
      })
    }
  })
  assert.equal(networkAttempts, 0, 'Neither token refresh nor inference may attempt network access')
  passed('installed Pi runtime resolves mapped API auth offline and refuses expired OAuth before network or store writes')
  console.log(`${count} OpenCode credential checks passed; synthetic stores only, ${networkAttempts} network attempts`)
} finally {
  try {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
  } finally {
    globalThis.fetch = originalFetch
    Socket.prototype.connect = originalConnect
    await rm(root, { recursive: true, force: true })
  }
}
