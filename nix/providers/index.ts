import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { TuiOverlaySession } from '@dsh-tui/dsh-tui'
import { credentialKeyId } from '@deepseek-ai/dsh-credentials'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { authorizeProvider } from './authorization.js'
import { createDialogs } from './dialog.js'
import { createProviderHost } from './upstream/host.js'
import { runProviderWizard } from './upstream/dsh-adapter/providerWizard.js'
import { setLang } from './upstream/i18n.js'

export const name = 'tui-providers'
export const inject = ['commands', 'settings', 'credentials', 'authorization', 'llm']

export function apply(ctx: Context): void {
  // The TUI appears after asynchronous session startup, possibly after the
  // loader's activation audit. Own the command under its optional lifetime.
  ctx.inject(['tui'], mountProviderCommand)
}

function mountProviderCommand(ctx: Context): void {
  setLang(process.env.DSH_TUI_LANG === 'zh' ? 'zh' : 'en')
  const lifetime = new AbortController()
  let active = false
  ctx.effect(() => () => { lifetime.abort() })
  ctx.commands.register({
    name: 'provider',
    recordInput: false,
    description: 'Sign in, manage providers, or configure a custom endpoint',
    async handler({ agent, rawInput, signal }): Promise<CommandResult> {
      if (agent !== ctx.tui.agent) return { kind: 'error', text: 'Provider setup is terminal-local.' }
      if (rawInput.trim()) return { kind: 'error', text: 'Use /provider without arguments. Enter secrets only in its masked prompts.' }
      if (active || agent.status !== 'idle') return { kind: 'error', text: 'Wait for the current operation before configuring providers.' }
      active = true
      const controller = new AbortController()
      const combined = AbortSignal.any([signal, lifetime.signal, controller.signal])
      const ui = createDialogs(ctx.tui, combined)
      const pick = async (question: string, options: readonly { label: string; description?: string }[], detail?: string) => {
        const answer = await ui.ask({ questions: [{ id: 'choice', question, options: [...options], ...detail === undefined ? {} : { detail }, ...{ hideCustomInput: true } }] })
        return answer.answers[0]?.selected[0]
      }
      try {
        const action = await pick('Provider setup', [
          { label: 'Sign in', description: 'API keys and supported browser/subscription logins' },
          { label: 'Configure endpoints', description: 'Upstream wizard: add, edit, or remove provider settings' },
          { label: 'Sign out', description: 'Remove a native sign-in credential and disable its user route' },
        ])
        if (action === 'Sign in' || action === 'Sign out') {
          const entries = ctx.authorization.list().filter(entry => entry.key.startsWith('llm-pi-ai/'))
          const records = await ctx.credentials.listRecords()
          const candidates = action === 'Sign out' ? entries.filter(entry => records.some(record => record.key === entry.key)) : entries
          if (candidates.length === 0) return { kind: 'success', text: 'No matching provider credentials.' }
          const provider = await pick(action === 'Sign in' ? 'Choose a provider' : 'Choose a provider to sign out', candidates.map(entry => ({
            label: credentialKeyId(entry.key), description: `${entry.label} | ${entry.methods.map(method => method.label).join(', ')}`,
          })))
          const entry = candidates.find(entry => credentialKeyId(entry.key) === provider)
          if (!entry || !provider) return { kind: 'success' }
          if (action === 'Sign out') {
            if (await pick('Remove stored sign-in and disable this provider?', [{ label: 'Cancel' }, { label: 'Sign out' }], 'Environment keys and composition-base settings are not removed.') !== 'Sign out') return { kind: 'success' }
            const section = ctx.settings.describe().find(section => section.ns === 'llm-pi-ai')
            const base = section?.base as { providers?: Record<string, unknown> } | undefined
            if (base?.providers?.[provider] !== undefined) return { kind: 'error', text: 'This provider is enabled by the composition base. Remove that configuration before signing out.' }
            await ctx.settings.mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', provider] }], section?.revision)
            await ctx.credentials.deleteRecord(entry.key)
            return { kind: 'success', text: 'Stored sign-in removed and provider disabled. API-key references were left untouched.' }
          }
          const label = await pick('Choose a sign-in method', entry.methods.map(method => ({ label: method.label })))
          const method = entry.methods.find(method => method.label === label)
          if (!method) return { kind: 'success' }
          if (await pick('Use this sign-in for the provider?', [{ label: 'Continue' }, { label: 'Cancel' }], 'This replaces its native credential and removes its user apiKeyEnv override. Other settings are preserved.') !== 'Continue') return { kind: 'success' }
          let waiting: TuiOverlaySession | undefined
          let prompting = false
          let url: string | undefined
          let code: string | undefined
          const open = () => {
            if (!url) return
            // Linux-only package; never invoke a shell or open a non-web URI.
            const child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true })
            child.on('error', () => {})
            child.unref()
          }
          const showWaiting = () => {
            if (!prompting && !combined.aborted && !waiting) waiting = ui.waiting(() => controller.abort(), open)
          }
          ui.status('Starting provider sign-in...')
          showWaiting()
          let outcome: 'authorized' | 'cancelled'
          try {
            outcome = await authorizeProvider(ctx, entry, method.id, {
              async ask(request, options) {
                prompting = true
                await waiting?.close()
                waiting = undefined
                try { return await ui.ask(request, options) }
                finally { prompting = false; showWaiting() }
              },
              notify(notice) {
                if (notice.code) code = notice.code
                if (notice.url && /^https?:\/\//i.test(notice.url) && notice.url !== url) {
                  url = notice.url
                  open()
                }
                ui.status([notice.message, url, code ? `Code: ${code}` : undefined].filter(Boolean).join('\n'))
                showWaiting()
              },
            }, combined)
          } finally { await waiting?.close(); ui.status('') }
          if (outcome === 'cancelled') return { kind: 'success', text: 'Provider sign-in cancelled.' }
          if (await pick('Provider ready. Choose a model now?', [{ label: 'Choose model' }, { label: 'Later' }]) === 'Choose model') {
            await ctx.commands.execute(agent, '/model', [], combined)
          }
          return { kind: 'success', text: 'Provider signed in and enabled. Use /model to select it.' }
        }

        const host = createProviderHost(ctx)
        if (!host) return { kind: 'error', text: 'Provider settings are unavailable.' }
        const listConfigured = host.listConfiguredProviders.bind(host)
        host.listConfiguredProviders = () => {
          const user = ctx.settings.describe().find(row => row.ns === 'llm-pi-ai')?.user as { providers?: Record<string, unknown> } | undefined
          return listConfigured().filter(row => Object.hasOwn(user?.providers ?? {}, row.route))
        }
        const keyless = new Set<string>()
        const writeKey = host.writeCredential.bind(host)
        host.writeCredential = async (ref, value) => {
          if (value !== '') await writeKey(ref, value)
          else if (await host.readCredential(ref) === undefined) keyless.add(ref)
        }
        const writeProfile = host.writeProfile.bind(host)
        host.writeProfile = async (route, profile) => {
          if (typeof profile.apiKeyEnv === 'string' && keyless.has(profile.apiKeyEnv)) {
            if (typeof profile.api === 'string') {
              // Pi's compatible client requires a key even for local servers.
              await writeKey(profile.apiKeyEnv, 'local')
              await writeProfile(route, profile)
            } else {
              const { apiKeyEnv: _ref, ...rest } = profile
              await writeProfile(route, rest)
            }
          } else await writeProfile(route, profile)
        }
        host.discoverModels = request => ctx.llm.discoverModels('llm-pi-ai', request, combined)
        // Provider/network errors may reflect secrets. Do not forward their
        // messages to the upstream wizard's notifications or terminal output.
        const safeHost = new Proxy(host, {
          get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver)
            if (typeof value !== 'function') return value
            return (...args: unknown[]) => {
              // Once confirmation starts a write, allow its rollback to finish
              // even if the overlay/command is cancelled during persistence.
              try {
                const result = value.apply(target, args)
                return result instanceof Promise ? result.catch(() => { throw new Error('Provider operation failed. Check settings and credentials.') }) : result
              } catch { throw new Error('Provider operation failed. Check settings and credentials.') }
            }
          },
        })
        const outcome = await runProviderWizard({
          host: safeHost,
          ask: ui.ask,
          notify: text => ui.status(text),
          pushLocal: (_title, lines) => ui.status(lines.join('\n')),
          working: () => agent.status !== 'idle',
          switchModel: async (provider, model) => (await ctx.commands.execute(agent, `/model ${provider}/${model}`, [], combined))?.result.kind === 'success',
        })
        return { kind: outcome === 'failed' ? 'error' : 'success', text: `Provider setup ${outcome}. Use /model to select an enabled provider.` }
      } catch (error) {
        return error instanceof UserQuestionError || combined.aborted
          ? { kind: 'success', text: 'Provider setup cancelled.' }
          : { kind: 'error', text: 'Provider setup failed. Check the endpoint, credential, and writable settings. Sensitive error details are hidden.' }
      } finally {
        controller.abort()
        active = false
      }
    },
  })
}
