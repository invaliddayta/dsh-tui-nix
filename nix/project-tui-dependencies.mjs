import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

function runYq(args, input) {
  return execFileSync(process.env.YQ ?? 'yq', args, {
    encoding: 'utf8',
    input,
    maxBuffer: 16 * 1024 * 1024,
  })
}

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const lockPath = 'pnpm-lock.yaml'
const lock = JSON.parse(runYq(['-o=json', '.', lockPath]))
const importer = lock.importers?.['.']
if (importer === undefined) throw new Error('TUI lockfile has no root importer')
for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
  delete importer.dependencies?.[peer]
}
lock.settings = { ...lock.settings, autoInstallPeers: false }

writeFileSync(lockPath, runYq(['-P', '-o=yaml', '.'], JSON.stringify(lock)))
process.stdout.write('project-tui-dependencies: disabled automatic Harness peers\n')
