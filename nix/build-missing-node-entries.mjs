import { isBuiltin } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'tsdown'

const packages = JSON.parse(readFileSync('nix/tui-runtime-workspaces.json', 'utf8'))
for (const { name, path } of packages) {
  const configPath = resolve(path, 'tsdown.config.ts')
  if (!existsSync(configPath) || !readFileSync(configPath, 'utf8').includes('clientBundle(')) continue
  const manifest = JSON.parse(readFileSync(resolve(path, 'package.json'), 'utf8'))
  const main = manifest.main
  if (typeof main !== 'string') throw new Error(`${name} uses clientBundle but has no main entry`)
  const output = resolve(path, main)
  if (existsSync(output)) continue
  const entry = resolve(path, 'lib/types/index.js')
  if (!existsSync(entry)) throw new Error(`${name} lacks the Host TypeScript output ${entry}`)
  const dependencies = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ])
  const productionDependency = specifier => {
    const packageName = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0]
    return dependencies.has(packageName)
  }
  await build({
    config: false,
    entry: [entry],
    outDir: resolve(path, 'lib'),
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      neverBundle: productionDependency,
      alwaysBundle: specifier => !isBuiltin(specifier) && !productionDependency(specifier),
    },
  })
  if (!existsSync(output)) throw new Error(`${name} fallback build did not emit ${output}`)
}
