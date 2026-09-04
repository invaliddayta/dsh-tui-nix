import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, resolve } from 'node:path'

const ROOT = process.cwd()
const CLI_NAME = '@deepseek-ai/dsh'
const CLI_PATH = 'apps/cli'
const BASE_NAME = '@deepseek-ai/dsh-base'
const OUTPUT_PATH = 'nix/tui-runtime-workspaces.json'
const FORBIDDEN_PACKAGES = new Set([
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-web-frontend',
  '@deepseek-ai/dsh-host-frontend-static',
  '@deepseek-ai/dsh-host-webserver',
])
const OMITTED_BASE_ROWS = [
  { id: 'command-feedback', package: '@deepseek-ai/dsh-command-feedback' },
  { id: 'llm-pi-ai', package: '@deepseek-ai/dsh-llm-pi-ai' },
  { id: 'session-telemetry-otel', package: '@deepseek-ai/dsh-session-telemetry-otel' },
  { id: 'typert-gateway', package: '@deepseek-ai/dsh-api-gateway' },
]
const OMITTED_BASE_PACKAGES = new Set(OMITTED_BASE_ROWS.map(entry => entry.package))
const CLI_RUNTIME_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-cmdline',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-http-proxy',
  '@deepseek-ai/dsh-launch-environment',
  '@deepseek-ai/dsh-session-reference',
  '@deepseek-ai/dsh-tmux-context',
  '@deepseek-ai/dsh-tool-ask-user',
  '@deepseek-ai/dsh-util-values',
]

function readJson(path) {
  return JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'))
}

