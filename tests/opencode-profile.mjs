// node tests/opencode-profile.mjs RUNTIME_ROOT README_PATH
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

assert(process.argv[2] && process.argv[3], 'Expected RUNTIME_ROOT and README_PATH')
const runtime = resolve(process.argv[2])
const readme = await readFile(resolve(process.argv[3]), 'utf8')
const requireRuntime = createRequire(join(runtime, 'package.json'))
const load = name => import(pathToFileURL(requireRuntime.resolve(name)).href)
const root = await mkdtemp(join(tmpdir(), 'opencode-profile-'))
const originalEnv = process.env
const originalFetch = globalThis.fetch
const originalConnect = Socket.prototype.connect
let ctx, restoreRegistration
let networkAttempts = 0
const requests = []
// Imports and boot must not discover the invoking user's environment or stores.
process.env = { HOME: root, DSH_HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root }
Socket.prototype.connect = function () {
  networkAttempts++
  throw new Error('Network forbidden in OpenCode profile tests')
}
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init)
  requests.push({ url: request.url, method: request.method, headers: request.headers, body: await request.json() })
  // A non-retryable HTTP error proves dispatch without emulating either streaming protocol.
  return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'SYNTHETIC_HTTP_BOUNDARY' } }), {
    status: 400, headers: { 'content-type': 'application/json' },
  })
}

