// The NATS transport — the TypeScript twin of the Go `easybus-sdk/transport/nats`
// package. There is exactly ONE transport (NATS/JetStream); this module is its
// adapter. The wire envelope is JSON: {v:2, ch, kind, tenant, payload, id?,
// session_name?, reply_to?}. Stream topology (mailbox / events / dlq) and the
// object/KV buckets must match the Go side.

import {
  type NatsConnection,
  type Msg,
  type Subscription as NatsSubscription,
  headers as natsHeaders,
} from '@nats-io/nats-core'
import { connect as natsConnect } from '@nats-io/transport-node'
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager, type Consumer } from '@nats-io/jetstream'
import { Kvm, type KV } from '@nats-io/kv'
import { Objm, type ObjectStore as NatsObjectStore } from '@nats-io/obj'

import type {
  Bus,
  Envelope,
  InboxConsumeOpts,
  InboxMsg,
  InboxPublishOpts,
  InboxSubscription,
  KvEvent,
  PublishOpts,
  RequestOpts,
  SubscribeOpts,
  Subscription,
} from '../../bus/bus.js'
import { subjectTenant, tenantPrefix, sessionToken } from '../../protocol/protocol.js'
import { type Identity, authHeader, verify } from '../../identity/identity.js'

const STREAM_MAILBOX = 'EASYBUS_MAILBOX'
const STREAM_EVENTS = 'EASYBUS_EVENTS'
const STREAM_DLQ = 'EASYBUS_DLQ'
const INBOX_WILDCARD = 'easybus.*.mailbox.>'
const EVENTS_WILDCARD = 'easybus.*.session.events.>'
const LIFECYCLE_WILDCARD = 'easybus.*.session.lifecycle.>'
const CHANGED_WILDCARD = 'easybus.*.session.changed'
const DLQ_WILDCARD = 'easybus.*.dlq.>'
const DURABLE_CONSUMER = 'easybus-mailbox-push'
const OBJECT_BUCKET = 'EASYBUS_TOOL'
const OBJECT_BUCKET_DUR = 'EASYBUS_FILES'

/** Options tune stream topology and retention at connect time. */
export interface Options {
  /** MaxAge bounds stream retention (ms). 0 = 24h. */
  maxAgeMs?: number
  /** JetStream replica count at stream creation. 0 = server default. */
  replicas?: number
  /** Identity enables opt-in message auth (HMAC headers). */
  identity?: Identity
}

interface RawEnvelope {
  v: number
  tenant: string
  ch: string
  kind: string
  id?: string
  session_name?: string
  reply_to?: string
  payload?: unknown
}

/** Connect establishes a NATS connection with the default stream topology. */
export async function connect(url = 'nats://127.0.0.1:4222', opts: Options = {}): Promise<Bus> {
  const nc = await natsConnect({ servers: url })
  const js = jetstream(nc)
  const jsm = await jetstreamManager(nc)
  await ensureStreams(jsm, opts)
  return new NatsBus(nc, js, jsm, opts.identity)
}

/** ensureStreams reconciles the mailbox/events/dlq streams (declarative). */
async function ensureStreams(jsm: JetStreamManager, opts: Options): Promise<void> {
  const maxAge = opts.maxAgeMs && opts.maxAgeMs > 0 ? opts.maxAgeMs * 1_000_000 : 24 * 3600 * 1_000_000_000
  const specs: Array<{ name: string; subjects: string[] }> = [
    { name: STREAM_MAILBOX, subjects: [INBOX_WILDCARD] },
    { name: STREAM_EVENTS, subjects: [EVENTS_WILDCARD, LIFECYCLE_WILDCARD, CHANGED_WILDCARD] },
    { name: STREAM_DLQ, subjects: [DLQ_WILDCARD] },
  ]
  for (const s of specs) {
    let info
    try {
      info = await jsm.streams.info(s.name)
    } catch {
      await jsm.streams.add({ name: s.name, subjects: s.subjects, max_age: maxAge, ...(opts.replicas ? { num_replicas: opts.replicas } : {}) })
      continue
    }
    if (!sameSubjects(info.config.subjects ?? [], s.subjects)) {
      await jsm.streams.update(s.name, { ...info.config, subjects: s.subjects })
    }
  }
}

function sameSubjects(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every(s => set.has(s))
}

/** streamFor routes a (possibly wildcard) subject to its stream by the v2 layout. */
function streamFor(subject: string): string {
  const seg = subject.split('.')
  if (seg.length > 3 && seg[2] === 'session' && (seg[3] === 'events' || seg[3] === 'lifecycle' || seg[3] === 'changed')) {
    return STREAM_EVENTS
  }
  if (seg.length > 2 && seg[2] === 'dlq') return STREAM_DLQ
  return STREAM_MAILBOX
}

