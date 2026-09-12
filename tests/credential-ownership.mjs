// node tests/credential-ownership.mjs RUNTIME_ROOT
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

assert(process.argv[2], 'Expected runtime root containing node_modules')
const requireRuntime = createRequire(join(resolve(process.argv[2]), 'package.json'))
const load = name => import(pathToFileURL(requireRuntime.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { LocalCredentialProvider } = await load('@deepseek-ai/dsh-credentials-local')
const { credentialKey } = await load('@deepseek-ai/dsh-credentials')
const { AuthorizationService, AuthorizationError } = await load('@deepseek-ai/dsh-authorization')

const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('Network forbidden in credential ownership tests') }
const root = await mkdtemp(join(tmpdir(), 'credential-ownership-'))
const contexts = []
const key = credentialKey('offline-test', 'provider')
const record = { kind: 'api-key', key: 'synthetic-offline-key' }
const interaction = {
  prompt: async () => { throw new Error('Unexpected prompt') },
  notify: () => { throw new Error('Unexpected notice') },
}
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
async function boot({ metadata = {}, blocked = false, native = false } = {}) {
  const entered = deferred()
  const release = deferred()
  const state = { runs: 0, descriptions: 0, settlements: [], metadata }
  class InstrumentedCredentials extends LocalCredentialProvider {
    async describeRecord(subject) {
      state.descriptions++
      entered.resolve()
      if (blocked) await release.promise
      return { ...await super.describeRecord(subject), ...state.metadata }
    }
  }
  const ctx = new Context()
  contexts.push(ctx)
  const dir = await mkdtemp(join(root, 'case-'))
  await ctx.plugin(native ? LocalCredentialProvider : InstrumentedCredentials, {
    path: join(dir, 'credentials.yaml'), watch: false,
  })
  await ctx.plugin(AuthorizationService)
  ctx.on('authorization/settled', (subject, settlement) => {
    assert.equal(subject, key)
    assert.equal(ctx.authorization.describe(key).inFlight, false)
    state.settlements.push(settlement)
  })
  ctx.authorization.registerFlow({
    key, label: 'Offline flow', methods: [{ id: 'test', label: 'Test' }],
    async run() {
      state.runs++
      await ctx.credentials.modifyRecord(key, async () => record)
    },
  })
  return { ctx, state, entered, release, begin: signal => ctx.authorization.begin({ key, interaction, signal }) }
}
const hasCode = code => error => error instanceof AuthorizationError && error.code === code

try {
  await test('direct begin refuses present and missing read-only records before flow invocation', { timeout: 5000 }, async () => {
    for (const configured of [true, false]) {
      for (const owner of ['External credential manager', undefined]) {
        const metadata = {
          writable: false, owner, expiresAt: 1700000000000,
          diagnostic: { code: 'UNAVAILABLE', message: 'Sign in using the credential manager.' },
        }
        const fixture = await boot({ metadata })
        const { ctx, state, begin } = fixture
        if (configured) await ctx.credentials.modifyRecord(key, async () => record)
        const info = await ctx.credentials.describeRecord(key)
        assert.deepEqual(info, { configured, ...(configured ? { kind: 'api-key' } : {}), ...metadata })
        await assert.rejects(begin(), error => {
          assert(hasCode('CREDENTIAL_READ_ONLY')(error))
          assert.match(error.message, /read-only/)
          if (owner) assert(error.message.includes(owner))
          assert(!error.message.includes(record.key))
          assert(!error.message.includes(metadata.diagnostic.message))
          assert.equal(error.cause, undefined)
          return true
        })
        assert.equal(state.runs, 0)
        assert.equal(ctx.authorization.describe(key).inFlight, false)
        assert.deepEqual(state.settlements, ['failed'])
        assert.deepEqual(await ctx.credentials.readRecord(key), configured ? record : undefined)
        // Refusal must release the slot; metadata, not the owner label, governs writes.
        state.metadata = { owner, writable: true }
        assert.deepEqual(await begin(), { status: 'authorized' })
        assert.equal(state.runs, 1)
      }
    }
  })

  await test('native local writable authorization commits without ownership metadata', { timeout: 5000 }, async () => {
    const { ctx, state, begin } = await boot({ native: true })
    assert.deepEqual(await begin(), { status: 'authorized' })
    assert.equal(state.runs, 1)
    assert.deepEqual(await ctx.credentials.readRecord(key), record)
    assert.deepEqual(state.settlements, ['authorized'])
  })

  await test('cancellation during metadata lookup prevents flow and releases the slot', { timeout: 5000 }, async () => {
    for (const mode of ['signal', 'cancel']) {
      for (const writable of [true, false]) {
        const { ctx, state, entered, release, begin } = await boot({ blocked: true, metadata: { writable } })
        const controller = new AbortController()
        const pending = begin(controller.signal)
        try {
          await entered.promise
          assert.equal(ctx.authorization.describe(key).inFlight, true)
          if (mode === 'signal') controller.abort()
          else ctx.authorization.cancel(key)
        } finally {
          release.resolve()
        }
        assert.deepEqual(await pending, { status: 'cancelled' })
        assert.equal(state.runs, 0)
        assert.deepEqual(state.settlements, ['cancelled'])
        assert.equal(await ctx.credentials.readRecord(key), undefined)
        state.metadata = { writable: true }
        assert.deepEqual(await begin(), { status: 'authorized' })
      }
    }
  })

  await test('blocked descriptor retains per-key exclusion, including for an aborted second caller', { timeout: 5000 }, async () => {
    const { ctx, state, entered, release, begin } = await boot({ blocked: true })
    const first = begin()
    try {
      await entered.promise
      assert.equal(state.runs, 0)
      assert.equal(ctx.authorization.describe(key).inFlight, true)
      await assert.rejects(begin(), hasCode('ALREADY_IN_FLIGHT'))
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(begin(controller.signal), hasCode('ALREADY_IN_FLIGHT'))
      assert.equal(state.descriptions, 1)
      assert.equal(state.runs, 0)
    } finally {
      release.resolve()
    }
    assert.deepEqual(await first, { status: 'authorized' })
    assert.equal(state.runs, 1)
    assert.deepEqual(state.settlements, ['authorized'])
    assert.deepEqual(await begin(), { status: 'authorized' })
    assert.equal(state.runs, 2)
  })
} finally {
  for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
  globalThis.fetch = originalFetch
}
