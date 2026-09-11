import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const source = resolve(process.env.DSH_LAUNCHER_SOURCE ?? fileURLToPath(new URL('../nix', import.meta.url)))

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-launcher-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const out = join(root, 'package')
  const home = join(root, 'home')
  const profile = join(home, 'profiles/deepseek-harness-tui')
  mkdirSync(profile, { recursive: true })
  mkdirSync(join(out, 'libexec/dsh/bin'), { recursive: true })
  cpSync(join(source, 'tui-profile'), join(out, 'share/dsh/profiles/deepseek-harness-tui'), { recursive: true })
  writeFileSync(join(out, 'libexec/dsh/bin/dsh'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 })
  const launcher = join(root, 'launcher.sh')
  writeFileSync(launcher, readFileSync(join(source, 'dsh-tui.sh'), 'utf8')
    .replaceAll('@out@', out).replaceAll('@profileVersion@', 'test-version'))
  const run = (reset = false) => spawnSync('sh', [launcher, '--help'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: root, DSH_HOME: home, DSH_TUI_RESET_PROFILE: reset ? '1' : '0' },
  })
  return { profile, run }
}

test('seeds a profile and resets managed files without changing the user patch', t => {
  const { profile, run } = fixture(t)
  assert.equal(run().status, 0)
  writeFileSync(join(profile, 'cordis.patch.yml'), '[] # user patch\n')
  writeFileSync(join(profile, 'package.json'), '{}\n')
  const result = run(true)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '--profile\ndeepseek-harness-tui\n--help\n')
  assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), '[] # user patch\n')
  assert.notEqual(readFileSync(join(profile, 'package.json'), 'utf8'), '{}\n')
})

for (const file of ['package.json', 'cordis.yml', 'pnpm-workspace.yaml']) {
  test(`refuses an unowned profile containing a dangling ${file} symlink`, t => {
    const { profile, run } = fixture(t)
    const path = join(profile, file)
    symlinkSync('missing-user-config', path)
    const result = run(true)
    assert.notEqual(result.status, 0, 'must refuse to claim or overwrite the user profile')
    assert.match(result.stderr, /refusing to replace unowned profile/)
    assert.equal(readlinkSync(path), 'missing-user-config')
    assert.equal(existsSync(join(profile, '.managed-by-deepseek-harness-tui')), false)
  })
}

for (const reset of [false, true]) {
  test(`preserves a dangling user patch symlink during ${reset ? 'reset' : 'first launch'}`, t => {
    const { profile, run } = fixture(t)
    if (reset) {
      assert.equal(run().status, 0)
      rmSync(join(profile, 'cordis.patch.yml'))
    }
    const patch = join(profile, 'cordis.patch.yml')
    symlinkSync('missing-user-patch', patch)
    const result = run(reset)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(lstatSync(patch).isSymbolicLink(), true)
    assert.equal(readlinkSync(patch), 'missing-user-patch')
    assert.equal(readFileSync(join(profile, '.nix-package-version'), 'utf8'), 'test-version\n')
  })
}
