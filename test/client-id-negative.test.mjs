// Negative control for test/client-id.test.mjs.
//
// A guard that never fails is worthless, so reintroduce the exact bug that
// shipped (an unscoped registered id) in a COPY and confirm the guard rejects
// it — without ever writing to the real lib/client.js.
//
// Why a copy and not an in-place edit: the first attempt at this used
// PowerShell `Set-Content -Raw`, which re-encoded the file and corrupted the
// Chinese UI strings. The real file had to be restored from git. Node's fs
// preserves bytes, so this version cannot do that.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

// Build a throwaway tree that looks enough like the repo for the guard to run.
const dir = mkdtempSync(join(tmpdir(), 'relay-guard-'))
mkdirSync(join(dir, 'lib'), { recursive: true })
mkdirSync(join(dir, 'test'), { recursive: true })
copyFileSync(join(repo, 'package.json'), join(dir, 'package.json'))
copyFileSync(join(repo, 'cordis.patch.yml'), join(dir, 'cordis.patch.yml'))
copyFileSync(join(repo, 'lib/index.js'), join(dir, 'lib/index.js'))
copyFileSync(join(repo, 'test/client-id.test.mjs'), join(dir, 'test/client-id.test.mjs'))

const good = readFileSync(join(repo, 'lib/client.js'), 'utf8')
const buggy = good.replace('id: "@leaf233/dsh-model-gateway",', 'id: "dsh-model-gateway",')
if (buggy === good) {
  throw new Error('could not reintroduce the bug: the scoped id pattern was not found')
}

const run = (label, source) => {
  writeFileSync(join(dir, 'lib/client.js'), source, 'utf8')
  // Output goes to a FILE, not a pipe: a pipe is a named pipe on Windows, which
  // some sandboxes refuse to create, and spawnSync then reports no stdout at
  // all. test/run.mjs uses this same pattern for the same reason.
  const log = join(dir, 'out.log')
  const fd = openSync(log, 'w')
  let status
  try {
    status = spawnSync(process.execPath, [join(dir, 'test/client-id.test.mjs')], {
      stdio: ['ignore', fd, fd],
    }).status
  } finally {
    closeSync(fd)
  }
  const output = readFileSync(log, 'utf8')
  const failures = (output.match(/^FAIL - .*$/gm) ?? []).map((l) => l.trim())
  console.log(`${label}: exit=${status}`)
  for (const f of failures) console.log(`  ${f}`)
  return status
}

let bad = 0
const check = (cond, msg) => {
  console.log(`${cond ? 'ok   - ' : 'FAIL - '}${msg}`)
  if (!cond) bad += 1
}

const buggyStatus = run('with the bug reintroduced', buggy)
check(buggyStatus !== 0, 'the guard FAILS when the registered id is unscoped (bug is caught)')

const goodStatus = run('with the fix in place', good)
check(goodStatus === 0, 'the guard PASSES on the fixed bundle')

rmSync(dir, { recursive: true, force: true })
console.log(bad === 0 ? '\nnegative control holds' : '\nnegative control BROKEN')
process.exitCode = bad === 0 ? 0 : 1
