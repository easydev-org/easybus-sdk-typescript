import { afterAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { connect, type Bus } from '../src/index.js'
import { Agent } from '../src/agent/index.js'
import { Extension, TypedError, type Config } from '../src/extension/index.js'
import { CH_DISCOVER, GLOBAL_TENANT, chMailbox, newID, VARS_BUCKET, sessionVarKey } from '../src/protocol/protocol.js'

// The protocol conformance suite — the TS twin of easybus-sdk/conformance.
// Runs against a REAL nats-server (like the Go suite); skips when the binary is
// unavailable. Every case gets its own broker + two connections (agent + ext).

const T = 't1'

let server: ChildProcess | null = null
let url = ''

async function startNats(): Promise<string | null> {
  const bin = process.env['EASYBUS_NATS_SERVER_BIN'] || 'nats-server'
  const dir = mkdtempSync(join(tmpdir(), 'easybus-ts-'))
  const port = 14222 + Math.floor(Math.random() * 1000)
  const p = spawn(bin, ['-p', String(port), '-sd', dir, '-js'])
  let spawnErr = false
  p.on('error', () => { spawnErr = true })
  // Poll a TCP connection until the server accepts (more robust than parsing logs).
  let ready = false
  for (let i = 0; i < 60 && !spawnErr; i++) {
    ready = await new Promise<boolean>(resolve => {
      const sock = createConnection({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true) })
      sock.on('error', () => resolve(false))
    })
    if (ready) break
    await delay(50)
  }
  if (!ready) {
    p.kill()
    return null
  }
  server = p
  return `nats://127.0.0.1:${port}`
}

function echoExt(bus: Bus, opts: { onConfigChange?: Config['onConfigChange']; onCallHook?: Config['onCallHook']; onEventHook?: Config['onEventHook'] } = {}): Extension {
  const cfg: Config = {
    id: 'conf-ext',
    version: '1',
    tools: {
      echo: { execute: async (_ctx, args) => ({ content: 'echo:' + String(args['msg'] ?? '') }) },
      add: { execute: async (_ctx, args) => ({ data: { sum: Number(args['a'] ?? 0) + Number(args['b'] ?? 0) } }) },
      session: { execute: async (_ctx, _args, _cid, session) => ({ content: 'session=' + session }) },
      boom: {
        execute: async () => {
          throw new TypedError('CODE_BUSINESS', 'nope')
        },
      },
      big: {
        execute: async () => ({ content: 'x'.repeat(200 * 1024) }),
      },
    },
    variables: { 'base-url': { resolve: async () => 'https://example.test' } },
    config: {
      'poll-interval': { type: 'number', default: 30 },
      mode: { type: 'enum', enumValues: ['fast', 'safe'], default: 'safe' },
    },
    callHooks: ['session.before_create'],
    onCallHook: opts.onCallHook ?? (async (_c, hook, session) => ({ ok: true, data: { session, hook } })),
    eventHooks: ['session.created'],
    onEventHook: opts.onEventHook,
    onConfigChange: opts.onConfigChange,
  }
  return new Extension(bus, cfg)
}

// Start the broker BEFORE the describe is collected, so `it.skipIf(!url)`
// evaluates against the real URL (not the empty pre-beforeAll value).
url = (await startNats()) ?? ''
if (!url) console.warn('[conformance] no nats-server; broker-dependent cases will skip')