try {
  const { boot, composeEntries, initProfile, loadProfile, loadOverlayPatches, renderConfigDump } = await load('@deepseek-ai/dsh-app-boot')
  const { createLaunchEnvironmentSnapshot } = await load('@deepseek-ai/dsh-launch-environment')
  const { credentialKey, parseCredentialKey, credentialRef } = await load('@deepseek-ai/dsh-credentials')
  const { default: LlmRuntime } = await load('@deepseek-ai/dsh-llm')
  const yaml = await load('js-yaml')
  const bridgeName = 'dsh-credentials-opencode'
  const section = readme.split(/^### OpenCode-Owned Credentials\s*$/m)[1]?.split(/^#{1,3} /m)[0]
  const example = section?.match(/```yaml\s*\n([\s\S]*?)\n```/)?.[1]
  assert(example, 'README must contain the OpenCode-Owned Credentials YAML example')
  const profileDir = join(root, 'profiles', 'opencode-test')
  initProfile(profileDir, ['@deepseek-ai/dsh-base', '@dsh-tui/dsh-tui'], 'startup')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  await writeFile(patchPath, example)
  const profile = loadProfile('opencode-test', 'opencode-test', join(runtime, 'package.json'), root)
  const configPath = join(profileDir, 'cordis.yml')
  await writeFile(configPath, '[]\n')
  const bundleLayers = profile.layers.map(layer => ({ label: layer.packageName, patches: layer.patches }))
  const bundleWarnings = []
  const bundled = composeEntries(bundleLayers.map(layer => layer.patches), warning => bundleWarnings.push(warning))
  assert.deepEqual(bundleWarnings, [], 'Packaged bundles must compose without skipped patches')
  const flatten = entries => entries.flatMap(entry => [entry, ...(entry.group && Array.isArray(entry.config) ? flatten(entry.config) : [])])
  const keep = new Set(['credentials', 'settings', 'llm', 'llm-pi-ai'])
  const isolation = flatten(bundled).filter(entry => !keep.has(entry.id)).map(entry => {
    assert(entry.id, 'Every isolated packaged entry must have a patchable id')
    return { id: entry.id, disabled: true }
  })
  const authPath = join(root, 'auth.json')
  const localPath = join(root, 'credentials.yaml')
  const settingsPath = join(root, 'settings.yaml')
  isolation.push(
    { id: 'credentials', config: { path: localPath, watch: false } },
    { id: 'settings', config: { path: settingsPath, watch: false } },
  )
  const layersBeforeDocs = [...bundleLayers, { label: 'synthetic isolation', patches: isolation }]
  function documentedComposition(patches) {
    const warnings = []
    const dump = renderConfigDump('opencode-test', configPath, [
      ...layersBeforeDocs, { label: 'README OpenCode example', patches },
    ], warning => warnings.push(warning))
    return { entries: composeEntries([...layersBeforeDocs.map(layer => layer.patches), patches]), warnings, dump }
  }
  function assertDocumentedProfile(composition) {
    assert.deepEqual(composition.warnings, [], 'README patch must not be skipped by real composition')
    const entries = flatten(composition.entries)
    assert.equal(entries.find(entry => entry.id === 'credentials')?.disabled, true, 'Original credentials entry must be disabled')
    const bridges = entries.filter(entry => entry.name === bridgeName && !entry.disabled)
    assert.equal(bridges.length, 1, 'Exactly one OpenCode bridge must be enabled')
    assert.equal(bridges[0].id, 'opencode-credentials')
    assert.match(composition.dump, /opencode-credentials/)
    return bridges[0]
  }
  // Substitute the old example only in memory; exercise the same assertion as the real docs.
  const documentedBridge = profile.patches.flatMap(patch => patch.insert ?? []).find(entry => entry.name === bridgeName)
  const broken = documentedComposition([{ id: 'credentials', name: bridgeName, config: documentedBridge?.config ?? {} }])
  assert.match(broken.warnings.join('\n'), /name mismatch.*credentials.*skipping/)
  assert.throws(() => assertDocumentedProfile(broken), /README patch must not be skipped/)
  console.log('PASS: old name-as-replacement example fails the real composition regression')

  const bridge = assertDocumentedProfile(documentedComposition(profile.patches))
  const { records, refs } = bridge.config
  assert.deepEqual(records[credentialKey('llm-pi-ai', 'qwen-token-plan')], { provider: 'alibaba-token-plan', type: 'api' })
  assert.deepEqual(records[credentialKey('llm-pi-ai', 'kimi-coding')], { provider: 'kimi-for-coding', type: 'api' })
  const piRoute = recordKey => {
    assert.match(parseCredentialKey(recordKey), /^llm-pi-ai\//, 'README bindings must target the Pi adapter')
    return recordKey.slice('llm-pi-ai/'.length)
  }
  assert.equal(refs.DEEPSEEK_API_KEY, 'deepseek')
  const auth = {}
  for (const { provider, type } of Object.values(records)) {
    const entry = type === 'api' ? { type: 'api', key: `synthetic-${provider}-key` } : {
      type: 'oauth', access: `synthetic-${provider}-access`, refresh: `synthetic-${provider}-refresh`,
      expires: Date.now() + 86400000, accountId: `synthetic-${provider}-account`,
    }
    if (auth[provider]) assert.deepEqual(auth[provider], entry)
    auth[provider] = entry
  }
  for (const provider of Object.values(refs)) {
    auth[provider] ??= { type: 'api', key: `synthetic-${provider}-key` }
    assert.equal(auth[provider].type, 'api')
  }
  await writeFile(authPath, JSON.stringify(auth), { mode: 0o600 })
  await writeFile(localPath, JSON.stringify({ version: 1, refs: {}, records: {} }), { mode: 0o600 })
  await writeFile(settingsPath, yaml.dump({ 'llm-pi-ai': { providers: Object.fromEntries(Object.keys(records).map(recordKey => [piRoute(recordKey), {}])) } }))
  const stores = [authPath, localPath, settingsPath]
  const before = await Promise.all(stores.map(path => readFile(path, 'utf8')))
  const sandboxPatch = { id: bridge.id, config: { ...bridge.config, authPath, path: localPath, watch: false } }
  // Observe the real adapter registration, leaving its implementation and dispatch untouched.
  let adapter
  const registerAdapter = LlmRuntime.prototype.registerAdapter
  LlmRuntime.prototype.registerAdapter = function (routes, value) {
    assert.equal(adapter, undefined, 'Only the packaged Pi adapter should register')
    adapter = value
    return registerAdapter.call(this, routes, value)
  }
  restoreRegistration = () => { LlmRuntime.prototype.registerAdapter = registerAdapter }
  ctx = await boot('opencode-test', configPath, [
    ...layersBeforeDocs.flatMap(layer => layer.patches), ...loadOverlayPatches('opencode-test', patchPath), sandboxPatch,
  ], context => { context.provide('launchEnvironment', createLaunchEnvironmentSnapshot([])) }, pathToFileURL(join(runtime, 'package.json')).href)
  const entries = [...ctx.loader.entries()]
  assert.equal(entries.find(entry => entry.options.id === 'credentials')?.disabled, true)
  const activeBridge = entries.find(entry => entry.options.id === bridge.id)
  assert.equal(activeBridge?.fiber?.state, 2, 'Bridge must activate through boot, not direct ctx.plugin')
  assert.equal(activeBridge.options.name, bridgeName)
  assert(adapter, 'Boot must register the real Pi adapter from settings')
  const { models } = adapter.current()
  for (const [recordKey, binding] of Object.entries(records)) {
    const stored = await ctx.credentials.readRecord(parseCredentialKey(recordKey))
    const source = auth[binding.provider]
    assert.deepEqual(stored, binding.type === 'api' ? { kind: 'api-key', key: source.key } : { kind: 'grant', payload: source })
    assert.deepEqual(await ctx.credentials.describeRecord(parseCredentialKey(recordKey)), {
      configured: true, writable: false, owner: 'OpenCode', kind: stored.kind,
      ...(binding.type === 'oauth' ? { expiresAt: source.expires } : {}),
    })
    const route = piRoute(recordKey)
    const [model] = models.getModels(route)
    assert(model, `${route} must expose a model through documented settings`)
    const applied = await models.applyAuth(model)
    assert.equal(applied.requestOptions.apiKey, binding.type === 'api' ? source.key : source.access, `${route} must apply OpenCode auth`)
  }
  for (const [ref, provider] of Object.entries(refs)) {
    assert.deepEqual(await ctx.credentials.resolve(credentialRef(ref)), { value: auth[provider].key, source: 'opencode' })
    assert.deepEqual(await ctx.credentials.describe(credentialRef(ref)), { configured: true, writable: false, owner: 'OpenCode', source: 'opencode' })
  }
  assert.equal(requests.length, 0, 'Boot and authentication must not make HTTP requests')
  console.log('PASS: README composes without warnings, disables native credentials and boots the bridge; all documented bindings apply auth')

  for (const [route, id, endpoint, header, prefix] of [
    ['qwen-token-plan', 'deepseek-v4-flash-0731', 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions', 'authorization', 'Bearer '],
    ['kimi-coding', 'k3', 'https://api.kimi.com/coding/v1/messages?beta=true', 'x-api-key', ''],
  ]) {
    const model = models.getModels(route).find(model => model.id === id)
    assert(model, `Installed catalog must contain ${route}/${id}`)
    const count = requests.length
    const result = await models.streamSimple(model, { messages: [{ role: 'user', content: 'Offline profile regression', timestamp: Date.now() }] }, {
      maxTokens: 8, signal: AbortSignal.timeout(10000),
    }).result()
    assert.doesNotMatch(result.errorMessage ?? '', /Provider is not configured/)
    assert.equal(requests.length, count + 1, `${route} must dispatch exactly one mocked HTTP request`)
    const request = requests[count]
    assert.equal(request.url, endpoint)
    assert.equal(request.method, 'POST')
    assert.equal(request.body.model, id)
    assert.equal(request.headers.get(header), prefix + auth[records[credentialKey('llm-pi-ai', route)].provider].key)
    assert.equal(result.stopReason, 'error')
    assert.match(result.errorMessage, /SYNTHETIC_HTTP_BOUNDARY/)
    console.log(`PASS: ${route}/${id} dispatches its synthetic key to ${endpoint}`)
  }
  assert.deepEqual(await Promise.all(stores.map(path => readFile(path, 'utf8'))), before, 'Boot and requests must not change synthetic stores')
  assert.equal(networkAttempts, 0)
  console.log(`OpenCode profile regression passed; ${requests.length} mocked HTTP requests, zero socket attempts; synthetic stores only`)
} finally {
  try {
    await ctx?.fiber.dispose()
  } finally {
    restoreRegistration?.()
    globalThis.fetch = originalFetch
    Socket.prototype.connect = originalConnect
    process.env = originalEnv
    await rm(root, { recursive: true, force: true })
  }
}
