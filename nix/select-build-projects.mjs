import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import ts from 'typescript'

const [packagesPath, configPath, outputPath] = process.argv.slice(2)
if (packagesPath === undefined || configPath === undefined || outputPath === undefined) {
  throw new Error('usage: select-build-projects.mjs PACKAGES CONFIG OUTPUT')
}
const packages = JSON.parse(readFileSync(packagesPath, 'utf8'))
const roots = packages.map(({ path }) => resolve(path))
const config = ts.readConfigFile(configPath, ts.sys.readFile)
if (config.error !== undefined) {
  throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
}
if (!Array.isArray(config.config.references)) throw new Error(`${configPath} has no project references`)
const projects = config.config.references
  .map(({ path }) => resolve(path))
  .filter(target => roots.some(root => target === root || target.startsWith(root + sep)))
if (projects.length === 0) throw new Error(`${configPath} selected no build projects`)
writeFileSync(outputPath, `${projects.join('\n')}\n`)
