// node fork-fixture.mjs RUNTIME_ROOT seed|verify TEST_ROOT
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [runtime, mode, directory] = process.argv.slice(2)
assert(runtime && directory && ['seed', 'verify'].includes(mode), 'Expected RUNTIME_ROOT seed|verify TEST_ROOT')
const root = resolve(directory)
const requireRuntime = createRequire(join(resolve(runtime), 'package.json'))
const load = name => import(pathToFileURL(requireRuntime.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { Session, SessionId } = await load('@deepseek-ai/dsh-session')
const { createUserMessage, createAssistantMessage } = await load('@deepseek-ai/dsh-llm')
const { default: JsonlSessionPersistence } = await load('@deepseek-ai/dsh-session-persistence-jsonl')
const sourceId = SessionId('main-session-fork-smoke-source')
const emptyId = SessionId('main-session-fork-smoke-empty')
const storeRoot = join(root, 'dsh', 'sessions')
const workspace = join(root, 'workspace')
const manifestPath = join(root, 'fork-fixture.json')
const marker = (turn, role) => `DSH_FORK_TURN_${turn}_${role}`
const ctx = new Context()

try {
  if (mode === 'seed') {
    assert(!existsSync(manifestPath), 'Refusing to overwrite an existing fixture')
    await mkdir(workspace, { recursive: true })
    await mkdir(join(root, 'home'), { recursive: true })
    await mkdir(join(root, 'dsh'), { recursive: true })
    // Every launched Node process, including the post-exec child, loads this guard.
    await writeFile(join(root, 'no-network.mjs'), `
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
const deny = () => { appendFileSync(${JSON.stringify(join(root, 'network-attempted'))}, 'network attempted\\n'); throw new Error('Network forbidden in fork smoke'); };
globalThis.fetch = deny;
http.request = http.get = https.request = https.get = tls.connect = deny;
net.Socket.prototype.connect = deny;
syncBuiltinESMExports();
`)
  }
  await ctx.plugin(JsonlSessionPersistence, { root: storeRoot, compression: 'zstd', packChunks: true })
  if (mode === 'seed') {
    const source = Session.create(sourceId, undefined, {
      version: 0, id: sourceId, cwd: workspace, createdAt: Date.now(), isSeeded: false,
    })
    let firstBoundary
    for (let turn = 1; turn <= 2; turn++) {
      source.append('turn/start', { turn })
      source.append('user/message', createUserMessage({
        content: [{ type: 'text', text: marker(turn, 'USER') }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      source.append('step/start', { turn, step: 1 })
      source.append('assistant/message', {
        turn, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: marker(turn, 'ASSISTANT') }],
          source: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
        }),
      }, { surfaceOp: 'append' })
      source.append('step/end', { turn, step: 1 })
      const end = source.append('turn/end', { turn, reason: { kind: 'completed' } })
      firstBoundary ??= end.seq
    }
    for (const session of [source, Session.create(emptyId, undefined, {
      version: 0, id: emptyId, cwd: workspace, createdAt: Date.now(), isSeeded: false,
    })]) {
      const writer = await ctx.sessionPersistence.create(session.header)
      try {
        await writer.append(session.snapshotEvents())
        await writer.flush()
      } finally {
        await writer.close()
      }
    }
    await writeFile(manifestPath, JSON.stringify({ sourceId, emptyId, firstBoundary, events: source.snapshotEvents() }))
    console.log('Fork smoke fixtures seeded')
  } else {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const read = async id => {
      const handle = await ctx.sessionPersistence.open(id, 'read')
      try {
        return { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events: await handle.read() }
      } finally {
        await handle.close()
      }
    }
    const source = await read(sourceId)
    assert.deepEqual(source.events.slice(0, manifest.events.length), manifest.events, 'Source conversation changed')
    assert(!source.events.some(event => event.type === 'command/run' && event.data.name === 'fork'), 'Fork appended a command/run to its source')
    const records = await ctx.sessionPersistence.list()
    const children = records.filter(record => record.header.parentSession === sourceId)
    assert.equal(children.length, 2, 'Expected explicit earlier-turn fork and default latest fork')
    assert(!records.some(record => record.header.parentSession === emptyId), 'Empty /fork created a child')
    const cuts = []
    for (const record of children) {
      const child = await read(record.header.id)
      assert.equal(child.header.isSeeded, true)
      assert.equal(child.header.cwd, workspace)
      assert.deepEqual(child.events.slice(0, child.inheritedEventCount), source.events.slice(0, child.inheritedEventCount), 'Child is not an exact logical source prefix')
      const userMessages = child.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
      const turns = userMessages.map(event => event.data.content[0].text)
      if (child.inheritedEventCount === manifest.firstBoundary + 1) {
        assert.deepEqual(turns, [marker(1, 'USER')])
        assert(!JSON.stringify(child.events).includes(marker(2, 'ASSISTANT')), 'Earlier fork contains turn 2')
        cuts.push('earlier')
      } else {
        assert.deepEqual(turns, [marker(1, 'USER'), marker(2, 'USER')])
        cuts.push('latest')
      }
      assert(child.events.some(event => event.type === 'session/end-seed'), 'Child was not restored as a seed')
      assert(!child.events.some(event => event.type === 'command/run' && event.data.name === 'fork'), 'Child inherited a fork command')
    }
    assert.deepEqual(cuts.sort(), ['earlier', 'latest'])
    assert(!existsSync(join(root, 'network-attempted')), 'A launched process attempted network access')
    console.log('PASS: packaged fork handoff, exact earlier/latest prefixes, lineage, empty refusal, unchanged source conversation, no network')
  }
} finally {
  await ctx.fiber.dispose()
}
