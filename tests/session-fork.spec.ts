import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { persistSessionFork, selectForkBoundary } from '../src/chat/session-fork.ts'

let ctx: Context
let root: string
let source: Session

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-session-fork-'))
  ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, packChunks: true, compression: 'zstd' })
  source = ctx.sessions.create(SessionId('source'), { meta: { cwd: root } })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

function turn(number: number) {
  source.append('turn/start', { turn: number })
  source.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `Question ${number}` }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  source.append('step/start', { turn: number, step: 1 })
  for (let index = 0; index < 12; index++) source.append('assistant/chunk', {
    turn: number, step: 1, chunk: { type: 'text-delta', index: 0, text: `delta-${index}` },
  })
  source.append('step/end', { turn: number, step: 1 })
  return source.append('turn/end', { turn: number, reason: { kind: 'completed' } }).seq
}

async function storeSource() {
  const writer = await ctx.sessionPersistence.create(source.header)
  try {
    await writer.append(source.snapshotEvents())
    await writer.flush()
  } finally {
    await writer.close()
  }
}

describe('fork boundary selection', () => {
  it('uses inclusive logical turn ends and preserves closed between-turn events by default', () => {
    const first = turn(1)
    const second = turn(2)
    // A no-turn bookkeeping event can follow a completed turn.
    const bookkeeping = source.append('request/context', { provider: 'test', model: 'test' })
    expect(selectForkBoundary(source.snapshotEvents())).toBe(bookkeeping.seq)
    expect(selectForkBoundary(source.snapshotEvents(), '--through-turn 1')).toBe(first)
    expect(selectForkBoundary(source.snapshotEvents(), ' --through-turn 2 ')).toBe(second)
    source.append('turn/start', { turn: 3 })
    source.append('step/start', { turn: 3, step: 1 })
    expect(selectForkBoundary(source.snapshotEvents())).toBe(bookkeeping.seq)
  })

  it('refuses empty and first-open-turn sessions clearly', () => {
    expect(() => selectForkBoundary(source.snapshotEvents())).toThrow('no completed turn')
    source.append('turn/start', { turn: 1 })
    expect(() => selectForkBoundary(source.snapshotEvents())).toThrow('no completed turn')
  })

  it.each(['--through-turn 0', '--through-turn -1', '--through-turn 1.5', '--through-turn NaN',
    '--through-turn 9007199254740992', '--through-turn 1 extra', '--at 1', '1'])('rejects invalid syntax %s', input => {
    turn(1)
    expect(() => selectForkBoundary(source.snapshotEvents(), input)).toThrow('Usage: /fork')
  })

  it('refuses an absent or open explicit turn', () => {
    turn(1)
    source.append('turn/start', { turn: 2 })
    expect(() => selectForkBoundary(source.snapshotEvents(), '--through-turn 2')).toThrow('not found')
    expect(() => selectForkBoundary(source.snapshotEvents(), '--through-turn 99')).toThrow('not found')
  })
})

