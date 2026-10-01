/**
 * Re-derive the README's failure table from the real plugin, so the documented
 * values cannot drift from behavior. This is the verification for the table in
 * README.md ("各种失败分别会怎样").
 *
 * Run: node test/verify-table.mjs
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmService, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { apply } from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-table-'))
let seq = 0
const RETRYABLE = new Set(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])

/** The table as written in README.md, so a mismatch is a documentation bug. */
const EXPECTED = {
  RATE_LIMIT: [429, true],
  SERVER: [502, true],
  TIMEOUT: [502, true],
  TRANSPORT: [502, true],
  EMPTY_RESPONSE: [502, true],
  QUOTA: [429, false],
  AUTH: [401, false],
  INVALID_CREDENTIAL: [401, false],
  MISSING_CREDENTIAL: [401, false],
  UNSUPPORTED_REASONING_EFFORT: [400, false],
  CONTEXT_WINDOW_EXCEEDED: [400, false],
  INVALID_REQUEST: [400, false],
  ABORTED: [499, false],
  SOMETHING_UNMAPPED: [502, false],
}

class MemberAdapter extends LlmAdapter {
  constructor(code) { super(); this.code = code }
  providerInfo(provider) { return { id: provider, name: 'Member' } }
  async listModels(provider) { return [{ provider, id: 'm', name: 'm' }] }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: 128000 } }
  }
  stream() {
    const { code } = this
    return (async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code, message: `${code} failed` } } }
    })()
  }
}

function mounted(code) {
  const ctx = new Context()
  const llm = new LlmService(ctx)
  ctx.llm = llm
  const routes = {}
  ctx.webServer = { port: 0, host: '127.0.0.1', register: (entry) => { Object.assign(routes, entry); return () => {} } }
  llm.registerConfigurableProviders([{ provider: 'member', displayName: 'Member', settingsNs: 'llm-member', settingsPath: [] }])
  llm.registerAdapter(['member'], new MemberAdapter(code))
  const groupsFile = join(dir, `g${seq++}.json`)
  writeFileSync(groupsFile, JSON.stringify({ version: 1, groups: [{ id: 'g', name: 'g', models: ['member_m'], enabled: true }] }))
  apply(ctx, { keysFile: join(dir, `k${seq++}.json`), groupsFile })
  return { llm, routes }
}

async function httpStatus(routes) {
  const req = {
    method: 'POST',
    url: `${routes.path}/chat/completions`,
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }))
    },
  }
  const captured = { status: undefined }
  const res = {
    statusCode: 200,
    writableEnded: false,
    setHeader() {},
    getHeader() {},
    flushHeaders() {},
    write() { return true },
    end() { captured.status = this.statusCode; this.writableEnded = true },
    on() { return this },
  }
  await routes.handler(req, res)
  return captured.status ?? res.statusCode
}

let bad = 0
for (const [code, [wantStatus, wantRetry]] of Object.entries(EXPECTED)) {
  const { llm, routes } = mounted(code)
  let failure
  for await (const chunk of llm.stream({ provider: 'dsh-model-gateway', model: 'g', messages: [] })) {
    if (chunk.type === 'finish') failure = chunk.reason?.failure
  }
  const status = await httpStatus(routes)
  const retries = RETRYABLE.has(failure?.code)
  const ok = status === wantStatus && retries === wantRetry
  if (!ok) bad += 1
  // The `ok   - ` / `FAIL - ` markers are the convention `test/run.mjs` tallies.
  console.log(
    ok
      ? `ok   - ${code} maps to ${status} and retry=${retries}, as documented`
      : `FAIL - ${code} maps to ${status} and retry=${retries}, but the README says ${wantStatus} and retry=${wantRetry}`,
  )
}

console.log(bad === 0 ? '\nthe README table matches the code' : `\n${bad} row(s) disagree with the README`)
process.exitCode = bad === 0 ? 0 : 1