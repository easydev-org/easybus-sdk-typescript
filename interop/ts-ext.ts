// TS-side interop extension: serves `echo`, `add`, `session`, `fail` over NATS
// so a Go/Python/Rust agent (interop/go-agent) can drive it. Mirrors the Go
// interop/go-ext.
//
//   NATS_URL=... node --experimental-strip-types interop/ts-ext.ts
//
// On a call hook / event hook / config apply it prints a line (the interop
// harness reads stdout).

import { connect } from '../src/transport/nats/index.js'
import { Extension, TypedError, type Config } from '../src/extension/index.js'

async function main(): Promise<void> {
  const url = process.env['NATS_URL'] || 'nats://127.0.0.1:4222'
  const bus = await connect(url)
  const cfg: Config = {
    id: 'ts-ext',
    version: '1.0',
    config: {
      'poll-interval': { description: 'seconds between polls', type: 'number', default: 30 },
    },
    onConfigChange: async (_ctx, name, value) => {
      console.log(`[ts-ext] config applied: ${name}=${JSON.stringify(value)}`)
    },
    tools: {
      echo: { description: 'echo content back', execute: async (_ctx, args) => ({ content: 'ts-ext echo: ' + String(args['msg'] ?? '') }) },
      add: { description: 'add two numbers', execute: async (_ctx, args) => ({ data: { sum: Number(args['a'] ?? 0) + Number(args['b'] ?? 0) } }) },
      session: { description: 'echo the session name', execute: async (_ctx, _args, _cid, session) => ({ content: 'session=' + session }) },
      fail: {
        description: 'always returns a business error',
        execute: async () => {
          throw new TypedError('CODE_BUSINESS', 'deliberate failure')
        },
      },
    },
    variables: {
      'ts-var': { resolve: async (_ctx, session) => `from-ts-ext/${session}` },
    },
    callHooks: ['interop.before'],
    onCallHook: async (_ctx, hook, session) => ({ ok: true, data: { session, hook } }),
    eventHooks: ['interop.event'],
    onEventHook: async (_ctx, hook, session, payload) => {
      console.log(`[ts-ext] event hook=${hook} session=${session} payload=${JSON.stringify(payload)}`)
    },
  }
  const ext = new Extension(bus, cfg)
  const ctl = new AbortController()
  process.on('SIGINT', () => ctl.abort())
  process.on('SIGTERM', () => ctl.abort())
  await ext.serve(ctl.signal)
  console.log(`[ts-ext] serving ts-ext over ${url}`)
  await new Promise<void>(resolve => ctl.signal.addEventListener('abort', () => resolve(), { once: true }))
  await ext.close()
  console.log('[ts-ext] shutting down')
}

void main().catch(e => {
  console.error('[ts-ext] fatal:', e)
  process.exit(1)
})
