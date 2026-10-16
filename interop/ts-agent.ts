// TS-side interop agent: discovers a Go extension (go-ext) and asserts the
// cross-language wire contract. Mirrors interop/go-agent.
//
//   NATS_URL=... node --experimental-strip-types interop/ts-agent.ts

import { connect } from '../src/transport/nats/index.js'
import { Agent } from '../src/agent/index.js'

function expect(cond: boolean, msg: string): void {
  if (!cond) {
    console.log('[ts-agent] FAIL:', msg)
    process.exit(1)
  }
  console.log('[ts-agent] ok:', msg)
}

async function main(): Promise<void> {
  const url = process.env['NATS_URL'] || 'nats://127.0.0.1:4222'
  const bus = await connect(url)
  const a = new Agent(bus)
  const ctx = (ms: number) => AbortSignal.timeout(ms)
  console.log('[ts-agent] connected to', url)

  // 1. discover the Go extension.
  const ms = await a.discover(ctx(1500), 1000)
  expect(ms.some(m => m.id === 'go-ext'), 'discover sees go-ext')

  // 2. tool content crosses Go->TS.
  const tr = await a.callTool(ctx(3000), 'i1', 'sess-x', 'go-ext', 'echo', 'c1', { msg: 'hello-from-ts' })
  expect(tr.content === 'go-ext echo: hello-from-ts', 'tool echo content')

  // 3. session name crosses.
  const s = await a.callTool(ctx(3000), 'i1', 'sess-x', 'go-ext', 'session', 'c2', {})
  expect(s.content === 'session=sess-x', 'session name')

  // 4. error mapping crosses.
  const e = await a.callTool(ctx(3000), 'i1', 'sess-x', 'go-ext', 'fail', 'c3', {})
  expect(e.error?.code === 'CODE_BUSINESS' && e.error?.message === 'deliberate failure', 'business error mapping')

  // 5. event hook (Go ext logs on its stdout).
  await a.publishEventHook(ctx(3000), 'i1', 'interop.event', 'sess-ts', { from: 'ts-agent' })
  console.log('[ts-agent] ok: event hook published (check go-ext stdout)')

  console.log('[ts-agent] ALL INTEROP CHECKS PASSED')
  await a.close()
}

void main().catch(e => {
  console.error('[ts-agent] fatal:', e)
  process.exit(1)
})
