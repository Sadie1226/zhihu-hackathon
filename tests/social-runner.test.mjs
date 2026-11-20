import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const temporary = path.join(root, '.local', 'social-runner-tests')
const required = ['rules', 'meet', 'gift']
function fixture(t) {
  mkdirSync(temporary, { recursive: true })
  const directory = mkdtempSync(path.join(temporary, 'run-'))
  const scripts = path.join(directory, 'scripts')
  const social = path.join(directory, 'lib', 'social')
  mkdirSync(scripts, { recursive: true })
  mkdirSync(social, { recursive: true })
  copyFileSync(path.join(root, 'scripts/check-social.mjs'), path.join(scripts, 'check-social.mjs'))
  const suite = (name, source = `console.log('EXECUTED:${name}')`) =>
    writeFileSync(path.join(social, `${name}.test.ts`), source)
  required.forEach(name => suite(name))
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(temporary) + path.sep))
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    social, suite,
    run: () => spawnSync(process.execPath, [path.join(scripts, 'check-social.mjs')], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20_000,
    }),
  }
}

test('social runner executes every required suite and discovers new suites from its own root', t => {
  const f = fixture(t)
  f.suite('store.contract')
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  for (const name of [...required, 'store.contract']) assert.ok(result.stdout.includes(`EXECUTED:${name}`))
  assert.match(result.stdout, /4\/4 suites passed/)
})

test('one failed suite cannot be hidden by a later success; remaining suites still execute', t => {
  const f = fixture(t)
  f.suite('rules', "console.log('intentional failure'); process.exitCode = 7")
  const result = f.run()
  assert.equal(result.status, 1)
  assert.match(result.stdout, /FAIL \(exit 7\): lib\/social\/rules.test.ts/)
  assert.match(result.stdout, /EXECUTED:meet/)
  assert.match(result.stdout, /EXECUTED:gift/)
})

test('a missing required suite fails instead of silently shrinking the test list', t => {
  const f = fixture(t)
  unlinkSync(path.join(f.social, 'meet.test.ts'))
  const result = f.run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Missing required social suite: lib\/social\/meet.test.ts/)
  assert.match(result.stdout, /EXECUTED:gift/)
})

test('syntax/startup failure also makes the social runner fail', t => {
  const f = fixture(t)
  f.suite('meet', 'this is not valid javascript !!!')
  const result = f.run()
  assert.equal(result.status, 1)
  assert.match(result.stdout, /FAIL .*lib\/social\/meet.test.ts/)
  assert.match(result.stdout, /EXECUTED:gift/)
})