describe('conformance', () => {
  afterAll(() => {
    server?.kill()
  })

  async function pair(): Promise<{ a: Bus; e: Bus; agent: Agent; ext: Extension; stop: () => Promise<void> }> {
    const a = await connect(url)
    const e = await connect(url)
    const agent = new Agent(a)
    const ext = echoExt(e)
    await ext.serve(AbortSignal.timeout(10_000))
    return {
      a,
      e,
      agent,
      ext,
      stop: async () => {
        await ext.close()
        await a.close()
      },
    }
  }

  it.skipIf(!url)('discover', async () => {
    const { agent, ext, stop } = await pair()
    try {
      const manifests = await agent.discover(AbortSignal.timeout(3000), 500)
      expect(manifests.some(m => m.id === 'conf-ext')).toBe(true)
      const m = manifests.find(x => x.id === 'conf-ext')!
      expect(m.tools?.map(t => t.name).sort()).toEqual(['add', 'big', 'boom', 'echo', 'session'])
      expect(m.capabilities).toContain('tools')
      expect(m.capabilities).toContain('prompt')
    } finally {
      void ext
      await stop()
    }
  })

  it.skipIf(!url)('tool_content', async () => {
    const { agent, stop } = await pair()
    try {
      const r = await agent.callTool(AbortSignal.timeout(3000), T, 'sess-1', 'conf-ext', 'echo', 'c1', { msg: 'hi' })
      expect(r.content).toBe('echo:hi')
      expect(r.error).toBeUndefined()
    } finally {
      await stop()
    }
  })

  it.skipIf(!url)('tool_data', async () => {
    const { agent, stop } = await pair()
    try {
      const r = await agent.callTool(AbortSignal.timeout(3000), T, 'sess-1', 'conf-ext', 'add', 'c2', { a: 2, b: 3 })
      expect(r.data).toEqual({ sum: 5 })
    } finally {
      await stop()
    }
  })

  it.skipIf(!url)('tool_error_mapping', async () => {
    const { agent, stop } = await pair()
    try {
      const r = await agent.callTool(AbortSignal.timeout(3000), T, 'sess-1', 'conf-ext', 'boom', 'c3', {})
      expect(r.error?.code).toBe('CODE_BUSINESS')
      expect(r.error?.message).toBe('nope')
    } finally {
      await stop()
    }
  })

  it.skipIf(!url)('tool_call_id_echo', async () => {
    const { agent, stop } = await pair()
    try {
      const r = await agent.callTool(AbortSignal.timeout(3000), T, 'sess-1', 'conf-ext', 'echo', 'call-xyz', { msg: '1' })
      expect(r.content).toBe('echo:1')
    } finally {
      await stop()
    }
  })

  it.skipIf(!url)('tool_session_name', async () => {
    const { agent, stop } = await pair()
    try {
      const r = await agent.callTool(AbortSignal.timeout(3000), T, 'my-session', 'conf-ext', 'session', 'c4', {})
      expect(r.content).toBe('session=my-session')
    } finally {
      await stop()
    }
  })

  it.skipIf(!url)('tool_content_over_limit', async () => {
    const { agent, stop } = await pair()
    try {
      const r = await agent.callTool(AbortSignal.timeout(3000), T, 'sess-1', 'conf-ext', 'big', 'c5', {})
      expect(r.error?.code).toBe('CODE_INVALID_ARGUMENT')
      expect(r.content).toBe('')
    } finally {
      await stop()
    }
  })

  it.skipIf(!url)('variable', async () => {
    const { agent, stop } = await pair()
    try {
      const [v, ok] = await agent.resolveVariable(AbortSignal.timeout(3000), T, 'sess-1', 'conf-ext', 'base-url')
      expect(ok).toBe(true)
      expect(v).toBe('https://example.test')
    } finally {
      await stop()
    }
  })

  it.skipIf(!url)('call_hook', async () => {
    const { agent, stop } = await pair()
    try {
      const hr = await agent.callHook(AbortSignal.timeout(3000), T, 'conf-ext', 'session.before_create', 'sess-h', { k: 'v' })
      expect(hr?.ok).toBe(true)
      expect(hr?.data).toEqual({ session: 'sess-h', hook: 'session.before_create' })
    } finally {
      await stop()
    }
  })

  it.skipIf(!url)('event_hook', async () => {
    const seen: unknown[] = []
    const a = await connect(url)
    const e = await connect(url)
    const ext = echoExt(e, { onEventHook: async (_c, hook, session, payload) => { seen.push({ hook, session, payload }) } })
    await ext.serve(AbortSignal.timeout(10_000))
    const agent = new Agent(a)
    try {
      await agent.publishEventHook(AbortSignal.timeout(3000), T, 'session.created', 'sess-ev', { x: 1 })
      for (let i = 0; i < 30 && seen.length === 0; i++) await delay(20)
      expect(seen).toEqual([{ hook: 'session.created', session: 'sess-ev', payload: { x: 1 } }])
    } finally {
      await ext.close()
      await a.close()
    }
  })

  it.skipIf(!url)('object_store', async () => {
    const { agent, stop } = await pair()
    try {
      const data = new TextEncoder().encode('hello bytes')
      await agent.putObject(AbortSignal.timeout(3000), T, 'o1', data)
      const got = await agent.getObject(AbortSignal.timeout(3000), T, 'o1')
      expect(new TextDecoder().decode(got!)).toBe('hello bytes')
    } finally {
      await stop()
    }
  })

  it.skipIf(!url)('kv', async () => {
    const { a, stop } = await pair()
    try {
      await a.kvPut(AbortSignal.timeout(3000), 'test-bucket', 'k1', 'v1', 0)
      expect(await a.kvGet(AbortSignal.timeout(3000), 'test-bucket', 'k1')).toBe('v1')
      await a.kvDelete(AbortSignal.timeout(3000), 'test-bucket', 'k1')
      expect(await a.kvGet(AbortSignal.timeout(3000), 'test-bucket', 'k1')).toBe('')
    } finally {
      await stop()
    }
  })

  it.skipIf(!url)('mailbox', async () => {
    const { a, agent, stop } = await pair()
    try {
      const got: string[] = []
      const stopConsume = await agent.consumeMailbox(AbortSignal.timeout(5000), async m => {
        got.push(m.type + ':' + (m.payload as { text?: string }).text)
      })
      await agent.publishMailbox(AbortSignal.timeout(3000), T, 'sess-mb', 'trigger', { text: 'hello' }, 'user')
      for (let i = 0; i < 50 && got.length === 0; i++) await delay(20)
      expect(got).toEqual(['trigger:hello'])
      stopConsume()
    } finally {
      void a
      await stop()
    }
  })

  it.skipIf(!url)('config_set_and_apply', async () => {
    const applied: unknown[] = []
    const a = await connect(url)
    const e = await connect(url)
    const ext = echoExt(e, { onConfigChange: async (_c, name, value) => { applied.push({ name, value }) } })
    await ext.serve(AbortSignal.timeout(10_000))
    try {
      // The config channel is `easybus.*.config.<id>` with an ack reply.
      const reply = await a.request(AbortSignal.timeout(3000), `easybus.${T}.config.conf-ext`, { name: 'poll-interval', value: 60, ack: true }, { tenant: T })
      expect((reply?.payload as { ok?: boolean })?.ok).toBe(true)
      for (let i = 0; i < 30 && applied.length === 0; i++) await delay(20)
      expect(applied).toEqual([{ name: 'poll-interval', value: 60 }])
      expect(ext.getConfig(T, 'poll-interval', '')).toBe(60)
    } finally {
      await ext.close()
      await a.close()
    }
  })

  it.skipIf(!url)('config_rejected', async () => {
    const a = await connect(url)
    const e = await connect(url)
    const ext = echoExt(e, { onConfigChange: async (_c, name) => { if (name === 'poll-interval') throw new Error('rejected') } })
    await ext.serve(AbortSignal.timeout(10_000))
    try {
      const reply = await a.request(AbortSignal.timeout(3000), `easybus.${T}.config.conf-ext`, { name: 'poll-interval', value: 99, ack: true }, { tenant: T })
      const body = reply?.payload as { ok?: boolean; error?: { message?: string } }
      expect(body?.ok).toBe(false)
      expect(body?.error?.message).toBe('rejected')
    } finally {
      await ext.close()
      await a.close()
    }
  })

  it.skipIf(!url)('session_events', async () => {
    const a = await connect(url)
    const e = await connect(url)
    const ext = echoExt(e)
    await ext.serve(AbortSignal.timeout(10_000))
    try {
      const events: unknown[] = []
      const stopConsume = await new Agent(a).consumeMailbox(AbortSignal.timeout(5000), async () => {})
      void stopConsume
      // Subscribe to the session event stream directly.
      const { chSessionEvents } = await import('../src/protocol/protocol.js')
      const sub = await a.subscribe(AbortSignal.timeout(3000), chSessionEvents(T, 'sess-se'))
      void (async () => {
        for (;;) {
          const env = await sub.next(AbortSignal.timeout(5000))
          if (!env) return
          events.push(env.payload)
        }
      })()
      await ext.publishSessionEvent(AbortSignal.timeout(3000), T, 'sess-se', 'todos-updated', { count: 3 })
      for (let i = 0; i < 50 && events.length === 0; i++) await delay(20)
      expect((events[0] as { event?: string })?.event).toBe('todos-updated')
      await sub.close()
    } finally {
      await ext.close()
      await a.close()
    }
  })

  it.skipIf(!url)('ext_mailbox', async () => {
    const a = await connect(url)
    const e = await connect(url)
    const ext = echoExt(e)
    await ext.serve(AbortSignal.timeout(10_000))
    try {
      const got: unknown[] = []
      const stopConsume = await new Agent(a).consumeMailbox(AbortSignal.timeout(5000), async m => { got.push(m) })
      await ext.publishMailboxEvent(AbortSignal.timeout(3000), T, 'sess-emb', 'event', { done: true })
      for (let i = 0; i < 50 && got.length === 0; i++) await delay(20)
      expect((got[0] as { type?: string })?.type).toBe('event')
      stopConsume()
    } finally {
      await ext.close()
      await a.close()
    }
  })

  it.skipIf(!url)('variable_kv_first', async () => {
    const { a, agent, stop } = await pair()
    try {
      // Pre-seed the KV cache; the resolver must be bypassed.
      await a.kvPut(AbortSignal.timeout(3000), VARS_BUCKET, sessionVarKey(T, 'conf-ext', 'sess-v', 'base-url'), 'cached-value', 0)
      const [v, ok] = await agent.resolveVariable(AbortSignal.timeout(3000), T, 'sess-v', 'conf-ext', 'base-url')
      expect(ok).toBe(true)
      expect(v).toBe('cached-value')
    } finally {
      await stop()
    }
  })

  it.skipIf(!url)('presence_liveness', async () => {
    const a = await connect(url)
    const e = await connect(url)
    const agent = new Agent(a)
    const ext = echoExt(e)
    await ext.serve(AbortSignal.timeout(10_000))
    try {
      // Start the presence watcher (a single discover primes it), then wait for
      // the heartbeat to populate the cache.
      void agent.discover(AbortSignal.timeout(2000), 300).catch(() => {})
      for (let i = 0; i < 100 && !agent.manifest('conf-ext'); i++) await delay(50)
      expect(agent.manifest('conf-ext')).not.toBeNull()
      await ext.close()
      // After the extension closes (key deleted), the manifest should drop.
      for (let i = 0; i < 100 && agent.manifest('conf-ext'); i++) await delay(50)
      expect(agent.manifest('conf-ext')).toBeNull()
    } finally {
      await a.close()
    }
  }, 20000)

  it.skipIf(!url)('hook_schema_validation', async () => {
    const a = await connect(url)
    const e = await connect(url)
    const ext = new Extension(e, {
      id: 'conf-ext',
      version: '1',
      callHooks: ['audit'],
      hookSchemas: { call: { audit: { type: 'object', required: ['who'], properties: { who: { type: 'string' } } } } },
      onCallHook: async () => ({ ok: true }),
    })
    await ext.serve(AbortSignal.timeout(10_000))
    try {
      const agent = new Agent(a)
      const bad = await agent.callHook(AbortSignal.timeout(3000), T, 'conf-ext', 'audit', 'sess-h', { nope: true })
      expect(bad?.ok).toBe(false)
      // The wire code is the proto enum NUMBER (CODE_INVALID_ARGUMENT = 1);
      // the agent decodes it back to the name.
      expect(bad?.error?.code).toBe('CODE_INVALID_ARGUMENT')
      const good = await agent.callHook(AbortSignal.timeout(3000), T, 'conf-ext', 'audit', 'sess-h', { who: 'me' })
      expect(good?.ok).toBe(true)
    } finally {
      await ext.close()
      await a.close()
    }
  })
})

// A sanity check that never needs a broker.
describe('protocol constants', () => {
  it('newID is uuid-shaped', () => {
    expect(newID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
  it('discover channel + global tenant', () => {
    expect(CH_DISCOVER).toBe('easybus.discover')
    expect(GLOBAL_TENANT).toBe('global')
    expect(chMailbox('t1', 'sess-1')).toBe('easybus.t1.mailbox.q-Yz86R6J1gXTqvpFg2vNs')
  })
})