/** dlqSubjectFor maps an original queue subject to its tenant dead-letter subject. */
function dlqSubjectFor(subject: string): string {
  let token = subject
  const i = subject.lastIndexOf('.')
  if (i >= 0) token = subject.slice(i + 1)
  const tenant = subjectTenant(subject)
  return tenant !== '' ? `${tenantPrefix(tenant)}dlq.${token}` : `easybus.dlq.${token}`
}

function tenantOf(ch: string, explicit?: string): string {
  return explicit ?? subjectTenant(ch)
}

function buildEnvelope(kind: string, ch: string, payload: unknown, tenant: string, id?: string, sessionName?: string, replyTo?: string): Uint8Array {
  const m: RawEnvelope = { v: 2, ch, kind, tenant, payload }
  if (id) m.id = id
  if (sessionName) m.session_name = sessionName
  if (replyTo) m.reply_to = replyTo
  return new TextEncoder().encode(JSON.stringify(m))
}

function decode(data: Uint8Array, reply?: string): Envelope {
  const raw = JSON.parse(new TextDecoder().decode(data)) as RawEnvelope
  if (raw.v !== 2) throw new Error(`unsupported envelope version ${raw.v}`)
  const env: Envelope = {
    v: raw.v,
    ch: raw.ch,
    tenant: raw.tenant,
    kind: (raw.kind as Envelope['kind']) ?? 'pub',
    payload: raw.payload,
  }
  if (raw.id) env.id = raw.id
  if (raw.session_name) env.sessionName = raw.session_name
  if (reply) env.replyTo = reply
  return env
}

class NatsBus implements Bus {
  private kvCache = new Map<string, Promise<KV>>()
  private objCache: Promise<NatsObjectStore> | null = null
  private objDurCache: Promise<NatsObjectStore> | null = null

  constructor(
    private readonly nc: NatsConnection,
    private readonly js: JetStreamClient,
    private readonly jsm: JetStreamManager,
    private readonly idn?: Identity,
  ) {}

  private sign(h: ReturnType<typeof natsHeaders>, ch: string, kind: string, id: string, payload: unknown): void {
    if (!this.idn) return
    const hdr = authHeader(this.idn, { ch, kind, id, payload })
    h.set('easybus-id', hdr.id)
    h.set('easybus-sig', hdr.sig)
  }

  private verifyMsg(m: Msg, raw: RawEnvelope): boolean {
    if (!this.idn) return true
    const sig = m.headers?.get('easybus-sig') ?? ''
    if (!sig) return false
    return verify(m.headers?.get('easybus-id') ?? '', this.idn.secret, { tenant: raw.tenant, ch: m.subject, kind: raw.kind, id: raw.id, payload: raw.payload }, sig)
  }

  async request(ctx: AbortSignal, ch: string, payload: unknown, opts: RequestOpts = {}): Promise<Envelope | null> {
    const data = buildEnvelope('req', ch, payload, tenantOf(ch, opts.tenant), undefined, opts.sessionName)
    const timeout = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : undefined
    try {
      const m = await this.nc.request(ch, data, timeout ? { timeout } : undefined)
      const raw = JSON.parse(new TextDecoder().decode(m.data)) as RawEnvelope
      if (!this.verifyMsg(m, raw)) throw new Error(`identity: signature verification failed on ${m.subject}`)
      return decode(m.data, m.reply)
    } catch (e) {
      if (ctx.aborted) return null
      throw e
    }
  }

  async requestMany(ctx: AbortSignal, ch: string, payload: unknown, opts: RequestOpts = {}): Promise<Envelope[]> {
    const data = buildEnvelope('req', ch, payload, tenantOf(ch, opts.tenant))
    const out: Envelope[] = []
    const maxWait = opts.maxWaitMs && opts.maxWaitMs > 0 ? opts.maxWaitMs : 500
    const iter = await this.nc.requestMany(ch, data, { maxWait, strategy: 'stall' })
    const timer = setTimeout(() => {}, 0)
    clearTimeout(timer)
    const abortable = (async () => {
      for await (const m of iter) {
        const raw = JSON.parse(new TextDecoder().decode(m.data)) as RawEnvelope
        if (!this.verifyMsg(m, raw)) continue
        out.push(decode(m.data, m.reply))
      }
    })()
    await abortable
    return out
  }

