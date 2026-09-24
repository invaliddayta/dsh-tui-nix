/**
 * Session-resume sub-controller for the interactive chat channel: the
 * `/resume` selector, one metadata-plus-title scan that tolerates a corrupt
 * neighbor, the pre-handoff preflight, and the terminal handoff itself.
 * @module @deepseek-ai/dsh-tui/chat/resume
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TUI } from '@earendil-works/pi-tui'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-title'
import type {
  SessionQueryEngine,
  SessionRecord,
} from '@deepseek-ai/dsh-session-query'
import type { HintEditor } from './helpers.ts'
import { formatCwd } from './helpers.ts'
import type { TuiOverlaySession } from '../extension/types.ts'
import type { TuiRuntime } from '../runtime.ts'
import {
  ResumePicker,
  summarizeResumeCandidate,
  type ResumeCandidate,
} from '../components/dialogs.ts'
import type { ChannelNotice, ChatChannelDeps } from './channel.ts'

/** Collaborators the resume controller needs from the chat channel. */
export interface ResumeControllerDeps extends ChatChannelDeps, ChannelNotice {
  readonly agent: Agent
  readonly runtime: TuiRuntime
  /**
   * The optional session-query service, re-read at each use. `sessionQuery` is
   * mounted by an independent plugin, and a flat config tree gives no ordering
   * guarantee between it and this front door, so a value captured once at
   * construction can be `undefined` even though the service arrives moments later.
   */
  readonly sessionQuery: (this: void) => SessionQueryEngine | undefined
  readonly ui: TUI
  readonly editor: HintEditor
  /** Current agent status, re-read at each resume precondition point. */
  agentStatus(): AgentStatus
}

/** Session-resume controller for one chat channel. */
export interface ResumeController {
  /** Open the searchable session selector, scoped to this workspace until the user widens it. */
  showResume(): void
}

/** One per-record title resolution: a title (absent for untitled) or an isolated failure. */
type TitleResolution = { title?: string; lastActivityAt?: number; failure?: unknown }

/** One durable title-cache row: the fold result for one exact artifact revision. */
interface CachedTitleRow {
  /** The persisted artifact revision the fold was observed against. */
  rev: string
  /** Folded title, absent when the observed log had none. */
  title?: string
  /** Last event time of the observed log, absent when the log was empty. */
  lastActivityAt?: number
}

/** On-disk title-cache document shape; `v` gates forward-incompatible rows. */
interface TitleCacheDocument {
  v: 1
  titles: Record<string, CachedTitleRow>
}

/** Bumped only when the row shape changes in a way old rows cannot satisfy. */
const TITLE_CACHE_VERSION = 1
/** Upper bound on cached rows; the newest-activity rows are kept when exceeded. */
const TITLE_CACHE_MAX_ENTRIES = 5000

/**
 * Resolve the title-cache file for this process. `DSH_TUI_RESUME_TITLE_CACHE`
 * overrides the location (`off` or empty disables the cache entirely); the
 * default lives under the harness home beside the session store it describes.
 */
const titleCachePath = (): string | undefined => {
  const override = process.env.DSH_TUI_RESUME_TITLE_CACHE
  if (override !== undefined) return override === '' || override === 'off' ? undefined : override
  const home = process.env.DSH_HOME
  const dshHome = home === undefined || home === '' ? join(homedir(), '.dsh') : home
  return join(dshHome, 'tui', 'resume-titles.json')
}

/**
 * Load the durable title cache. Every failure — absent, unreadable, torn, or
 * foreign-shaped — degrades to an empty cache: a cache row is a fold shortcut,
 * never an authority, so losing it only costs one cold scan.
 */
const loadTitleCache = async (): Promise<Map<string, CachedTitleRow>> => {
  const path = titleCachePath()
  if (path === undefined) return new Map()
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return new Map()
  }
  const rows = new Map<string, CachedTitleRow>()
  if (typeof parsed !== 'object' || parsed === null) return rows
  const document = parsed as Partial<TitleCacheDocument>
  if (document.v !== TITLE_CACHE_VERSION || typeof document.titles !== 'object' || document.titles === null) {
    return rows
  }
  for (const [id, row] of Object.entries(document.titles)) {
    if (typeof row !== 'object' || row === null) continue
    const { rev, title, lastActivityAt } = row as Partial<CachedTitleRow>
    if (typeof rev !== 'string') continue
    rows.set(id, {
      rev,
      ...typeof title === 'string' ? { title } : {},
      ...typeof lastActivityAt === 'number' ? { lastActivityAt } : {},
    })
  }
  return rows
}

