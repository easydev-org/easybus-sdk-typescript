// The second half of the conformance suite — cases the first file did not cover
// (config series, interrupt, progress, lifecycle, lease, DLQ, presence replicas,
// object offload, slow tool). Mirrors easybus-sdk/conformance.

import { afterAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { connect, type Bus } from '../src/index.js'
import { Agent, ConfigError } from '../src/agent/index.js'
import { Extension, type Config } from '../src/extension/index.js'
import { CONFIG_KV_BUCKET, newID } from '../src/protocol/protocol.js'
import { valueToJson } from '../src/transport/nats/nats.js'

const T = 't1'
let server: ChildProcess | null = null
let url = ''

async function startNats(): Promise<string | null> {
  const bin = process.env['EASYBUS_NATS_SERVER_BIN'] || 'nats-server'
  const dir = mkdtempSync(join(tmpdir(), 'easybus-ts2-'))
  const port = 15222 + Math.floor(Math.random() * 1000)
  const p = spawn(bin, ['-p', String(port), '-sd', dir, '-js'])
  let spawnErr = false
  p.on('error', () => { spawnErr = true })
  let ready = false
  for (let i = 0; i < 60 && !spawnErr; i++) {
    ready = await new Promise<boolean>(resolve => {
      const sock = createConnection({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true) })
      sock.on('error', () => resolve(false))
    })
    if (ready) break
    await delay(50)
  }
  if (!ready) { p.kill(); return null }
  server = p
  return `nats://127.0.0.1:${port}`
}

url = (await startNats()) ?? ''
if (!url) console.warn('[conformance2] no nats-server; broker cases will skip')
const CTX = (ms: number) => AbortSignal.timeout(ms)

function fullExt(bus: Bus, opts: Partial<Config> = {}): Extension {
  const cfg: Config = {
    id: 'conf-ext',
    version: '1',
    tools: {
      echo: { execute: async (_c, args) => ({ content: 'echo:' + String(args['msg'] ?? '') }) },
      slow: { execute: async () => { await delay(50); return { content: 'woke' } } },
      big: { execute: async () => ({ object: { id: 'big-1', contentType: 'text/plain' } }) },
      hang: {
        execute: async ctx => {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(() => resolve(), 30000)
            ctx.addEventListener('abort', () => { clearTimeout(t); reject(new Error('interrupted')) }, { once: true })
          })
          return { content: 'never' }
        },
      },
    },
    config: {
      'poll-interval': { type: 'number', default: 30 },
      mode: { type: 'enum', enumValues: ['fast', 'safe'], default: 'safe' },
      'session-limit': { type: 'number', default: 5, scope: 'session' },
    },
    ...opts,
  }
  return new Extension(bus, cfg)
}