  async publish(ctx: AbortSignal, ch: string, payload: unknown, opts: PublishOpts = {}): Promise<void> {
    const data = buildEnvelope('pub', ch, payload, tenantOf(ch, opts.tenant), undefined, undefined, opts.replyTo)
    const h = natsHeaders()
    this.sign(h, ch, 'pub', '', payload)
    this.nc.publish(ch, data, opts.replyTo ? { reply: opts.replyTo, headers: h } : { headers: h })
  }

  async subscribe(ctx: AbortSignal, ch: string, opts: SubscribeOpts = {}): Promise<Subscription> {
    const sub = this.nc.subscribe(ch, opts.queue ? { queue: opts.queue } : {})
    await this.nc.flush()
    return new NatsSub(sub, this)
  }

  async inboxPublish(ctx: AbortSignal, ch: string, payload: unknown, opts: InboxPublishOpts): Promise<void> {
    const data = buildEnvelope('queue', ch, payload, tenantOf(ch, opts.tenant), opts.id, opts.sessionName)
    await this.js.publish(ch, data, { msgID: opts.id })
  }

  async inboxConsume(ctx: AbortSignal, opts: InboxConsumeOpts): Promise<InboxSubscription> {
    const subject = opts.subject || INBOX_WILDCARD
    const durable = subject === INBOX_WILDCARD ? DURABLE_CONSUMER : `${DURABLE_CONSUMER}-${sessionToken(subject)}`
    const stream = streamFor(subject)
    const c = await this.js.consumers.get(stream, durable).catch(async () => {
      await this.jsm.consumers.add(stream, { durable_name: durable, filter_subject: subject, ack_policy: 'explicit' })
      return this.js.consumers.get(stream, durable)
    })
    return new NatsInboxSub(c, this)
  }

  async replay(ctx: AbortSignal, ch: string): Promise<Envelope[]> {
    const out: Envelope[] = []
    for (const name of [STREAM_EVENTS, STREAM_MAILBOX, STREAM_DLQ]) {
      let info
      try {
        info = await this.jsm.streams.info(name)
      } catch {
        continue
      }
      const matched = (info.config.subjects ?? []).some(s => s === ch || (/[*>]/.test(s) && subjectMatch(s, ch)))
      if (!matched) continue
      const cname = `replay-${sessionToken(ch)}`
      await this.jsm.consumers.add(name, { durable_name: cname, filter_subject: ch, ack_policy: 'none', deliver_policy: 'all' }).catch(() => {})
      const consumer = await this.js.consumers.get(name, cname)
      const iter = await consumer.fetch({ max_messages: 1000, expires: 500 })
      for await (const m of iter) {
        try {
          out.push(decode(m.data))
        } catch {
          /* skip malformed */
        }
      }
      break
    }
    return out
  }

  private kv(bucket: string, ttlMs = 0): Promise<KV> {
    const key = `${bucket}:${ttlMs}`
    let p = this.kvCache.get(key)
    if (!p) {
      const kvm = new Kvm(this.nc)
      p = kvm.create(bucket, { ttl: ttlMs > 0 ? ttlMs * 1_000_000 : undefined }).catch(() => kvm.open(bucket))
      this.kvCache.set(key, p)
    }
    return p
  }

  private async object(bucket: string, create: boolean): Promise<NatsObjectStore | null> {
    const objm = new Objm(this.nc)
    if (create) {
      try {
        return await objm.create(bucket, {})
      } catch {
        return objm.open(bucket).catch(() => null)
      }
    }
    return objm.open(bucket).catch(() => null)
  }

  async objectPut(ctx: AbortSignal, name: string, data: Uint8Array): Promise<void> {
    const os = await this.object(OBJECT_BUCKET, true)
    if (!os) throw new Error('object store unavailable')
    await os.putBlob({ name }, data)
  }
  async objectGet(ctx: AbortSignal, name: string): Promise<Uint8Array | null> {
    const os = await this.object(OBJECT_BUCKET, false)
    if (!os) return null
    return os.getBlob(name).catch(() => null)
  }
  async objectPutPersistent(ctx: AbortSignal, name: string, data: Uint8Array): Promise<void> {
    const os = await this.object(OBJECT_BUCKET_DUR, true)
    if (!os) throw new Error('durable object store unavailable')
    await os.putBlob({ name }, data)
  }
  async objectGetPersistent(ctx: AbortSignal, name: string): Promise<Uint8Array | null> {
    const os = await this.object(OBJECT_BUCKET_DUR, false)
    if (!os) return null
    return os.getBlob(name).catch(() => null)
  }

