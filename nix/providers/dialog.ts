import type { TuiExtensionService, TuiOverlayHost } from '@dsh-tui/dsh-tui'
import { Input, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@dsh-tui/dsh-tui/provider-widgets'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionItem, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'

type Question = AskUserQuestionItem & { hideCustomInput?: boolean; defaultSelected?: readonly string[] }

/** Private configuration overlays: answers never pass through a chat/tool event. */
export function createDialogs(tui: TuiExtensionService, signal: AbortSignal) {
  let status = ''
  let current: TuiOverlayHost | undefined
  return {
    status(text: string) { status = text; current?.invalidate() },
    waiting(cancel: () => void, open: () => void) {
      let offset = 0
      const overlay = tui.openOverlay({
        signal,
        options: { width: '90%', maxHeight: '90%', margin: 1 },
        create(host) {
          current = host
          return {
            invalidate() {},
            handleInput(data: string) {
              if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) cancel()
              else if (data === 'o') open()
              else if (matchesKey(data, Key.pageDown)) offset += 3
              else if (matchesKey(data, Key.pageUp)) offset = Math.max(0, offset - 3)
              host.invalidate()
            },
            render(width: number) {
              const w = Math.max(1, width - 4)
              const budget = Math.max(1, Math.floor(host.viewport.rows * 0.9) - 5)
              const lines = wrapTextWithAnsi(host.display(status), w)
              offset = Math.min(offset, Math.max(0, lines.length - budget))
              return [host.theme.accent('Provider sign-in'), ...lines.slice(offset, offset + budget), 'O: open browser | PgUp/PgDn: scroll | Esc: cancel']
                .map(line => `  ${truncateToWidth(line, w, '')}  `)
            },
          }
        },
      })
      return overlay
    },
    async ask(request: AskUserQuestionRequest, options?: { redact?: boolean }): Promise<AskUserQuestionAnswer> {
      const answers: AskUserQuestionAnswer['answers'] = []
      const combined = AbortSignal.any([signal, ...request.signal ? [request.signal] : []])
      for (const item of request.questions) {
        if (combined.aborted) throw new UserQuestionError('Provider setup cancelled.', 'ASK_ABORTED')
        const question = item as Question
        const input = new Input()
        const search = new Input()
        let selected = new Set(question.defaultSelected ?? [])
        let cursor = Math.max(0, (question.options ?? []).findIndex(o => selected.has(o.label)))
        let custom = !question.options?.length
        let detailOffset = 0
        let detailPage = 1
        let detailLength = 0
        let answered = false
        const result = Promise.withResolvers<AskUserQuestionAnswer['answers'][number]>()
        const filtered = () => {
          const query = search.getValue().toLowerCase()
          return (question.options ?? [])
            .filter(o => `${o.label} ${o.description ?? ''}`.toLowerCase().includes(query))
            .sort((a, b) => Number(b.label.toLowerCase() === query) - Number(a.label.toLowerCase() === query))
        }
        const finish = () => {
          const picks = custom || question.multiSelect ? [...selected] : [filtered()[cursor]?.label].filter((s): s is string => s !== undefined)
          if (!custom && !question.multiSelect && picks.length === 0) return
          const value = input.getValue()
          answered = true
          result.resolve({ id: question.id, selected: picks, ...custom || value !== '' ? { custom: value } : {} })
          void overlay.close()
        }
        input.onSubmit = finish
        const overlay = tui.openOverlay({
          signal: combined,
          options: { width: '90%', maxHeight: '90%', margin: 1 },
          create(host) {
            current = host
            return {
              focused: true,
              invalidate() { input.invalidate(); search.invalidate() },
              handleInput(data: string) {
                if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
                  void overlay.close()
                } else if (matchesKey(data, Key.pageDown)) {
                  detailOffset = Math.min(Math.max(0, detailLength - detailPage), detailOffset + detailPage)
                } else if (matchesKey(data, Key.pageUp)) {
                  detailOffset = Math.max(0, detailOffset - detailPage)
                } else if (matchesKey(data, Key.tab) && question.options?.length && !question.hideCustomInput) {
                  custom = !custom
                } else if (custom) {
                  input.handleInput(data)
                } else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
                  const count = filtered().length
                  cursor = count === 0 ? 0 : (cursor + (matchesKey(data, Key.up) ? -1 : 1) + count) % count
                } else if (matchesKey(data, Key.space) && question.multiSelect) {
                  const label = filtered()[cursor]?.label
                  if (label !== undefined) {
                    if (selected.has(label)) selected.delete(label)
                    else selected.add(label)
                  }
                } else if (matchesKey(data, Key.enter)) {
                  finish()
                } else {
                  search.handleInput(data)
                  cursor = 0
                }
                host.invalidate()
              },
              render(width: number) {
                const w = Math.max(1, width - 4)
                const height = Math.max(4, Math.floor(host.viewport.rows * 0.9) - 2)
                const text = (value: string) => wrapTextWithAnsi(host.display(value), w)
                const title = text(question.question)
                const detail = [...text(question.detail ?? ''), ...text(status)]
                detailLength = detail.length
                detailPage = Math.max(1, Math.floor(height / 3))
                const rows = [host.theme.accent('/provider'), ...title.slice(0, 2), ...detail.slice(detailOffset, detailOffset + detailPage)]
                if (detail.length > detailPage) rows.push(host.theme.dim('PgUp/PgDn: scroll details'))
                if (custom) {
                  // Never call Input.render() for secret text, even on resize.
                  input.focused = !options?.redact
                  rows.push(...options?.redact
                    ? [host.theme.text(`> ${'*'.repeat(Math.min(input.getValue().length, Math.max(1, w - 3)))}`)]
                    : input.render(w))
                } else {
                  search.focused = true
                  rows.push(...search.render(w))
                  const available = Math.max(1, height - rows.length - 3)
                  const choices = filtered()
                  const start = Math.max(0, Math.min(cursor - Math.floor(available / 2), choices.length - available))
                  for (const [i, option] of choices.slice(start, start + available).entries()) {
                    const line = `${start + i === cursor ? '> ' : '  '}${question.multiSelect ? selected.has(option.label) ? '[x] ' : '[ ] ' : ''}${host.display(option.label)}`
                    rows.push(start + i === cursor ? host.theme.accent(line) : line)
                  }
                  const description = choices[cursor]?.description
                  if (description) rows.push(host.theme.dim(host.display(description)))
                  rows.push(host.theme.dim(`${choices.length ? cursor + 1 : 0}/${choices.length}${question.multiSelect ? ` | ${selected.size} selected` : ''}`))
                }
                rows.push(host.theme.dim(custom ? 'Enter: submit | Esc: cancel' : `Type: filter | Enter: select${question.multiSelect ? ' | Space: toggle' : ''}${!question.hideCustomInput ? ' | Tab: custom' : ''} | Esc: cancel`))
                return rows.slice(0, height).map(line => `  ${truncateToWidth(line, w, '')}  `)
              },
            }
          },
        })
        void overlay.closed.then(() => {
          current = undefined
          input.setValue('')
          search.setValue('')
          selected.clear()
          if (!answered) result.reject(new UserQuestionError('Provider setup cancelled.', 'ASK_ABORTED'))
        })
        answers.push(await result.promise)
        await overlay.closed
      }
      return { answers }
    },
  }
}
