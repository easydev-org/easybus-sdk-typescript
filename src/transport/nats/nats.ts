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
  createInbox,
} from '@nats-io/nats-core'
import { connect as natsConnect } from '@nats-io/transport-node'
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager, type Consumer } from '@nats-io/jetstream'
import { Kvm, type KV } from '@nats-io/kv'
import { Objm, type ObjectStore as NatsObjectStore } from '@nats-io/obj'

import { create, toJson, fromJson } from '@bufbuild/protobuf'
import { ValueSchema, type Value } from '@bufbuild/protobuf/wkt'

import type {
  Bus,
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
import {
  EnvelopeSchema,
  Envelope_Kind,
  encodeEnvelope,
  decodeEnvelope,
  envelopeKindString,
  type Envelope,
} from '../../wire.js'
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

/** jsonToValue wraps a JSON body into a google.protobuf.Value. */
function jsonToValue(payload: unknown): Value | undefined {
  if (payload === undefined) return undefined
  return fromJson(ValueSchema, payload as never)
}

/** valueToJson unwraps a google.protobuf.Value back into a plain JSON body. */
export function valueToJson(v: Value | undefined): unknown {
  return v === undefined ? undefined : toJson(ValueSchema, v)
}

/** buildEnvelope assembles the GENERATED Envelope message and encodes it to the
 *  Go-compatible JSON wire form (snake_case + integer enums). */
function buildEnvelope(kind: string, ch: string, payload: unknown, tenant: string, id?: string, sessionName?: string, replyTo?: string): Uint8Array {
  const env = create(EnvelopeSchema, {
    v: 2,
    ch,
    tenant,
    kind: KIND_ENUM_MAP[kind] ?? Envelope_Kind.PUB,
    ...(id ? { id } : {}),
    ...(sessionName ? { sessionName } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(payload !== undefined ? { payload: jsonToValue(payload) } : {}),
  })
  return encodeEnvelope(env)
}

const KIND_ENUM_MAP: Record<string, Envelope_Kind> = {
  req: Envelope_Kind.REQ,
  pub: Envelope_Kind.PUB,
  queue: Envelope_Kind.QUEUE,
}

/** decode parses a Go-compatible JSON envelope into the generated message. */
function decode(data: Uint8Array, reply?: string): Envelope {
  const env = decodeEnvelope(data)
  if (env.v !== 2) throw new Error(`unsupported envelope version ${env.v}`)
  if (reply && !env.replyTo) env.replyTo = reply
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

  /** Build the auth headers, or undefined when identity is disabled (so the
   *  message carries NO header block — an EMPTY header block is not the same as
   *  none, and the Go side sends none). */
  private authHeaders(ch: string, kind: string, id: string, payload: unknown): ReturnType<typeof natsHeaders> | undefined {
    if (!this.idn) return undefined
    const h = natsHeaders()
    const hdr = authHeader(this.idn, { ch, kind, id, payload })
    h.set('easybus-id', hdr.id)
    h.set('easybus-sig', hdr.sig)
    return h
  }

  private verifyMsg(m: Msg, raw: { tenant: string; ch: string; kind: string; id?: string; payload?: unknown }): boolean {
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
      const env = decode(m.data, m.reply)
      if (!this.verifyMsg(m, { tenant: env.tenant, ch: env.ch, kind: envelopeKindString(env), id: env.id, payload: valueToJson(env.payload) })) {
        throw new Error(`identity: signature verification failed on ${m.subject}`)
      }
      return env
    } catch (e) {
      if (ctx.aborted) return null
      throw e
    }
  }

  async requestMany(ctx: AbortSignal, ch: string, payload: unknown, opts: RequestOpts = {}): Promise<Envelope[]> {
    const data = buildEnvelope('req', ch, payload, tenantOf(ch, opts.tenant))
    const maxWait = opts.maxWaitMs && opts.maxWaitMs > 0 ? opts.maxWaitMs : 500
    // Mirror the Go RequestMany exactly: subscribe a fresh inbox, publish the
    // request with reply=inbox, collect replies for maxWaitMs, then stop. This
    // is plain core-NATS request/reply (NOT JetStream), so a client strategy
    // like 'stall' (JetStream-oriented) must NOT be used.
    const inbox = createInbox()
    const sub = this.nc.subscribe(inbox)
    // Flush so the server registers the inbox interest BEFORE we publish: a
    // publish issued right after subscribe can otherwise land before interest
    // is established and its reply is dropped (the Go SDK flushes here too).
    await this.nc.flush()
    const iter = sub[Symbol.asyncIterator]()
    const out: Envelope[] = []
    const env = create(EnvelopeSchema, {
      v: 2,
      ch,
      tenant: tenantOf(ch, opts.tenant),
      kind: Envelope_Kind.REQ,
      replyTo: inbox,
      ...(payload !== undefined ? { payload: jsonToValue(payload) } : {}),
    })
    const bytes = encodeEnvelope(env)
    const h = this.authHeaders(ch, 'req', '', payload)
    // Arm the iterator BEFORE publishing: a reply that arrives before the first
    // next() is buffered by the subscription, but awaiting next() only AFTER the
    // publish races the deadline (and can miss a fast reply). Arm first, then
    // publish, then collect until maxWaitMs elapses.
    const pending = iter.next()
    const pubOpts: { reply: string; headers?: ReturnType<typeof natsHeaders> } = { reply: inbox }
    if (h) pubOpts.headers = h
    this.nc.publish(ch, bytes, pubOpts)
    const deadline = Date.now() + maxWait
    let cur = pending
    try {
      for (;;) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        const result = await Promise.race([
          cur,
          new Promise<{ done: true; value: undefined }>(resolve => setTimeout(() => resolve({ done: true, value: undefined }), remaining)),
        ])
        if (result.done) break
        const m = result.value as Msg
        // Re-arm immediately so the next reply has a waiter.
        cur = iter.next()
        let e: Envelope
        try {
          e = decode(m.data, m.reply)
        } catch {
          continue
        }
        if (!this.verifyMsg(m, { tenant: e.tenant, ch: e.ch, kind: envelopeKindString(e), id: e.id, payload: valueToJson(e.payload) })) continue
        out.push(e)
      }
    } finally {
      await sub.unsubscribe()
    }
    void ctx
    return out
  }

  async publish(ctx: AbortSignal, ch: string, payload: unknown, opts: PublishOpts = {}): Promise<void> {
    const data = buildEnvelope('pub', ch, payload, tenantOf(ch, opts.tenant), undefined, undefined, opts.replyTo)
    const h = this.authHeaders(ch, 'pub', '', payload)
    const pubOpts: { reply?: string; headers?: ReturnType<typeof natsHeaders> } = {}
    if (opts.replyTo) pubOpts.reply = opts.replyTo
    if (h) pubOpts.headers = h
    this.nc.publish(ch, data, pubOpts)
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
    // ONE iterator for the watcher's lifetime (a KV watcher, like a core sub,
    // permits a single concurrent iterator).
    const iter = watcher[Symbol.asyncIterator]()
    const events: AsyncIterable<KvEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<KvEvent>> => {
            const r = await iter.next()
            if (r.done || !r.value) return { value: undefined, done: true }
            const e = r.value
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
  // A SINGLE iterator for the subscription's lifetime: calling
  // `sub[Symbol.asyncIterator]()` per next() throws "iterator is already
  // yielding" (the core subscription only permits one concurrent iterator).
  private readonly iter: AsyncIterator<Msg>
  constructor(private readonly sub: NatsSubscription, private readonly bus: NatsBus) {
    this.iter = sub[Symbol.asyncIterator]()
  }
  async next(ctx: AbortSignal): Promise<Envelope | null> {
    if (ctx.aborted) return null
    // Abort only cancels THIS wait — it must NOT close the subscription, which
    // is long-lived (a discover/tool loop keeps reading). We simply stop waiting
    // and return null; the next next() call re-arms the same iterator.
    const holder: { r: IteratorResult<Msg> | null } = { r: null }
    await Promise.race([
      this.iter.next().then(r => { holder.r = r }),
      new Promise<void>(resolve => {
        if (ctx.aborted) resolve()
        else ctx.addEventListener('abort', () => resolve(), { once: true })
      }),
    ])
    const result = holder.r
    if (result === null || result.done || !result.value) return null
    const m = result.value
    try {
      const env = decode(m.data, m.reply)
      if (!this.bus['verifyMsg'](m, { tenant: env.tenant, ch: env.ch, kind: envelopeKindString(env), id: env.id, payload: valueToJson(env.payload) })) return null
      return env
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

