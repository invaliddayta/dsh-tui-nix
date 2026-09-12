import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LocalCredentialProvider, type Config as LocalConfig } from '@deepseek-ai/dsh-credentials-local'
import { parseCredentialKey, credentialRef, type CredentialDiagnostic, type CredentialKey, type CredentialRecord, type CredentialRef } from '@deepseek-ai/dsh-credentials'

interface Binding { provider: string; type: 'api' | 'oauth' }
export interface Config extends LocalConfig {
  authPath?: string
  records?: Record<string, Binding>
  refs?: Record<string, string>
}

const owned = () => new Error('This credential is owned by OpenCode. Sign in or refresh it in OpenCode, then retry. DSH cannot modify it.')
class CredentialReadError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}
const unavailable = () => new CredentialReadError('STORE_UNAVAILABLE', 'Cannot read the OpenCode credential store safely. Check its JSON format and owner-only permissions.')
const invalid = () => new CredentialReadError('INVALID_CREDENTIAL', 'This OpenCode credential is invalid. Sign in again through OpenCode.')
function diagnostic(error: unknown): CredentialDiagnostic {
  const safe = error instanceof CredentialReadError ? error : unavailable()
  return { code: safe.code, message: safe.message }
}

/** Explicit, read-only bindings. Unbound native Harness credentials keep their usual behavior. */
export default class OpenCodeCredentialProvider extends LocalCredentialProvider {
  static override Config = z.intersect([
    LocalCredentialProvider.Config,
    z.object({
      authPath: z.string(),
      records: z.dict(z.object({ provider: z.string().required(), type: z.union(['api', 'oauth']).required() })).default({}),
      refs: z.dict(z.string()).default({}),
    }),
  ]) as z<Config>

  private readonly authPath: string
  private readonly bindings: Map<CredentialKey, Binding>
  private readonly refs: Record<string, string>

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this.authPath = config.authPath ?? join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'opencode/auth.json')
    this.bindings = new Map(Object.entries(config.records ?? {}).map(([key, binding]) => [parseCredentialKey(key), binding]))
    this.refs = Object.fromEntries(Object.entries(config.refs ?? {}).map(([ref, provider]) => [credentialRef(ref), provider]))
  }

  private async auth(): Promise<Record<string, unknown>> {
    // Inspect the same descriptor we read, and never include parser errors (which quote secrets).
    let file
    try {
      file = await open(this.authPath, 'r')
      const stat = await file.stat()
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw unavailable()
      const value = JSON.parse(await file.readFile('utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable()
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw unavailable()
    } finally { await file?.close() }
  }

  private record(auth: Record<string, unknown>, binding: Binding): CredentialRecord | undefined {
    if (!Object.hasOwn(auth, binding.provider)) return undefined
    const value = auth[binding.provider]
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
    const entry = value as Record<string, unknown>
    if (entry.type !== binding.type) throw new CredentialReadError('AUTH_TYPE_CHANGED', 'The OpenCode sign-in method changed. Update this credential binding to match it.')
    if (entry.type === 'api') {
      if (typeof entry.key !== 'string' || !entry.key || entry.key === 'opencode-oauth-dummy-key') throw invalid()
      return { kind: 'api-key', key: entry.key }
    }
    if (typeof entry.access !== 'string' || !entry.access || typeof entry.refresh !== 'string' || typeof entry.expires !== 'number' || !Number.isFinite(entry.expires)) throw invalid()
    return { kind: 'grant', payload: { ...entry } }
  }

  override async readRecord(key: CredentialKey) {
    const binding = this.bindings.get(key)
    return binding ? this.record(await this.auth(), binding) : super.readRecord(key)
  }

  override async describeRecord(key: CredentialKey) {
    if (!this.bindings.has(key)) return super.describeRecord(key)
    const source = { writable: false, owner: 'OpenCode' }
    try {
      const record = await this.readRecord(key)
      if (!record) return { ...source, configured: false, diagnostic: { code: 'MISSING_CREDENTIAL', message: 'Sign in through OpenCode to configure this credential.' } }
      const expiresAt = record.kind === 'grant' ? (record.payload as { expires: number }).expires : undefined
      return {
        ...source, configured: true, kind: record.kind,
        ...expiresAt === undefined ? {} : { expiresAt },
        ...expiresAt !== undefined && expiresAt <= Date.now() + 300000
          ? { diagnostic: { code: 'REFRESH_REQUIRED', message: 'Refresh this credential through OpenCode, then retry. DSH does not refresh external grants.' } } : {},
      }
    } catch (error) { return { ...source, configured: false, diagnostic: diagnostic(error) } }
  }

  override async listRecords() {
    const native = (await super.listRecords()).filter(entry => !this.bindings.has(entry.key))
    if (this.bindings.size === 0) return native
    let auth
    try { auth = await this.auth() }
    catch { return native }
    for (const [key, binding] of this.bindings) {
      // Enumeration is best-effort; describeRecord retains each failure's diagnostic.
      try {
        const record = this.record(auth, binding)
        if (record) native.push({ key, kind: record.kind })
      } catch { /* A broken external binding must not hide healthy native or external records. */ }
    }
    return native
  }

  override async modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
    // Refuse before invoking mutate: Pi refreshes (and rotates tokens) inside that callback.
    if (this.bindings.has(key)) throw owned()
    return super.modifyRecord(key, mutate)
  }

  override async deleteRecord(key: CredentialKey) {
    if (this.bindings.has(key)) throw owned()
    return super.deleteRecord(key)
  }

  override async resolve(ref: CredentialRef) {
    if (!Object.hasOwn(this.refs, ref)) return super.resolve(ref)
    const native = await super.resolve(ref)
    if (native?.source === 'env') return native
    const record = this.record(await this.auth(), { provider: this.refs[ref]!, type: 'api' })
    return record?.kind === 'api-key' && record.key ? { value: record.key, source: 'opencode' } : undefined
  }

  override async describe(ref: CredentialRef) {
    if (!Object.hasOwn(this.refs, ref)) return super.describe(ref)
    try {
      const resolved = await this.resolve(ref)
      return {
        configured: resolved !== undefined, writable: false,
        owner: resolved?.source === 'env' ? 'Process environment' : 'OpenCode',
        ...resolved ? { source: resolved.source } : { diagnostic: { code: 'MISSING_CREDENTIAL', message: 'Sign in through OpenCode to configure this credential.' } },
      }
    } catch (error) { return { configured: false, writable: false, owner: 'OpenCode', diagnostic: diagnostic(error) } }
  }

  override async set(ref: CredentialRef, value: string) {
    if (Object.hasOwn(this.refs, ref)) throw owned()
    return super.set(ref, value)
  }

  override async unset(ref: CredentialRef) {
    if (Object.hasOwn(this.refs, ref)) throw owned()
    return super.unset(ref)
  }
}