it('persists an earlier packed-event prefix, leaves source bytes unchanged, and releases ownership for resume', async () => {
  const first = turn(1)
  turn(2)
  await storeSource()
  const original = source.snapshotEvents()
  const artifact = (await readdir(root, { recursive: true })).find(path => path.endsWith('.jsonl.zstd'))
  expect(artifact).toBeDefined()
  const path = join(root, artifact!)
  const before = await readFile(path)

  const child = await persistSessionFork(ctx, source, first)
  expect(child.id).toMatch(/^main-session-/)
  expect(child.header).toMatchObject({ parentSession: source.id, cwd: root, isSeeded: true })
  expect(child.inheritedEventCount).toBe(first + 1)
  expect(child.snapshotEvents().slice(0, first + 1)).toEqual(original.slice(0, first + 1))
  expect(child.snapshotEvents().at(-1)?.type).toBe('session/end-seed')
  expect(ctx.sessions.get(child.id)).toBeUndefined()
  expect(source.snapshotEvents()).toBe(original)
  expect(await readFile(path)).toEqual(before)

  // A different backend instance models the post-exec reader: no pending-memory shortcut.
  const fresh = new Context()
  try {
    await fresh.plugin(JsonlSessionPersistence, { root, packChunks: true, compression: 'zstd' })
    const listed = await fresh.sessionPersistence.list()
    expect(listed.some(record => record.header.id === child.id)).toBe(true)
    const reader = await fresh.sessionPersistence.open(child.id, 'read')
    try {
      expect(await reader.read()).toEqual(child.snapshotEvents())
      expect(reader.inheritedEventCount).toBe(first + 1)
    } finally {
      await reader.close()
    }
  } finally {
    await fresh.fiber.dispose()
  }

  // Same-instance write reopen would reject if the helper leaked its writer.
  const resumed = await ctx.sessionPersistence.open(child.id, 'write')
  try {
    const events = await resumed.read()
    const live = ctx.sessions.create(child.id, {
      seed: events, meta: resumed.header, inheritedEventCount: resumed.inheritedEventCount,
    })
    expect(live.snapshotEvents()).toEqual(events) // no duplicate end-seed on untouched pickup
    expect(live.deriveMessages().map(message => message.content)).toEqual([
      [{ type: 'text', text: 'Question 1' }],
    ])
    const nested = await persistSessionFork(ctx, live, selectForkBoundary(live.snapshotEvents()))
    expect(nested.header.parentSession).toBe(child.id)
    expect(nested.inheritedEventCount).toBe(live.seq)
    expect(nested.snapshotEvents()).toEqual(live.snapshotEvents())
    // New child events route to its reopened writer without touching the source.
    live.append('turn/start', { turn: 2 })
    live.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Child continuation' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    live.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await ctx.sessions.flush(live)
    expect(await resumed.read()).toEqual(live.snapshotEvents())
    expect(live.deriveMessages().map(message => message.content)).toEqual([
      [{ type: 'text', text: 'Question 1' }], [{ type: 'text', text: 'Child continuation' }],
    ])
  } finally {
    await resumed.close()
  }
  expect(await readFile(path)).toEqual(before)
})

it('uses the native open-turn guard and removes the failed temporary owner', async () => {
  const boundary = source.append('turn/start', { turn: 1 }).seq
  await expect(persistSessionFork(ctx, source, boundary)).rejects.toMatchObject({ code: 'OPEN_TURN' })
  expect(ctx.sessions.list()).toEqual([source])
  expect(await ctx.sessionPersistence.list()).toEqual([])
})

it('refuses missing persistence without creating a live child', async () => {
  const isolated = new Context()
  try {
    await isolated.plugin(SessionStore)
    const live = isolated.sessions.create(SessionId('isolated'))
    await expect(persistSessionFork(isolated, live, SessionSeq(0))).rejects.toThrow('persistence is not configured')
    expect(isolated.sessions.list()).toEqual([live])
  } finally {
    await isolated.fiber.dispose()
  }
})

it('cleans the live child when persistence creation fails', async () => {
  const boundary = turn(1)
  vi.spyOn(ctx.sessionPersistence, 'create').mockRejectedValue(new Error('create failed'))
  await expect(persistSessionFork(ctx, source, boundary)).rejects.toThrow('create failed')
  expect(ctx.sessions.list()).toEqual([source])
})

it.each(['append', 'flush'] as const)('closes the writer and rejects a failed %s before handoff', async operation => {
  const boundary = turn(1)
  const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
  let closeCalls = 0
  vi.spyOn(ctx.sessionPersistence, 'create').mockImplementation(async (...args) => {
    const writer = await create(...args)
    vi.spyOn(writer, operation).mockRejectedValue(new Error(`${operation} failed`))
    const close = writer.close.bind(writer)
    vi.spyOn(writer, 'close').mockImplementation(async () => {
      closeCalls++
      await close()
    })
    return writer
  })
  await expect(persistSessionFork(ctx, source, boundary)).rejects.toThrow(`${operation} failed`)
  expect(closeCalls).toBe(1)
  expect(ctx.sessions.list()).toEqual([source])
})

it('detaches before storage acquisition so observer writes cannot be double-appended', async () => {
  const boundary = turn(1)
  ctx.on('session/created', session => {
    if (session !== source) session.append('request/context', { provider: 'test', model: 'observer' })
  })
  const child = await persistSessionFork(ctx, source, boundary)
  const reader = await ctx.sessionPersistence.open(child.id, 'read')
  try {
    expect(await reader.read()).toEqual(child.snapshotEvents())
  } finally {
    await reader.close()
  }
})
