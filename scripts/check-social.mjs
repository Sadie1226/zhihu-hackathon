import { existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = path.join(root, 'lib', 'social')
const required = ['rules.test.ts', 'meet.test.ts', 'gift.test.ts']
let failed = false

if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('Social checks require Node 24+, matching package.json.')
  process.exit(1)
}

let discovered
try {
  discovered = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map(entry => entry.name).sort()
} catch (error) {
  console.error(`Cannot discover social suites: ${error.message}`)
  process.exit(1)
}

// Required files cannot disappear silently. Discover later suites as well, so a new
// adapter contract test does not require another manual change to this list.
const suites = [...required, ...discovered.filter(name => !required.includes(name))]
const results = []
for (const name of suites) {
  const relative = `lib/social/${name}`
  const file = path.join(directory, name)
  console.log(`\n══ Social: ${relative}`)
  if (!discovered.includes(name) || !existsSync(file)) {
    console.error(`Missing required social suite: ${relative}`)
    results.push({ suite: relative, result: 'MISSING' })
    failed = true
    continue
  }
  // One Node process per file: additional script paths are not Node test entries.
  const child = spawnSync(process.execPath, [file], {
    cwd: root, stdio: 'inherit', windowsHide: true, timeout: 60_000,
  })
  const ok = !child.error && !child.signal && child.status === 0
  if (child.error) console.error(`Cannot complete ${relative}: ${child.error.message}`)
  if (child.signal) console.error(`${relative} terminated by ${child.signal}`)
  results.push({ suite: relative, result: ok ? 'PASS' : `FAIL (exit ${child.status ?? 'none'})` })
  if (!ok) failed = true
}

console.log('\n══ Social suite summary (suite count, not assertion count)')
for (const row of results) console.log(`${row.result}: ${row.suite}`)
console.log(`${results.filter(row => row.result === 'PASS').length}/${results.length} suites passed`)
process.exitCode = failed ? 1 : 0
