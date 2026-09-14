/** Minimal TUI /fork surface; storage and boundary selection stay UI-independent. */
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ResumeControllerDeps } from './resume.ts'
import { persistSessionFork, selectForkBoundary } from './session-fork.ts'

type ForkDeps = Pick<ResumeControllerDeps,
  'ctx' | 'agent' | 'runtime' | 'ui' | 'editor' | 'appendNotice' | 'isDisposed' | 'requestRender'>

export function createForkController(deps: ForkDeps) {
  const { ctx, agent, runtime, ui, editor } = deps
  let inFlight = false
  return {
    get inFlight(): boolean { return inFlight },
    async fork(rawInput: string): Promise<void> {
      if (inFlight || deps.isDisposed()) return
      let child: Session | undefined
      let terminalReleased = false
      const wasDisabled = editor.disableSubmit
      inFlight = true
      editor.disableSubmit = true
      try {
        if (agent.status !== 'idle') throw new Error('Finish or cancel the current turn before using /fork.')
        const handoff = runtime.handoffResume
        if (handoff === undefined) throw new Error('This host cannot switch sessions in place; no fork was created.')
        const cwd = agent.session.header.cwd
        if (cwd === undefined) throw new Error('The session has no recorded workspace.')
        // Maintenance excludes new turns while taking and persisting the prefix.
        // Do not run the host inside maintenance: root teardown waits for it.
        await agent.runMaintenance(async signal => {
          const check = () => {
            signal.throwIfAborted()
            if (deps.isDisposed()) throw new Error('TUI disposed')
          }
          check()
          const events = agent.session.snapshotEvents()
          const boundary = selectForkBoundary(events, rawInput)
          const route = events.slice(0, boundary + 1).findLast(event => event.type === 'request/header')
          if (route?.type === 'request/header') {
            const { provider } = route.data.header.config
            if (!ctx.llm.listProviders().some(item => item.id === provider)) {
              throw new Error(`The selected history uses unavailable provider "${provider}".`)
            }
          }
          await ctx.sessions.flush(agent.session)
          check()
          child = await persistSessionFork(ctx, agent.session, boundary)
          check()
          await runtime.terminal.drainInput(100, 20)
          check()
        })
        if (deps.isDisposed()) return
        // A background wake queued during maintenance must not be interrupted.
        if (agent.status !== 'idle') throw new Error('The source agent started another turn; session switch cancelled.')
        if (child === undefined) throw new Error('Fork did not produce a session.')
        ui.stop()
        terminalReleased = true
        await handoff(child.id, cwd)
        throw new Error('Fork host returned without replacing the process.')
      } catch (error: unknown) {
        if (!deps.isDisposed()) {
          if (terminalReleased) {
            ui.start()
            ui.setFocus(editor)
          }
          const recovery = child === undefined ? '' : ` Fork saved as ${child.id}; use /resume to open it.`
          deps.appendNotice(`Fork failed: ${errorChain(error)}${recovery}`, 'error')
        }
      } finally {
        inFlight = false
        editor.disableSubmit = wasDisabled
        if (!deps.isDisposed()) deps.requestRender()
      }
    },
  }
}