/**
 * Persist the durable title cache (best effort): prune rows for sessions the
 * listing no longer observes, cap the row count, and publish by renaming a
 * fully written private temporary file, so readers see the old or the new
 * document, never a torn one. Titles are conversation content, so the file is
 * owner-only like the rest of the harness home.
 */
const saveTitleCache = async (
  rows: ReadonlyMap<string, CachedTitleRow>,
  observed: ReadonlySet<string>,
): Promise<void> => {
  const path = titleCachePath()
  if (path === undefined) return
  const kept = [...rows]
    .filter(([id]) => observed.has(id))
    .sort(([, a], [, b]) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
    .slice(0, TITLE_CACHE_MAX_ENTRIES)
  const titles = Object.fromEntries(kept)
  // Unique per write: overlapping scans in one process must not share a file.
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(temporary, `${JSON.stringify({ v: TITLE_CACHE_VERSION, titles } as TitleCacheDocument)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  } catch {
    // An unwritable home or a failed write only costs the next scan a cold
    // re-read; never publish a partial temporary.
    await rm(temporary, { force: true }).catch(() => {})
  }
}

/**
 * Build the session-resume controller for one chat channel.
 * @param deps - channel collaborators, terminal handles, and optional services.
 * @returns the controller wired to the `/resume` command.
 */
export function createResumeController(deps: ResumeControllerDeps): ResumeController {
  const {
    ctx, agent, runtime, resolved, palette, overlayManager,
    sessionQuery, ui, editor,
  } = deps
  let resumeOverlay: TuiOverlaySession | undefined
  let resumeInFlight = false
  let resumeScan = 0

  /** Label any session's own workspace the way the prompt labels the current one. */
  const workspaceLabel = (cwd: string | undefined): string =>
    runtime.formatCwd?.(cwd) ?? formatCwd(cwd)

  /** Summarize one record from metadata and its batch-folded title. */
  const summarize = (
    record: SessionRecord,
    title: string | undefined,
    lastActivityAt: number | undefined,
  ): ResumeCandidate => summarizeResumeCandidate(
    record,
    title,
    lastActivityAt,
    agent.session.id,
    agent.session.header.cwd,
    workspaceLabel,
  )

  /** The disabled fallback row for a session whose title read failed. */
  const unreadableCandidate = (
    record: SessionRecord,
    lastActivityAt: number | undefined,
    error: unknown,
  ): ResumeCandidate => ({
    record,
    title: 'Unreadable session',
    lastActivityAt: lastActivityAt ?? record.header.createdAt,
    currentWorkspace: record.header.cwd === agent.session.header.cwd,
    workspaceLabel: workspaceLabel(record.header.cwd),
    disabledReason: `session cannot be loaded: ${errorChain(error)}`,
  })

  /**
   * Resolve every row's title and activity time without reading whole logs a
   * second time. Persisted rows serve from the durable title cache when the
   * listed artifact revision still matches and surface immediately; live rows
   * and the remainder — first scans, changed artifacts, cache misses — go
   * through chunked `readTitleSnapshots` batches (live rows fold in memory),
   * each chunk refreshing the picker so rows surface progressively. The chunk
   * size only paces progress; log-read parallelism is session-query's own.
   */
  const resolveTitles = async (
    listQuery: SessionQueryEngine,
    records: readonly SessionRecord[],
    signal: AbortSignal,
    onProgress?: (resolutions: readonly (TitleResolution | undefined)[]) => void,
  ): Promise<TitleResolution[]> => {
    const resolutions = new Array<TitleResolution | undefined>(records.length)
    const cache = await loadTitleCache()
    const nextCache = new Map(cache)
    const cold: number[] = []
    for (const [index, record] of records.entries()) {
      if (ctx.sessions.get(record.header.id) !== undefined) {
        cold.push(index)
        continue
      }
      const row = record.revision === undefined ? undefined : cache.get(record.header.id)
      if (row !== undefined && row.rev === record.revision) {
        resolutions[index] = {
          ...row.title === undefined ? {} : { title: row.title },
          ...row.lastActivityAt === undefined ? {} : { lastActivityAt: row.lastActivityAt },
        }
        continue
      }
      cold.push(index)
    }
    // Cache hits are final: show them before the first cold chunk's log reads.
    if (cold.length > 0 && cold.length < records.length) onProgress?.(resolutions)
    const chunkSize = Math.max(1, resolved.resumeScanConcurrency * 4)
    let cacheDirty = false
    for (let start = 0; start < cold.length; start += chunkSize) {
      signal.throwIfAborted()
      const chunk = cold.slice(start, start + chunkSize)
      const results = await listQuery.readTitleSnapshots(
        chunk.map(index => (records[index] as SessionRecord).header.id),
        signal,
      )
      signal.throwIfAborted()
      for (const [offset, result] of results.entries()) {
        const index = chunk[offset]
        /* v8 ignore next -- readTitleSnapshots returns one result per unique requested id in input order */
        if (index === undefined) throw new Error(`resume scan misaligned at "${result.sessionId}"`)
        const record = records[index] as SessionRecord
        /* v8 ignore next -- readTitleSnapshots returns one result per unique requested id in input order */
        if (result.sessionId !== record.header.id) {
          throw new Error(`resume scan misaligned at "${result.sessionId}"`)
        }
        if (result.status === 'rejected') {
          resolutions[index] = { failure: result.reason }
          continue
        }
        const title = result.value.title?.title
        const lastActivityAt = result.value.lastActivityAt
        resolutions[index] = {
          ...title === undefined ? {} : { title },
          ...lastActivityAt === undefined ? {} : { lastActivityAt },
        }
        // Only a fold observed against the persisted artifact itself may seed
        // its revision row: a live attach mid-scan would cache a title the
        // durable log cannot yet reproduce.
        if (record.revision !== undefined && ctx.sessions.get(record.header.id) === undefined) {
          nextCache.set(record.header.id, {
            rev: record.revision,
            ...title === undefined ? {} : { title },
            ...lastActivityAt === undefined ? {} : { lastActivityAt },
          })
          cacheDirty = true
        }
      }
      onProgress?.(resolutions)
    }
    if (cacheDirty) {
      await saveTitleCache(
        nextCache,
        new Set(records.map(record => record.header.id as string)),
      )
    }
    return records.map((_record, index) => resolutions[index] ?? {})
  }

  /** The latest logged provider/model route, for the preflight availability check. */
  const resumeRoute = (events: readonly SessionEvent[]): { provider: string; model: string } | undefined => {
    const header = events.findLast(item => item.type === 'request/header')
    if (header?.type === 'request/header') {
      return { provider: header.data.header.config.provider, model: header.data.header.config.model }
    }
    const assistant = events.findLast(item => item.type === 'assistant/message')
    return assistant?.type === 'assistant/message'
      ? { provider: assistant.data.message.source.provider, model: assistant.data.message.source.model }
      : undefined
  }

  /**
   * Re-read every mutable precondition immediately before terminal handoff and
   * resolve the exact identity and workspace the host will re-exec into. This
   * is where the one chosen log is fully read, replay-validated, and checked
   * for a currently-available route — the listing never does any of that.
   */
  const preflightResume = async (sessionId: SessionId): Promise<{ id: SessionId; cwd: string }> => {
    const query = sessionQuery()
    /* v8 ignore start -- showResume alone calls this after proving the optional service exists */
    if (query === undefined) throw new Error('Resume is unavailable: session query is not mounted.')
    /* v8 ignore stop */
    const initialStatus = deps.agentStatus()
    if (initialStatus !== 'idle') throw new Error(`Resume requires an idle agent (status: ${initialStatus}).`)
    const record = (await query.listSessions()).find(candidate => candidate.header.id === sessionId)
    if (record === undefined) throw new Error(`Session "${sessionId}" is no longer available.`)
    const candidate = summarize(record, undefined, undefined)
    if (candidate.disabledReason !== undefined) throw new Error(candidate.disabledReason)
    let events: readonly SessionEvent[]
    try {
      events = (await query.readSession(record.header.id)).events
    } catch (error: unknown) {
      throw new Error(`session cannot be loaded: ${errorChain(error)}`)
    }
    const route = resumeRoute(events)
    if (route !== undefined && !ctx.llm.listProviders().some(provider => provider.id === route.provider)) {
      throw new Error(`session is complete, but route is currently unavailable (${route.provider}/${route.model})`)
    }
    const cwd = record.header.cwd
    /* v8 ignore next -- summarizeResumeCandidate disables a cwd-less record, so the check above already rejected it */
    if (cwd === undefined) throw new Error(`Session "${sessionId}" has no recorded workspace to resume in.`)
    const finalStatus = deps.agentStatus()
    if (finalStatus !== 'idle') throw new Error(`Resume requires an idle agent (status: ${finalStatus}).`)
    return { id: record.header.id, cwd }
  }

  const handoffResume = async (candidate: ResumeCandidate, overlay: TuiOverlaySession): Promise<void> => {
    if (resumeInFlight) return
    resumeInFlight = true
    let terminalReleased = false
    try {
      const checked = await preflightResume(candidate.record.header.id)
      const hostHandoff = runtime.handoffResume
      if (hostHandoff === undefined) {
        await overlay.close()
        resumeOverlay = undefined
        deps.appendNotice('Session is resumable, but this host cannot hand it off in place.', 'warning')
        return
      }
      /* v8 ignore next -- shutdown during preflight invalidates an awaited service read or reaches this guard */
      if (deps.isDisposed()) return
      await ctx.sessions.flush(agent.session)
      // Disposal can run while the flush promise is pending.
      if (deps.isDisposed()) return
      if (agent.status !== 'idle') throw new Error(`Resume requires an idle agent (status: ${agent.status}).`)
      await overlay.close()
      resumeOverlay = undefined
      await runtime.terminal.drainInput(100, 20)
      // Disposal can run while terminal draining is pending.
      if (deps.isDisposed()) return
      ui.stop()
      terminalReleased = true
      // The host re-execs into the session's own workspace: process cwd, not the
      // restored session header, is what the filesystem and shell tools resolve
      // against.
      await hostHandoff(checked.id, checked.cwd)
      throw new Error('resume host returned without replacing the process')
    } catch (error: unknown) {
      if (!deps.isDisposed()) {
        if (terminalReleased) {
          ui.start()
          ui.setFocus(editor)
          deps.appendNotice(`Resume handoff failed: ${errorChain(error)}`, 'error')
        } else {
          await overlay.close()
          resumeOverlay = undefined
          deps.appendNotice(`Resume failed: ${errorChain(error)}`, 'error')
        }
      }
    } finally {
      resumeInFlight = false
    }
  }

  return {
    showResume(): void {
      if (agent.status !== 'idle') {
        deps.appendNotice('Resume requires the current turn to finish or be cancelled first.', 'warning')
        return
      }
      const listQuery = sessionQuery()
      if (listQuery === undefined) {
        deps.appendNotice('Resume is not available: session query is not mounted.', 'warning')
        return
      }
      const scan = ++resumeScan
      void resumeOverlay?.close()
      // The picker opens before the scan settles so the terminal stops feeding
      // the editor immediately; a queued activation (the closing predecessor
      // still holds the slot) receives an already-scanned set through
      // `scanned` instead of a loading placeholder.
      let picker: ResumePicker | undefined
      let scanned: ResumeCandidate[] | undefined
      const session = overlayManager.open({
        create: (host) => {
          picker = new ResumePicker(
            scanned,
            resolved.maxResumeOptions,
            workspaceLabel(agent.session.header.cwd),
            () => host.viewport.rows,
            palette,
            (candidate) => { void handoffResume(candidate, session) },
            () => { void session.close() },
          )
          return picker
        },
        options: {
          width: '100%',
          maxHeight: '100%',
          anchor: 'top-left',
          margin: 0,
        },
      })
      resumeOverlay = session
      // Closing the picker — Escape, supersession, disposal — aborts the scan:
      // the borrowed-log pass over a large store must not outlive its overlay.
      const scanAbort = new AbortController()
      void session.closed.then(() => {
        scanAbort.abort()
        /* v8 ignore next -- overlay FIFO closes this session before a replacement can become the tracked resume overlay */
        if (resumeOverlay === session) resumeOverlay = undefined
      })
      deps.requestRender()
      /** Whether this scan's overlay, session generation, or TUI is gone. */
      const scanStale = (): boolean =>
        deps.isDisposed() || scan !== resumeScan || scanAbort.signal.aborted
      const scanCandidates = async (): Promise<void> => {
        // Every workspace in the store is listed; the picker owns the
        // current-workspace/all-workspaces scope split over the whole set.
        const records = await listQuery.listSessions(scanAbort.signal)
        if (scanStale()) return
        /** Rows for every resolution that has landed so far, newest activity first. */
        const rowsFor = (titles: readonly (TitleResolution | undefined)[]): ResumeCandidate[] => {
          const rows: ResumeCandidate[] = []
          for (const [index, record] of records.entries()) {
            const resolution = titles[index]
            if (resolution === undefined) continue
            rows.push('failure' in resolution
              ? unreadableCandidate(record, resolution.lastActivityAt, resolution.failure)
              : summarize(record, resolution.title, resolution.lastActivityAt))
          }
          rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt
            || a.record.header.id.localeCompare(b.record.header.id))
          return rows
        }
        const publish = (titles: readonly (TitleResolution | undefined)[]): void => {
          if (scanStale()) return
          scanned = rowsFor(titles)
          picker?.setCandidates(scanned)
          deps.requestRender()
        }
        const titles = await resolveTitles(listQuery, records, scanAbort.signal, publish)
        publish(titles)
      }
      // One catch covers listing, titles, and cache writes, so a scan failure
      // cannot strand the overlay on its loading placeholder; an aborted
      // scan's rejection stays silent because the user already dismissed the
      // picker.
      void scanCandidates().catch((error: unknown) => {
        if (scanStale()) return
        void session.close()
        deps.appendNotice(`Resume session scan failed: ${errorChain(error)}`, 'error')
      })
    },
  }
}
