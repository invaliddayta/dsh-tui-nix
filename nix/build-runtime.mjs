import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import ts from 'typescript'
import { build } from 'tsdown'

const packages = JSON.parse(readFileSync('nix/tui-runtime-workspaces.json', 'utf8'))
if (packages.length === 0) throw new Error('TUI runtime package set is empty')
// The generator is a build tool, not an additional runtime workspace.
const roots = [...packages.map(({ path }) => resolve(path)), resolve('packages/typert/generator')]
const config = ts.readConfigFile('tsconfig.host.json', ts.sys.readFile)
if (config.error !== undefined) {
  throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
}
if (!Array.isArray(config.config.references)) throw new Error('Host TypeScript project references are missing')
const projects = config.config.references
  .map(({ path }) => resolve(path))
  .filter(target => roots.some(root => target === root || target.startsWith(root + sep)))
if (projects.length === 0) throw new Error('TUI host TypeScript project set is empty')
execFileSync(process.execPath, [
  '--max-old-space-size=4096', './node_modules/typescript/bin/tsc', '-b', ...projects,
], { stdio: 'inherit' })

await build({
  env: { DSH_BUILD_FACE: 'host' },
  workspace: packages.map(({ path }) => path).filter(path => !path.startsWith('native/')),
})
