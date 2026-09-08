import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const upstream = process.argv[2]
for (const file of ['dsh-adapter/providerWizard.ts', 'dsh-adapter/credentialRefGuard.ts', 'i18n.ts', 'utils/paths.ts']) {
  const target = join('src/upstream', file)
  mkdirSync(join(target, '..'), { recursive: true })
  copyFileSync(join(upstream, 'src', file), target)
}

// Extract the upstream host method by syntax, not brittle line ranges. Keep the
// wizard and its settings/credential behavior together at the same pinned rev.
const source = ts.createSourceFile('channel.ts', readFileSync(join(upstream, 'src/dsh-adapter/channel.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
const methods = []
function visit(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(source) === 'providerSetup' && node.body) methods.push(node)
  ts.forEachChild(node, visit)
}
visit(source)
if (methods.length !== 1) throw new Error('Expected exactly one upstream providerSetup implementation')
writeFileSync('src/upstream/host.ts', `
import type { Context } from '@deepseek-ai/cordis'
import type { LlmConfigurableProvider, LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import type { ProviderSetupHost, OAuthSetupHost, ProfilePathOp } from './dsh-adapter/providerWizard.js'
export function createProviderHost(ctx: Context): ProviderSetupHost | undefined ${methods[0].body.getText(source)}
`)
