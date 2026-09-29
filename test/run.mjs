/**
 * Run every suite, even when an earlier one fails.
 *
 * `npm test` used to chain the suites with `&&`, which meant a single failure
 * hid every suite after it — on Windows the LAN-address case fails for a
 * platform reason (`/proc/net/route` does not exist), so five of the six suites
 * never ran and the run looked far healthier than it was.
 *
 * Each suite is a separate process so one suite's state cannot leak into
 * another, and the exit code is non-zero if anything failed.
 *
 * Child output is redirected to a temporary file rather than a pipe. A pipe is
 * a named pipe on Windows, which some sandboxes refuse to create, and a
 * failure there would look like every suite crashing at once. A file has no
 * such restriction and behaves identically on every platform.
 */
import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

const SUITES = [
  'gateway.test.mjs',
  'keys.test.mjs',
  'groups.test.mjs',
  'nesting.test.mjs',
  'strategy.test.mjs',
  'stats.test.mjs',
  'stats-store.test.mjs',
  'client-bundle.test.mjs',
  'adapter.test.mjs',
  'adapter-real.test.mjs',
  'registration.test.mjs',
  'failure-code.test.mjs',
  'verify-table.mjs',
  'client-id.test.mjs',
  'client-id-negative.test.mjs',
]

const tally = (output, marker) => (output.match(new RegExp(`^${marker}`, 'gm')) ?? []).length

let passed = 0
let failed = 0
const broken = []

for (const suite of SUITES) {
  const log = join(here, `.${suite}.log`)
  const fd = openSync(log, 'w')
  let result
  try {
    result = spawnSync(process.execPath, [join(here, suite)], { stdio: ['ignore', fd, fd] })
  } finally {
    closeSync(fd)
  }
  let output = ''
  try {
    output = readFileSync(log, 'utf8')
  } catch {
    // Left as empty: the suite reported nothing, which the checks below catch.
  }
  rmSync(log, { force: true })

  const ok = tally(output, 'ok   - ')
  const bad = tally(output, 'FAIL - ')
  passed += ok
  failed += bad
  console.log(`\n=== ${suite} — ${ok} passed, ${bad} failed ===`)
  process.stdout.write(output.endsWith('\n') || output === '' ? output : `${output}\n`)
  // A suite that crashed before reporting anything still counts as a failure.
  if (result.error !== undefined) {
    console.log(`    could not run: ${result.error.message}`)
    broken.push(suite)
  } else if (result.status !== 0 && bad === 0) {
    broken.push(suite)
  }
}

console.log(`\n${'-'.repeat(60)}`)
console.log(`total: ${passed} passed, ${failed} failed`)
if (broken.length > 0) console.log(`suites that exited abnormally: ${broken.join(', ')}`)
process.exitCode = failed > 0 || broken.length > 0 ? 1 : 0