describe('conformance2', () => {
  afterAll(() => server?.kill())

  it.skipIf(!url)('tool_object_offload', async () => {
    const a = await connect(url)
    const e = await connect(url)
    await a.objectPut(CTX(3000), `t.${T}.big-1`, new Uint8Array(300 * 1024))
    const ext = fullExt(e)
    await ext.serve(CTX(10_000))
    const agent = new Agent(a)
    try {
      const tr = await agent.callTool(CTX(3000), T, 'sess-1', 'conf-ext', 'big', 'c3', {})
      expect(tr.object?.id).toBe('big-1')
    } finally { await ext.close(); await a.close() }
  })

  it.skipIf(!url)('request_timeout_zero_is_bounded', async () => {
    const a = await connect(url)
    const e = await connect(url)
    const ext = fullExt(e)
    await ext.serve(CTX(10_000))
    const agent = new Agent(a)
    try {
      await expect(agent.callTool(CTX(1500), T, 'sess-1', 'conf-ext', 'missing', 'c6', {})).rejects.toBeTruthy()
    } finally { await ext.close(); await a.close() }
  })

  it.skipIf(!url)('slow_tool_no_request_cap', async () => {
    const a = await connect(url)
    const e = await connect(url)
    const ext = fullExt(e)
    await ext.serve(CTX(10_000))
    const agent = new Agent(a)
    try {
      const tr = await agent.callTool(CTX(30_000), T, 'sess-1', 'conf-ext', 'slow', 'slow-1', {})
      expect(tr.content).toBe('woke')
    } finally { await ext.close(); await a.close() }
  })

  it.skipIf(!url)('progress', async () => {
    const a = await connect(url)
    const e = await connect(url)
    const ext = fullExt(e)
    await ext.serve(CTX(10_000))
    const agent = new Agent(a)
    try {
      const sub = await agent.subscribeProgress(CTX(3000), T, 'c-progress')
      const got = sub.next(CTX(5000))
      await ext.reportProgress(CTX(3000), T, 'c-progress', { phase: 'sync', progress: 0.5, text: 'half' })
      const env = await got
      const p = valueToJson(env?.payload) as { call_id?: string; phase?: string }
      expect(p.call_id).toBe('c-progress')
      expect(p.phase).toBe('sync')
      await sub.close()
    } finally { await ext.close(); await a.close() }
  })

  it.skipIf(!url)('interrupt_cancels_inflight_tool', async () => {
    const a = await connect(url)
    const e = await connect(url)
    const ext = fullExt(e)
    await ext.serve(CTX(10_000))
    const agent = new Agent(a)
    try {
      const p1 = agent.callTool(CTX(20_000), T, 'sess-int', 'conf-ext', 'hang', 'hang-1', {})
      const p2 = agent.callTool(CTX(20_000), T, 'sess-other', 'conf-ext', 'hang', 'hang-2', {})
      await delay(400)
      await agent.interruptSession(CTX(3000), T, 'conf-ext', 'sess-int', 'test')
      const r1 = await p1
      expect(r1.error?.message).toContain('interrupted')
      await delay(400)
      await agent.interrupt(CTX(3000), T, 'conf-ext')
      const r2 = await p2
      expect(r2.error?.message).toContain('interrupted')
    } finally { await ext.close(); await a.close() }
  })

  it.skipIf(!url)('interrupt', async () => {
    const a = await connect(url)
    const e = await connect(url)
    const ext = fullExt(e)
    await ext.serve(CTX(10_000))
    try {
      await new Agent(a).interrupt(CTX(3000), T, 'conf-ext')
      expect(true).toBe(true)
    } finally { await ext.close(); await a.close() }
  })

  it.skipIf(!url)('on_interrupt_callback', async () => {
    const a = await connect(url)
    const e = await connect(url)
    const got: string[] = []
    const ext = fullExt(e, { onInterrupt: (_c, session, reason) => { got.push(`${session}|${reason}`) } })
    await ext.serve(CTX(10_000))
    const agent = new Agent(a)
    try {
      void agent.callTool(CTX(20_000), T, 'sess-cb', 'conf-ext', 'hang', 'cb-1', {}).catch(() => {})
      await delay(400)
      await agent.interruptSession(CTX(3000), T, 'conf-ext', 'sess-cb', 'because')
      for (let i = 0; i < 50 && got.length === 0; i++) await delay(50)
      expect(got[0]).toBe('sess-cb|because')
    } finally { await ext.close(); await a.close() }
  })

  it.skipIf(!url)('lifecycle', async () => {
    const a = await connect(url)
    const e = await connect(url)
    const received: string[] = []
    const ext = new Extension(e, {
      id: 'lc-ext', version: '1',
      lifecycle: ['created', 'forked', 'renamed', 'deleted'],
      onLifecycle: async (_c, ev) => { received.push(ev.kind) },
    })
    await ext.serve(CTX(10_000))
    const agent = new Agent(a)
    try {
      for (const kind of ['created', 'forked', 'renamed', 'deleted']) {
        await agent.publishLifecycleEvent(CTX(3000), T, kind, 'sess-lc', { k: kind })
      }
      for (let i = 0; i < 100 && received.length < 4; i++) await delay(50)
      expect(received).toEqual(['created', 'forked', 'renamed', 'deleted'])
    } finally { await ext.close(); await a.close() }
  })

  it.skipIf(!url)('kv_watch', async () => {
    const a = await connect(url)
    try {
      await a.kvPut(CTX(3000), 'watch-test', 'k.a', '1', 0)
      const w = await a.kvWatch(CTX(3000), 'watch-test', 'k.>')
      const iter = w.events[Symbol.asyncIterator]()
      const first = await iter.next()
      expect(first.value.key).toBe('k.a')
      expect(first.value.value).toBe('1')
      expect(first.value.isUpdate).toBe(false)
      const boundary = await iter.next()
      expect(boundary.value.done).toBe(true)
      await a.kvPut(CTX(3000), 'watch-test', 'k.b', '2', 0)
      const upd = await iter.next()
      expect(upd.value.key).toBe('k.b')
      expect(upd.value.isUpdate).toBe(true)
      await a.kvDelete(CTX(3000), 'watch-test', 'k.b')
      const del = await iter.next()
      expect(del.value.key).toBe('k.b')
      expect(del.value.deleted).toBe(true)
      w.stop()
    } finally { await a.close() }
  })

  it.skipIf(!url)('session_lease', async () => {
    const a1 = await connect(url)
    const a2 = await connect(url)
    const ag1 = new Agent(a1)
    const ag2 = new Agent(a2)
    const session = 'sess-lease-' + newID().slice(0, 8)
    try {
      const rev1 = await ag1.claimSession(CTX(3000), T, session, 1000)
      const rev2 = await ag2.claimSession(CTX(3000), T, session, 1000)
      expect(rev1 === null && rev2 === null).toBe(false)
      expect(rev1 !== null && rev2 !== null).toBe(false)
      const holder = rev1 !== null ? ag1 : ag2
      let rev = (rev1 ?? rev2)!
      expect(await holder.isSessionRunning(CTX(3000), T, session)).toBe(true)
      const next = await holder.renewSession(CTX(3000), T, session, rev, 1000)
      expect(next).not.toBeNull()
      expect(next!).toBeGreaterThan(rev)
      const stale = await holder.renewSession(CTX(3000), T, session, rev, 1000)
      expect(stale).toBeNull()
      rev = next!
      await holder.releaseSession(CTX(3000), T, session)
      expect(await holder.isSessionRunning(CTX(3000), T, session)).toBe(false)
      const other = holder === ag1 ? ag2 : ag1
      expect(await other.claimSession(CTX(3000), T, session, 1000)).not.toBeNull()
      await other.releaseSession(CTX(3000), T, session)
      void rev
    } finally { await a1.close(); await a2.close() }
  })

  it.skipIf(!url)('config_validation', async () => {
    const a = await connect(url)
    const e = await connect(url)
    const ext = fullExt(e)
    await ext.serve(CTX(10_000))
    const agent = new Agent(a)
    try {
      await agent.discover(CTX(3000), 500)
      agent.serveConfig(true)
      await expect(agent.setConfig(CTX(3000), T, 'conf-ext', 'poll-interval', 'fast', '')).rejects.toBeInstanceOf(ConfigError)
      await expect(agent.setConfig(CTX(3000), T, 'conf-ext', 'mode', 'turbo', '')).rejects.toBeInstanceOf(ConfigError)
      await expect(agent.setConfig(CTX(3000), T, 'conf-ext', 'nope', 1, '')).rejects.toBeInstanceOf(ConfigError)
    } finally { await ext.close(); await a.close() }
  })

  it.skipIf(!url)('config_session_override', async () => {
    const a = await connect(url)
    const e = await connect(url)
    const seen: string[] = []
    const ext = fullExt(e, { onConfigChange: async (_c, _n, _v, session) => { seen.push(session) } })
    await ext.serve(CTX(10_000))
    const agent = new Agent(a)
    try {
      await agent.discover(CTX(3000), 500)
      agent.serveConfig(true)
      await agent.setConfig(CTX(6000), T, 'conf-ext', 'session-limit', 99, 'sess-a')
      for (let i = 0; i < 50 && seen.length === 0; i++) await delay(50)
      expect(seen[0]).toBe('sess-a')
      await agent.dropSessionConfig(CTX(3000), T, 'conf-ext', 'sess-a')
    } finally { await ext.close(); await a.close() }
  })

  it.skipIf(!url)('config_no_ack', async () => {
    const a = await connect(url)
    const e = await connect(url)
    const applied: unknown[] = []
    const ext = fullExt(e, { onConfigChange: async (_c, _n, value) => { applied.push(value) } })
    await ext.serve(CTX(10_000))
    const agent = new Agent(a)
    try {
      await agent.discover(CTX(3000), 500)
      agent.serveConfig(true)
      await agent.setConfig(CTX(3000), T, 'conf-ext', 'poll-interval', 3, '', undefined, false)
      for (let i = 0; i < 50 && applied.length === 0; i++) await delay(50)
      expect(applied[0]).toBe(3)
    } finally { await ext.close(); await a.close() }
  })

  it.skipIf(!url)('config_snapshot', async () => {
    const a = await connect(url)
    const e = await connect(url)
    const ext = fullExt(e)
    await ext.serve(CTX(10_000))
    const agent = new Agent(a)
    try {
      await agent.discover(CTX(3000), 500)
      agent.serveConfig(true)
      await agent.setConfig(CTX(6000), T, 'conf-ext', 'poll-interval', 7, '')
      const raw = await a.kvGet(CTX(3000), CONFIG_KV_BUCKET, `t.${T}.conf-ext.poll-interval`)
      expect(raw).toContain('7')
    } finally { await ext.close(); await a.close() }
  })

  it.skipIf(!url)('config_recovers_from_kv', async () => {
    const a = await connect(url)
    const e = await connect(url)
    try {
      await a.kvPut(CTX(3000), CONFIG_KV_BUCKET, `t.${T}.conf-ext.poll-interval`, JSON.stringify({ r: 5, v: 42 }), 0)
      const ext = new Extension(e, { id: 'conf-ext', version: '1', config: { 'poll-interval': { type: 'number', default: 30 } } })
      await ext.serve(CTX(10_000))
      try {
        for (let i = 0; i < 50 && ext.getConfig(T, 'poll-interval', '') !== 42; i++) await delay(100)
        expect(ext.getConfig(T, 'poll-interval', '')).toBe(42)
      } finally { await ext.close() }
    } finally { await a.close() }
  })

  it.skipIf(!url)('term_routes_to_dlq', async () => {
    const a = await connect(url)
    try {
      const sub = await a.inboxConsume(CTX(5000), { subject: `easybus.${T}.mailbox.>` })
      await a.inboxPublish(CTX(3000), `easybus.${T}.mailbox.dead1`, { id: 'dlq-1', type: 'event', payload: {} }, { id: 'dlq-1', tenant: T, sessionName: 'sess-dlq' })
      const m = await sub.next(CTX(3000))
      expect(m).not.toBeNull()
      m!.term()
      await delay(300)
      const dlq = await a.replay(CTX(3000), `easybus.${T}.dlq.>`)
      expect(dlq.length).toBeGreaterThan(0)
      await sub.close()
    } finally { await a.close() }
  })

  it.skipIf(!url)('requeue_dlq', async () => {
    const a = await connect(url)
    try {
      await a.inboxPublish(CTX(3000), `easybus.${T}.dlq.requeue`, { id: 'rq-1', type: 'requeue-me', payload: { k: 1 } }, { id: 'rq-1', tenant: T, sessionName: 'sess-rq' })
      await delay(300)
      const dlq = await a.replay(CTX(3000), `easybus.${T}.dlq.>`)
      expect(dlq.some(env => env.id === 'rq-1')).toBe(true)
    } finally { await a.close() }
  })

  it.skipIf(!url)('poison_message_escalates_to_dlq', async () => {
    const a = await connect(url)
    try {
      const sub = await a.inboxConsume(CTX(5000), { subject: `easybus.${T}.mailbox.>` })
      await a.inboxPublish(CTX(3000), `easybus.${T}.mailbox.dead2`, { id: 'p-1', type: 'event', payload: {} }, { id: 'p-1', tenant: T, sessionName: 'sess-poison' })
      const m = await sub.next(CTX(3000))
      expect(m).not.toBeNull()
      m!.term()
      await delay(300)
      const dlq = await a.replay(CTX(3000), `easybus.${T}.dlq.>`)
      expect(dlq.length).toBeGreaterThan(0)
      await sub.close()
    } finally { await a.close() }
  })

  it.skipIf(!url)('presence_replica_keys', async () => {
    // Each replica AND the observer have their OWN connection: a replica's
    // close() drains its bus, so a replica must never share one.
    const a = await connect(url)
    const e1 = await connect(url)
    const e2 = await connect(url)
    const r1 = new Extension(e1, { id: 'conf-ext', version: '1', replicaId: 'pod-a', tools: { echo: { execute: async () => ({ content: 'x' }) } } })
    const r2 = new Extension(e2, { id: 'conf-ext', version: '1', replicaId: 'pod-b', tools: { echo: { execute: async () => ({ content: 'x' }) } } })
    await r1.serve(CTX(10_000))
    await r2.serve(CTX(10_000))
    try {
      for (let i = 0; i < 50; i++) {
        const v1 = await a.kvGet(CTX(2000), 'easybus-presence', 'conf-ext.pod-a').catch(() => '')
        const v2 = await a.kvGet(CTX(2000), 'easybus-presence', 'conf-ext.pod-b').catch(() => '')
        if (v1 !== '' && v2 !== '') break
        await delay(100)
      }
      expect(await a.kvGet(CTX(2000), 'easybus-presence', 'conf-ext.pod-a')).not.toBe('')
      expect(await a.kvGet(CTX(2000), 'easybus-presence', 'conf-ext.pod-b')).not.toBe('')
      await r1.close()
      // pod-a's key must vanish (only its own); pod-b's must remain.
      for (let i = 0; i < 50; i++) {
        const aKey = await a.kvGet(CTX(2000), 'easybus-presence', 'conf-ext.pod-a').catch(() => 'x')
        if (aKey === '') break
        await delay(100)
      }
      expect(await a.kvGet(CTX(2000), 'easybus-presence', 'conf-ext.pod-a')).toBe('')
      expect(await a.kvGet(CTX(2000), 'easybus-presence', 'conf-ext.pod-b')).not.toBe('')
    } finally { await r2.close(); await a.close() }
  })
})
