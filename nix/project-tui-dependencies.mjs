import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function runYq(args) {
  const result = spawnSync(process.env.YQ ?? 'yq', args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`yq ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const lockPath = resolve('pnpm-lock.yaml')
const lock = JSON.parse(runYq(['-o=json', '.', lockPath]))
const importer = lock.importers?.['.']
if (importer === undefined) throw new Error('TUI lockfile has no root importer')
for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
  delete importer.dependencies?.[peer]
}
lock.settings = { ...lock.settings, autoInstallPeers: false }

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'dsh-tui-dependencies-'))
try {
  const jsonPath = join(temporaryDirectory, 'pnpm-lock.json')
  writeFileSync(jsonPath, JSON.stringify(lock))
  writeFileSync(lockPath, runYq(['-P', '-o=yaml', '.', jsonPath]))
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
process.stdout.write('project-tui-dependencies: disabled automatic Harness peers\n')
