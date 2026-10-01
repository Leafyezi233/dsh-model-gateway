/**
 * Guard the two names that DSH matches by exact string, and which are easy to
 * get wrong in opposite directions.
 *
 * Run: node test/client-id.test.mjs
 *
 * Why this exists: scoping package.json to @leaf233/dsh-model-gateway while
 * leaving the browser half's registered id unscoped produced this at runtime —
 *
 *   failed to import loader entry efb9826d (@leaf233/dsh-model-gateway):
 *   client-modules: bundle .../@leaf233/dsh-model-gateway/client.js loaded
 *   without registering "@leaf233/dsh-model-gateway" via __ModuleLoader__.load
 *
 * The bundle loaded fine; it just registered a different key, so the loader
 * rejected it and the WHOLE plugin failed to import — the host half never ran,
 * so no /v1 route and no provider card. `dsh-client-modules/lib/client.js:247`
 * is the check:
 *
 *   if (!this.factories.has(id)) throw new Error(`...loaded without registering "${id}"...`)
 *
 * `id` there is the graph row id, derived from the package name; `factories` is
 * keyed by the id passed to `__ModuleLoader__.load`. They must be identical.
 *
 * The host half is the opposite case: `export const name` is the loader entry
 * name that the profile patch layer and dshmarket's `disabled` list target by
 * `id`, so it must stay UNscoped. Scoping it would silently break both.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createContext, runInContext } from 'node:vm'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

let bad = 0
const check = (condition, message) => {
  console.log(`${condition ? 'ok   - ' : 'FAIL - '}${message}`)
  if (!condition) bad += 1
}

const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const client = readFileSync(join(repo, 'lib/client.js'), 'utf8')
const host = readFileSync(join(repo, 'lib/index.js'), 'utf8')
const patch = readFileSync(join(repo, 'cordis.patch.yml'), 'utf8')

// --- the browser half: registered id MUST equal the package name ------------

const loadCall = client.match(/__ModuleLoader__\.load\(\{([\s\S]*?)\n\tfactory:/)
check(loadCall !== null, 'lib/client.js calls __ModuleLoader__.load({ id, factory })')

const registered = loadCall?.[1].match(/\bid:\s*"([^"]+)"/)?.[1]
check(registered !== undefined, 'the load call declares a string id')
check(
  registered === pkg.name,
  `the registered id equals the package name (id=${JSON.stringify(registered)}, name=${JSON.stringify(pkg.name)})`,
)

// --- the host half: exported name MUST stay the unscoped patch anchor -------

const hostName = host.match(/^export const name = '([^']+)'/m)?.[1]
check(hostName !== undefined, 'lib/index.js exports a name')
check(
  hostName === 'dsh-model-gateway',
  `the host name stays unscoped as the patch anchor (name=${JSON.stringify(hostName)})`,
)

// --- the bundle patch: id unscoped (the anchor), name scoped (resolvable) ---

const patchId = patch.match(/^\s*-?\s*id:\s*(\S+)\s*$/m)?.[1]
const patchName = patch.match(/^\s*name:\s*'([^']+)'\s*$/m)?.[1]
check(
  patchId === hostName,
  `the patch row id matches the host name, so profile overrides still target it (id=${JSON.stringify(patchId)})`,
)
check(
  patchName === pkg.name,
  `the patch row name is the resolvable package identity (name=${JSON.stringify(patchName)})`,
)

// --- replay the loader's own assertion against the real bundle --------------
//
// The string checks above could in principle pass while the bundle still
// registers something else (a second load call, a computed id). So actually
// execute lib/client.js with a stub __ModuleLoader__ that records what it
// registers, then apply dsh-client-modules' own rule:
//
//   if (!factories.has(rowId)) throw ...
//
// The bundle is a plain <script> (no top-level ESM export), so it runs as-is in
// a VM context. `factory` is never invoked, so its `require` calls never run.

const registeredIds = []
const sandbox = { window: { __ModuleLoader__: { load: (entry) => registeredIds.push(entry.id) } } }
runInContext(client, createContext(sandbox), { filename: 'lib/client.js' })

check(
  registeredIds.length === 1,
  `the bundle registers exactly one module (registered ${JSON.stringify(registeredIds)})`,
)
// This is the loader's assertion, reproduced: the graph row id comes from the
// package name, and the factory map must contain it.
const loaderAccepts = registeredIds.includes(pkg.name)
check(
  loaderAccepts,
  `dsh-client-modules would accept the bundle: factories.has(${JSON.stringify(pkg.name)}) === true`,
)

process.exitCode = bad === 0 ? 0 : 1
