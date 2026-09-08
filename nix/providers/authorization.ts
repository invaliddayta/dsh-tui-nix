import type { Context } from '@deepseek-ai/cordis'
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type { AuthorizationEntry, AuthorizationNotice } from '@deepseek-ai/dsh-authorization'
import { credentialKeyId } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionRequest, AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'

export async function authorizeProvider(
  ctx: Context,
  entry: AuthorizationEntry,
  method: string,
  ui: {
    ask: (request: AskUserQuestionRequest, options?: { redact?: boolean }) => Promise<AskUserQuestionAnswer>
    notify: (notice: AuthorizationNotice) => void
  },
  signal: AbortSignal,
): Promise<'authorized' | 'cancelled'> {
  if (!entry.key.startsWith('llm-pi-ai/')) throw new Error('Unsupported authorization provider.')
  const provider = credentialKeyId(entry.key)
  const settings = ctx.settings
  const snapshot = () => {
    const section = settings.describe().find(row => row.ns === 'llm-pi-ai')
    if (!section || !settings.writable) throw new Error('Provider settings are unavailable or read-only.')
    const base = section.base as { providers?: Record<string, { apiKeyEnv?: unknown }> } | undefined
    // Unsetting a user override reveals the base again; it cannot clear it.
    if (base?.providers?.[provider]?.apiKeyEnv !== undefined) {
      throw new Error('Remove the composition-base apiKeyEnv before authorizing this provider.')
    }
    return section
  }
  snapshot()
  if (signal.aborted) return 'cancelled'
  const attempt = new AbortController()
  try {
    const outcome = await ctx.authorization.begin({
      key: entry.key,
      method,
      signal,
      interaction: {
        notify: notice => ui.notify(notice),
        async prompt(prompt) {
          const combined = AbortSignal.any([signal, attempt.signal, ...prompt.signal ? [prompt.signal] : []])
          if (combined.aborted) throw new Error('Authorization prompt withdrawn.')
          try {
            const answer = await ui.ask({
              questions: [{
                id: 'authorization',
                header: 'Authorization',
                question: prompt.message,
                ...prompt.kind === 'select'
                  ? { options: prompt.options.map(({ label, description }) => ({ label, ...description === undefined ? {} : { description } })) }
                  : { ...prompt.placeholder === undefined ? {} : { detail: prompt.placeholder } },
              }],
              signal: combined,
            }, { redact: prompt.kind !== 'select' })
            if (combined.aborted) throw new Error('Authorization prompt withdrawn.')
            const row = answer.answers.find(item => item.id === 'authorization')
            if (prompt.kind === 'select') {
              const choices = prompt.options.filter(option => option.label === row?.selected[0])
              if (row?.selected.length !== 1 || choices.length !== 1) throw new Error('Invalid authorization selection.')
              return choices[0]!.id
            }
            if (row?.custom === undefined || row.custom.length === 0) throw new Error('Missing authorization answer.')
            return row.custom
          } catch (error) {
            if (error instanceof UserQuestionError && error.code === 'ASK_ABORTED' && !combined.aborted) {
              throw new AuthorizationDeclinedError()
            }
            throw new Error('Authorization prompt failed.')
          }
        },
      },
    })
    if (outcome.status === 'cancelled' || signal.aborted) return 'cancelled'
    const section = snapshot()
    const value = section.value as { providers?: Record<string, unknown> }
    if (signal.aborted) return 'cancelled'
    await settings.mutate('llm-pi-ai', [
      value.providers?.[provider] === undefined
        ? { op: 'set', path: ['providers', provider], value: {} }
        : { op: 'unset', path: ['providers', provider, 'apiKeyEnv'] },
    ], section.revision)
    return 'authorized'
  } catch {
    // Provider errors may contain tokens, callback URLs, or typed answers.
    throw new Error('Provider authorization failed.')
  } finally {
    attempt.abort()
  }
}