  async kvWatch(ctx: AbortSignal, bucket: string, keys: string): Promise<{ events: AsyncIterable<KvEvent>; stop: () => void }> {
    const kv = await this.kv(bucket)
    const watcher = await kv.watch({ key: keys })
    const events: AsyncIterable<KvEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<KvEvent>> => {
            for await (const e of watcher) {
              if (!e) return { value: { key: '', value: '', revision: 0, deleted: false, isUpdate: false, done: true }, done: false }
              return {
                value: {
                  key: e.key,
                  value: typeof e.string === 'function' ? e.string() : '',
                  revision: e.revision,
                  deleted: e.operation === 'DEL' || e.operation === 'PURGE',
                  isUpdate: true,
                  done: false,
                },
                done: false,
              }
            }
            return { value: undefined, done: true }
          },
        }
      },
    }
    return { events, stop: () => void watcher.stop() }
  }

  async kvCreate(ctx: AbortSignal, bucket: string, key: string, value: string, ttlMs: number): Promise<number> {
    const kv = await this.kv(bucket, ttlMs)
    try {
      return await kv.create(key, value)
    } catch {
      return 0
    }
  }
  async kvPut(ctx: AbortSignal, bucket: string, key: string, value: string, ttlMs: number): Promise<void> {
    const kv = await this.kv(bucket, ttlMs)
    await kv.put(key, value)
  }
  async kvGet(ctx: AbortSignal, bucket: string, key: string): Promise<string> {
    try {
      const kv = await this.kv(bucket)
      const e = await kv.get(key)
      if (!e || e.operation !== 'PUT') return ''
      return e.string()
    } catch {
      return ''
    }
  }
  async kvCas(ctx: AbortSignal, bucket: string, key: string, value: string, revision: number): Promise<number> {
    try {
      const kv = await this.kv(bucket)
      return await kv.update(key, value, revision)
    } catch {
      return 0
    }
  }
  async kvDelete(ctx: AbortSignal, bucket: string, key: string): Promise<void> {
    const kv = await this.kv(bucket)
    await kv.delete(key)
  }

  async close(): Promise<void> {
    await this.nc.drain()
  }
}

class NatsSub implements Subscription {
  constructor(private readonly sub: NatsSubscription, private readonly bus: NatsBus) {}
  async next(ctx: AbortSignal): Promise<Envelope | null> {
    const iter = this.sub[Symbol.asyncIterator]()
    const result = await Promise.race([
      iter.next(),
      new Promise<IteratorResult<Msg>>(resolve => {
        if (ctx.aborted) resolve({ value: undefined as unknown as Msg, done: true })
        else ctx.addEventListener('abort', () => resolve({ value: undefined as unknown as Msg, done: true }), { once: true })
      }),
    ])
    if (result.done || !result.value) return null
    const m = result.value
    try {
      const raw = JSON.parse(new TextDecoder().decode(m.data)) as RawEnvelope
      if (!this.bus['verifyMsg'](m, raw)) return null
      return decode(m.data, m.reply)
    } catch {
      return null
    }
  }
  async close(): Promise<void> {
    await this.sub.unsubscribe()
  }
}

class NatsInboxSub implements InboxSubscription {
  constructor(private readonly consumer: Consumer, private readonly bus: NatsBus) {}
  async next(ctx: AbortSignal): Promise<InboxMsg | null> {
    const iter = await this.consumer.fetch({ max_messages: 1, expires: 2000 })
    for await (const m of iter) {
      let env: Envelope
      try {
        env = decode(m.data)
      } catch {
        m.term()
        return null
      }
      return {
        envelope: env,
        ack: () => m.ack(),
        nak: (delayMs: number) => m.nak(delayMs),
        term: () => {
          void this.bus['js'].publish(dlqSubjectFor(m.subject), m.data, env.id ? { msgID: env.id } : {})
          m.term()
        },
        termNoDLQ: () => m.term(),
      }
    }
    void ctx
    return null
  }
  async close(): Promise<void> {
    /* consumer lifecycle is managed by the stream */
  }
}

/** subjectMatch implements NATS-style `*` / `>` matching. */
export function subjectMatch(pattern: string, subject: string): boolean {
  const p = pattern.split('.')
  const s = subject.split('.')
  let pi = 0
  for (let si = 0; si < s.length; si++) {
    if (pi >= p.length) return false
    const pt = p[pi]!
    if (pt === '>') return true
    if (pt === '*') {
      pi++
      continue
    }
    if (pt !== s[si]) return false
    pi++
  }
  return pi === p.length
}

