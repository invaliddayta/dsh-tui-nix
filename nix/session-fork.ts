import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'

/** Select an inclusive logical event seq, never a message index or storage row. */
export function selectForkBoundary(events: readonly SessionEvent[], rawInput = ''): SessionSeq {
  const input = rawInput.trim()
  if (input !== '') {
    const match = /^--through-turn\s+([1-9]\d*)$/.exec(input)
    const turn = match === null ? NaN : Number(match[1])
    if (!Number.isSafeInteger(turn)) throw new Error('Usage: /fork [--through-turn N] (N must be a positive safe integer).')
    const end = events.findLast(event => event.type === 'turn/end' && event.data.turn === turn)
    if (end === undefined) throw new Error(`Cannot fork: completed turn ${turn} was not found.`)
    return end.seq
  }

  let open = false
  let completed = false
  let boundary: SessionSeq | undefined
  for (const event of events) {
    if (event.type === 'turn/start') open = true
    if (event.type === 'turn/end') {
      open = false
      completed = true
    }
    if (!open && completed) boundary = event.seq
  }
  if (boundary === undefined) throw new Error('Cannot fork: this session has no completed turn yet.')
  return boundary
}

/** Persist a native fork and release its live identity and writer before handoff. */
export async function persistSessionFork(ctx: Context, source: Session, boundary: SessionSeq): Promise<Session> {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) throw new Error('Cannot fork: session persistence is not configured.')

  let child: Session | undefined
  const owner = ctx.plugin({
    name: 'tui-session-fork',
    inject: ['sessions'],
    apply(childCtx: Context) {
      child = childCtx.sessions.fork(source, boundary, SessionId(`main-session-${randomUUID()}`))
    },
  })
  try {
    await owner
  } finally {
    // Detach before acquiring a writer: constructor seeds never publish, and
    // no live event may be both routed by the backend and explicitly appended.
    await owner.dispose()
  }
  if (child === undefined) throw new Error('Cannot fork: session service is unavailable.')
  const events = child.snapshotEvents()
  const writer = await persistence.create(child.header, { inheritedEventCount: child.inheritedEventCount })
  try {
    await writer.append(events)
    await writer.flush()
  } finally {
    await writer.close()
  }
  return child
}