function packagePaths() {
  const paths = []
  for (const name of readdirSync(resolve(ROOT, 'vendor'), { withFileTypes: true })) {
    if (name.isDirectory()) paths.push(posix.join('vendor', name.name, 'package.json'))
  }
  for (const group of readdirSync(resolve(ROOT, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const name of readdirSync(resolve(ROOT, 'packages', group.name), { withFileTypes: true })) {
      if (name.isDirectory()) paths.push(posix.join('packages', group.name, name.name, 'package.json'))
    }
  }
  for (const name of readdirSync(resolve(ROOT, 'native/landlock-run/packages'), { withFileTypes: true })) {
    if (name.isDirectory()) paths.push(posix.join('native/landlock-run/packages', name.name, 'package.json'))
  }
  for (const name of readdirSync(resolve(ROOT, 'apps'), { withFileTypes: true })) {
    if (name.isDirectory()) paths.push(posix.join('apps', name.name, 'package.json'))
  }
  return paths
}

const packages = new Map()
for (const manifestPath of packagePaths()) {
  const manifest = readJson(manifestPath)
  if (typeof manifest.name !== 'string') continue
  if (packages.has(manifest.name)) throw new Error(`duplicate workspace package ${manifest.name}`)
  packages.set(manifest.name, { directory: posix.dirname(manifestPath), manifest })
}

const basePackage = packages.get(BASE_NAME)
if (basePackage === undefined) throw new Error(`workspace package ${BASE_NAME} is missing`)
for (const { package: packageName } of OMITTED_BASE_ROWS) {
  if (basePackage.manifest.dependencies?.[packageName] === undefined) {
    throw new Error(`${BASE_NAME} does not declare omitted package ${packageName}`)
  }
  delete basePackage.manifest.dependencies[packageName]
}
writeFileSync(
  resolve(ROOT, basePackage.directory, 'package.json'),
  `${JSON.stringify(basePackage.manifest, null, 2)}\n`,
)

const basePatchPath = resolve(ROOT, basePackage.directory, 'cordis.patch.yml')
const basePatch = JSON.parse(runYq(['-o=json', '.', basePatchPath]))
const baseRows = basePatch?.[0]?.insert
if (!Array.isArray(baseRows)) throw new Error(`${BASE_NAME} patch has no insert list`)
const omittedRowIds = new Set(OMITTED_BASE_ROWS.map(entry => entry.id))
for (const id of omittedRowIds) {
  if (baseRows.filter(row => row.id === id).length !== 1) {
    throw new Error(`${BASE_NAME} patch does not contain exactly one ${id} row`)
  }
}
const omittedRowPredicate = [...omittedRowIds]
  .map(id => `.id == ${JSON.stringify(id)}`)
  .join(' or ')
runYq(['-i', `del(.[0].insert[] | select(${omittedRowPredicate}))`, basePatchPath])

const tuiManifestPath = process.env.DSH_TUI_MANIFEST
if (tuiManifestPath === undefined) throw new Error('DSH_TUI_MANIFEST must name the pinned TUI package.json')
const tuiManifest = JSON.parse(readFileSync(tuiManifestPath, 'utf8'))
const seeds = new Set([
  ...CLI_RUNTIME_PACKAGES,
  ...Object.keys(tuiManifest.peerDependencies ?? {}).filter(name => packages.has(name)),
])

const closure = new Set()
const queue = [...seeds]
while (queue.length > 0) {
  const name = queue.shift()
  if (closure.has(name)) continue
  const pkg = packages.get(name)
  if (pkg === undefined) throw new Error(`runtime package ${name} is not a workspace package`)
  if (name.startsWith('@deepseek-ai/dsh-client-') || FORBIDDEN_PACKAGES.has(name)) {
    throw new Error(`TUI runtime reached forbidden Web package ${name}`)
  }
  if (OMITTED_BASE_PACKAGES.has(name)) {
    throw new Error(`TUI runtime reached omitted base package ${name}`)
  }
  closure.add(name)
  for (const section of ['dependencies', 'peerDependencies']) {
    for (const dependency of Object.keys(pkg.manifest[section] ?? {})) {
      if (packages.has(dependency) && !closure.has(dependency)) queue.push(dependency)
    }
  }
}

const cliPackage = packages.get(CLI_NAME)
if (cliPackage === undefined) throw new Error(`workspace package ${CLI_NAME} is missing`)
const workspaceConfig = JSON.parse(runYq(['-o=json', '.', resolve(ROOT, 'pnpm-workspace.yaml')]))
function workspaceSpecifier(name) {
  const override = workspaceConfig.overrides?.[name]
  if (typeof override !== 'string' || !override.startsWith('link:')) return 'workspace:*'
  return `link:${posix.relative(CLI_PATH, override.slice('link:'.length))}`
}
const externalCliDependencies = Object.fromEntries(
  Object.entries(cliPackage.manifest.dependencies ?? {})
    .filter(([name]) => !packages.has(name))
    .sort(([left], [right]) => left.localeCompare(right)),
)
const workspaceDependencies = Object.fromEntries(
  [...closure].sort().map(name => [name, workspaceSpecifier(name)]),
)
cliPackage.manifest.dependencies = { ...workspaceDependencies, ...externalCliDependencies }
delete cliPackage.manifest.devDependencies
writeFileSync(resolve(ROOT, CLI_PATH, 'package.json'), `${JSON.stringify(cliPackage.manifest, null, 2)}\n`)

function runYq(args, input) {
  const result = spawnSync(process.env.YQ ?? 'yq', args, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`yq ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

function writeYaml(path, value, temporaryPrefix) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), temporaryPrefix))
  try {
    const jsonPath = join(temporaryDirectory, 'input.json')
    writeFileSync(jsonPath, JSON.stringify(value))
    writeFileSync(path, runYq(['-P', '-o=yaml', '.', jsonPath]))
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

const lockPath = resolve(ROOT, 'pnpm-lock.yaml')
const lock = JSON.parse(runYq(['-o=json', '.', lockPath]))
const cliImporter = lock.importers?.[CLI_PATH]
if (cliImporter === undefined) throw new Error(`pnpm lockfile has no ${CLI_PATH} importer`)
const baseImporter = lock.importers?.[basePackage.directory]
if (baseImporter === undefined) throw new Error(`pnpm lockfile has no ${basePackage.directory} importer`)
for (const { package: packageName } of OMITTED_BASE_ROWS) {
  if (baseImporter.dependencies?.[packageName] === undefined) {
    throw new Error(`pnpm lockfile ${basePackage.directory} importer lacks ${packageName}`)
  }
  delete baseImporter.dependencies[packageName]
}
const externalLockDependencies = Object.fromEntries(
  Object.keys(externalCliDependencies).map(name => {
    const entry = cliImporter.dependencies?.[name]
    if (entry === undefined) throw new Error(`pnpm lockfile ${CLI_PATH} importer lacks ${name}`)
    return [name, entry]
  }),
)
const workspaceLockDependencies = Object.fromEntries(
  [...closure].sort().map(name => {
    const pkg = packages.get(name)
    return [name, {
      specifier: workspaceSpecifier(name),
      version: `link:${posix.relative(CLI_PATH, pkg.directory)}`,
    }]
  }),
)
cliImporter.dependencies = { ...workspaceLockDependencies, ...externalLockDependencies }
delete cliImporter.devDependencies

writeYaml(lockPath, lock, 'dsh-tui-lock-')

const runtimePackages = [
  { name: CLI_NAME, path: CLI_PATH },
  ...[...closure].sort().map(name => ({ name, path: packages.get(name).directory })),
]
const runtimeDirectories = new Set(runtimePackages.map(pkg => pkg.path))
const cliTsconfigPath = resolve(ROOT, CLI_PATH, 'tsconfig.json')
const cliTsconfig = JSON.parse(readFileSync(cliTsconfigPath, 'utf8'))
if (!Array.isArray(cliTsconfig.references)) throw new Error(`${CLI_PATH}/tsconfig.json has no references`)
cliTsconfig.references = cliTsconfig.references.filter(({ path }) => {
  const target = posix.normalize(posix.join(CLI_PATH, path))
  return [...runtimeDirectories].some(directory => target === directory || target.startsWith(`${directory}/`))
})
writeFileSync(cliTsconfigPath, `${JSON.stringify(cliTsconfig, null, 2)}\n`)
writeFileSync(resolve(ROOT, OUTPUT_PATH), `${JSON.stringify(runtimePackages, null, 2)}\n`)
process.stdout.write(`project-tui-runtime: selected ${runtimePackages.length} workspace packages\n`)
