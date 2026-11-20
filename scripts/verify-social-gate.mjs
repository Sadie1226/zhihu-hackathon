/** Regression proof in disposable copies; never edit the checkout's rules or schema. */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const parent = path.join(root, '.local', 'social-gate-proof')
mkdirSync(parent, { recursive: true })
const proof = mkdtempSync(path.join(parent, 'run-'))
const bash = process.env.SOCIAL_GATE_BASH || (process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash')
const reports = []

function copy(name) {
  const directory = path.join(proof, name)
  for (const folder of ['contracts', 'lib/social', 'lib/mailbox']) {
    mkdirSync(path.dirname(path.join(directory, folder)), { recursive: true })
    cpSync(path.join(root, folder), path.join(directory, folder), { recursive: true })
  }
  mkdirSync(path.join(directory, 'scripts'), { recursive: true })
  for (const file of ['check-social.mjs', 'check-all.sh', 'check-contracts.mjs', 'check-mailbox.mjs', 'check-secrets.sh'])
    cpSync(path.join(root, 'scripts', file), path.join(directory, 'scripts', file))
  for (const folder of ['app', 'components']) mkdirSync(path.join(directory, folder))
  writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}\n')
  return directory
}

function run(directory, command, args, label) {
  const result = spawnSync(command, args, { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  const output = `${result.stdout}\n${result.stderr}`
  writeFileSync(path.join(proof, `${path.basename(directory)}-${label}.log`), output)
  return { code: result.status, output }
}

const baseline = copy('baseline')
assert.equal(run(baseline, process.execPath, ['scripts/check-social.mjs'], 'social').code, 0)
assert.equal(run(baseline, bash, ['scripts/check-all.sh'], 'all').code, 0)
reports.push({ scenario: 'unmodified', social: 0, checkAll: 0 })

for (const scenario of ['whitelist-weakened', 'recipient-foreign-key-removed']) {
  const directory = copy(scenario)
  const file = path.join(directory, scenario === 'whitelist-weakened' ? 'lib/social/rules.ts' : 'contracts/schema.sql')
  const source = readFileSync(file, 'utf8')
  const changed = scenario === 'whitelist-weakened'
    ? source.replace('if (!whitelist.has(key)) {', 'if (false && !whitelist.has(key)) {')
    : source.replace(/(to_dog\s+TEXT\s+NOT NULL) REFERENCES dog\(id\)/, '$1')
  assert.notEqual(changed, source, `mutation matched: ${scenario}`)
  writeFileSync(file, changed)
  const social = run(directory, process.execPath, ['scripts/check-social.mjs'], 'social')
  assert.equal(social.code, 1, `${scenario} must fail social suites`)
  assert.match(social.output, /FAIL .*lib\/social\//)
  const all = run(directory, bash, ['scripts/check-all.sh'], 'all')
  assert.equal(all.code, 1, `${scenario} must fail check-all`)
  assert.match(all.output, /5\/5 社交回归/)
  assert.match(all.output, /FAIL .*lib\/social\//)
  reports.push({ scenario, social: social.code, checkAll: all.code })
}

// A fresh copy proves the final success does not depend on restoring a mutated
// real checkout. Temporary copies/logs stay below the ignored .local directory.
const restored = copy('restored')
assert.equal(run(restored, process.execPath, ['scripts/check-social.mjs'], 'social').code, 0)
reports.push({ scenario: 'restored-copy', social: 0 })
writeFileSync(path.join(proof, 'result.json'), JSON.stringify({ passed: true, reports }, null, 2))
console.log(JSON.stringify({ passed: true, reports, evidence: path.relative(root, proof) }, null, 2))
