// The agent role — the TypeScript twin of the Go `easybus-sdk/agent` package.
// Discovers extensions (presence-first, broadcast fallback), calls tools,
// resolves variables, fires hooks, interrupts, and drives the mailbox.

import type { Bus, Subscription } from '../bus/bus.js'
import { ConfigAuthority } from './config.js'
export { ConfigError } from './config.js'
import { SessionLease } from './lease.js'
export { LEASE_BUCKET, LEASE_TTL_DEFAULT_MS } from './lease.js'
import type { Envelope, ExtensionManifest } from '../wire.js'
export type { ExtensionManifest }
import { valueToJson } from '../transport/nats/nats.js'
import { codeFromWire } from '../protocol/code.js'
import {
  CH_DISCOVER,
  GLOBAL_TENANT,
  chHookCall,
  chHookEvent,
  chInterrupt,
  chInterruptAll,
  chLifecycle,
  chMailbox,
  chSessionEvents,
  chToolCall,
  newID,
  sessionVarKey,
  subjectTenant,
  tenantObjectName,
  varKey,
  VARS_BUCKET,
} from '../protocol/protocol.js'

/** PresenceBucket carries extension liveness (mirrors the extension side). */
const PRESENCE_BUCKET = 'easybus-presence'

/** ToolResult is the agent-side view of a tool outcome. */
export interface ToolResult {
  content: string
  data?: unknown
  metadata?: unknown
  object?: { id: string; contentType?: string }
  error?: { code: string; message: string }
}

/** A delivered mailbox message. */
export interface MailboxMessage {
  id: string
  type: string
  source?: string
  payload?: unknown
  sessionName: string
  tenant: string
}

/** The agent-side role. */
export class Agent {
  private manifestCache = new Map<string, ExtensionManifest>()
  /** livePresenceKeys[extId] = set of unexpired presence KV keys. */
  private livePresenceKeys = new Map<string, Set<string>>()
  private presenceStarted = false
  private presenceWatch: { stop: () => void } | null = null
  private configAuthority: ConfigAuthority | null = null
  private readonly lease: SessionLease

  constructor(private readonly b: Bus) {
    this.lease = new SessionLease(b)
  }

  /** ClaimSession atomically claims the session's run lease (revision or null). */
  claimSession(ctx: AbortSignal, tenant: string, sessionName: string, ttlMs?: number): Promise<number | null> {
    return this.lease.claim(ctx, tenant, sessionName, ttlMs)
  }
  /** RenewSession extends the lease via CAS (new revision or null). */
  renewSession(ctx: AbortSignal, tenant: string, sessionName: string, revision: number, ttlMs?: number): Promise<number | null> {
    return this.lease.renew(ctx, tenant, sessionName, revision, ttlMs)
  }
  /** ReleaseSession frees the run lease. */
  releaseSession(ctx: AbortSignal, tenant: string, sessionName: string): Promise<void> {
    return this.lease.release(ctx, tenant, sessionName)
  }
  /** IsSessionRunning reports whether the run lease is held. */
  isSessionRunning(ctx: AbortSignal, tenant: string, sessionName: string): Promise<boolean> {
    return this.lease.isRunning(ctx, tenant, sessionName)
  }
  /** WithSessionLease runs fn under the exclusive cross-replica lease. */
  withSessionLease(ctx: AbortSignal, tenant: string, sessionName: string, fn: (ctx: AbortSignal) => Promise<void>, ttlMs?: number): Promise<{ acquired: boolean; lost?: boolean }> {
    return this.lease.withSessionLease(ctx, tenant, sessionName, fn, ttlMs)
  }

  /** ServeConfig turns the agent into the config authority (idempotent). */
  serveConfig(defaultAck: boolean): void {
    if (!this.configAuthority) this.configAuthority = new ConfigAuthority(this.b, defaultAck)
    this.configAuthority.started = true
  }

  /** SetConfig validates against the manifest, persists, then delivers. */
  async setConfig(ctx: AbortSignal, tenant: string, extId: string, name: string, value: unknown, sessionName = '', manifest?: ExtensionManifest, ack?: boolean): Promise<void> {
    if (!this.configAuthority || !this.configAuthority.started) {
      throw new Error('invalid_argument: ServeConfig() was not called')
    }
    const m = manifest ?? this.manifest(extId)
    if (!m) throw new Error(`not_found: no manifest for ${extId}; Discover() first`)
    await this.configAuthority.declare(tenant, m)
    await this.configAuthority.set(ctx, tenant, extId, name, value, sessionName, ack)
  }

  /** DropSessionConfig removes per-session overrides when a session ends. */
  async dropSessionConfig(ctx: AbortSignal, tenant: string, extId: string, sessionName: string): Promise<void> {
    await this.configAuthority?.dropSessionConfig(ctx, tenant, extId, sessionName)
  }

  bus(): Bus {
    return this.b
  }

  /** ExtSupports reports whether a discovered extension advertises a feature. */
  extSupports(extId: string, feature: string): boolean {
    const m = this.manifestCache.get(extId)
    return !!m && (m.features ?? []).includes(feature)
  }

  /** Manifest returns the cached manifest for extId, or null when offline. */
  manifest(extId: string): ExtensionManifest | null {
    return this.manifestCache.get(extId) ?? null
  }

  /** Discover collects every reachable extension manifest (presence-first). */
  async discover(ctx: AbortSignal, maxWaitMs: number): Promise<ExtensionManifest[]> {
    await this.ensurePresence(ctx)
    if (this.manifestCache.size > 0) return [...this.manifestCache.values()]
    const replies = await this.b.requestMany(ctx, CH_DISCOVER, {}, { maxWaitMs, tenant: GLOBAL_TENANT })
    const seen = new Set<string>()
    const out: ExtensionManifest[] = []
    for (const r of replies) {
      const m = valueToJson(r.payload) as ExtensionManifest
      if (!m || !m.id || seen.has(m.id)) continue
      seen.add(m.id)
      this.cacheManifest(m)
      out.push(m)
    }
    return out
  }

  /** ensurePresence starts the presence watcher once (retryable on failure). */
  private async ensurePresence(ctx: AbortSignal): Promise<void> {
    if (this.presenceStarted) return
    this.presenceStarted = true
    try {
      const w = await this.b.kvWatch(ctx, PRESENCE_BUCKET, '>')
      this.presenceWatch = w
      void (async () => {
        for await (const ev of w.events) this.applyPresenceEvent(ev)
      })()
    } catch {
      this.presenceStarted = false // allow a later retry
    }
  }

  private applyPresenceEvent(ev: { key: string; value: string; deleted: boolean; done: boolean }): void {
    if (ev.done || ev.key === '') return
    const extId = ev.key.includes('.') ? ev.key.slice(0, ev.key.indexOf('.')) : ev.key
    if (ev.deleted) {
      this.forgetPresenceKey(extId, ev.key)
      return
    }
    try {
      const m = JSON.parse(ev.value) as ExtensionManifest
      if (m && m.id) this.cacheManifest(m)
    } catch {
      return
    }
    this.trackPresenceKey(extId, ev.key)
  }

  private cacheManifest(m: ExtensionManifest): void {
    this.manifestCache.set(m.id, m)
  }

  private trackPresenceKey(extId: string, key: string): void {
    let set = this.livePresenceKeys.get(extId)
    if (!set) {
      set = new Set()
      this.livePresenceKeys.set(extId, set)
    }
    set.add(key)
  }

  private forgetPresenceKey(extId: string, key: string): void {
    const set = this.livePresenceKeys.get(extId)
    if (!set) return
    set.delete(key)
    if (set.size === 0) {
      this.livePresenceKeys.delete(extId)
      this.manifestCache.delete(extId)
    }
  }

  /** CallTool calls one tool and returns its result. */
  async callTool(ctx: AbortSignal, tenant: string, sessionName: string, extId: string, tool: string, callId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const reply = await this.b.request(ctx, chToolCall(tenant, extId, tool), { call_id: callId, arguments: args }, { sessionName, tenant })
    if (!reply) throw new Error(`tool "${tool}": no reply`)
    const tr = valueToJson(reply.payload) as { content?: string; data?: unknown; metadata?: unknown; error?: { code: string | number; message: string }; object?: { id: string; content_type?: string } }
    const r: ToolResult = { content: tr.content ?? '', data: tr.data, metadata: tr.metadata }
    if (tr.error) r.error = { code: codeFromWire(tr.error.code as unknown as string | number), message: tr.error.message }
    if (tr.object) r.object = { id: tr.object.id, ...(tr.object.content_type ? { contentType: tr.object.content_type } : {}) }
    return r
  }

  /** ResolveVariable resolves a template variable (KV-first, lazy fallback). */
  async resolveVariable(ctx: AbortSignal, tenant: string, sessionName: string, provider: string, name: string): Promise<[string, boolean]> {
    const cached = await this.b.kvGet(ctx, VARS_BUCKET, sessionVarKey(tenant, provider, sessionName, name)).catch(() => '')
    if (cached !== '') return [cached, true]
    const cachedGlobal = await this.b.kvGet(ctx, VARS_BUCKET, varKey(tenant, provider, name)).catch(() => '')
    if (cachedGlobal !== '') return [cachedGlobal, true]
    const reply = await this.b.request(ctx, `easybus.${tenant}.var.${provider}.${name}`, {}, { sessionName, tenant })
    if (!reply) return ['', false]
    const v = valueToJson(reply.payload) as { value?: string }
    return [v.value ?? '', true]
  }

  /** CallHook fires a synchronous call hook. */
  async callHook(ctx: AbortSignal, tenant: string, extId: string, hook: string, sessionName: string, args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } } | null> {
    const reply = await this.b.request(ctx, chHookCall(tenant, extId, hook), { hook, session_name: sessionName, arguments: args }, { sessionName, tenant })
    if (!reply) return null
    const r = valueToJson(reply.payload) as { ok: boolean; data?: unknown; error?: { code: string | number; message: string } }
    // Decode the wire error code (a proto enum number) back to its name.
    return {
      ok: r.ok,
      ...(r.data !== undefined ? { data: r.data } : {}),
      ...(r.error ? { error: { code: codeFromWire(r.error.code), message: r.error.message } } : {}),
    }
  }

  /** Interrupt aborts every in-flight tool call of one tenant's extension. */
  async interrupt(ctx: AbortSignal, tenant: string, extId: string): Promise<void> {
    await this.b.publish(ctx, chInterrupt(tenant, extId), {}, { tenant })
  }

  /** InterruptSession aborts the in-flight calls of one session. */
  async interruptSession(ctx: AbortSignal, tenant: string, extId: string, sessionName: string, reason?: string): Promise<void> {
    await this.b.publish(ctx, chInterrupt(tenant, extId), { session_name: sessionName, ...(reason ? { reason } : {}) }, { tenant })
  }

  /** PublishLifecycleEvent publishes a session lifecycle event. */
  async publishLifecycleEvent(ctx: AbortSignal, tenant: string, kind: string, sessionName: string, payload?: unknown): Promise<void> {
    await this.b.publish(ctx, chLifecycle(tenant, kind), { kind, session_name: sessionName, ...(payload !== undefined ? { payload } : {}) }, { tenant })
  }

  /** PublishEventHook publishes an async event hook. */
  async publishEventHook(ctx: AbortSignal, tenant: string, hook: string, sessionName: string, payload: unknown): Promise<void> {
    await this.b.publish(ctx, chHookEvent(tenant, hook), { hook, session_name: sessionName, payload }, { tenant })
  }

  /** SubscribeProgress subscribes to a tool call's progress channel. */
  subscribeProgress(ctx: AbortSignal, tenant: string, callId: string): Promise<Subscription> {
    return this.b.subscribe(ctx, `easybus.${tenant}.tool.progress.${callId}`)
  }

  /** PublishMailbox publishes a message to a session's durable mailbox. */
  async publishMailbox(ctx: AbortSignal, tenant: string, sessionName: string, typ: string, payload: unknown, source?: string): Promise<void> {
    const id = newID()
    const body: Record<string, unknown> = { id, type: typ, payload }
    if (source) body.source = source
    await this.b.inboxPublish(ctx, chMailbox(tenant, sessionName), body, { id, sessionName, tenant })
  }

  /** PublishSessionEvent pushes one event onto the session's durable stream. */
  async publishSessionEvent(ctx: AbortSignal, tenant: string, sessionName: string, event: string, params: unknown): Promise<void> {
    const id = newID()
    await this.b.inboxPublish(ctx, chSessionEvents(tenant, sessionName), { event, params, eid: id }, { id, sessionName, tenant })
  }

  /**
   * ConsumeMailbox consumes the mailbox wildcard, routing each message to its
   * session and acking on success. Returns a stop func.
   */
  async consumeMailbox(ctx: AbortSignal, handler: (m: MailboxMessage) => Promise<void>): Promise<() => void> {
    const sub = await this.b.inboxConsume(ctx, { subject: 'easybus.*.mailbox.>' })
    let stopped = false
    void (async () => {
      while (!stopped) {
        const m = await sub.next(ctx)
        if (!m) return
        const env = m.envelope
        const tenant = env.tenant || subjectTenant(env.ch)
        const body = valueToJson(env.payload) as { id?: string; type?: string; source?: string; payload?: unknown }
        const msg: MailboxMessage = {
          id: body.id ?? env.id ?? '',
          type: body.type ?? '',
          ...(body.source ? { source: body.source } : {}),
          payload: body.payload,
          sessionName: env.sessionName ?? '',
          tenant,
        }
        try {
          await handler(msg)
          m.ack()
        } catch {
          m.nak(1000)
        }
      }
    })()
    return () => {
      stopped = true
      void sub.close()
    }
  }

  async putObject(ctx: AbortSignal, tenant: string, name: string, data: Uint8Array): Promise<void> {
    await this.b.objectPut(ctx, tenantObjectName(tenant, name), data)
  }
  async getObject(ctx: AbortSignal, tenant: string, name: string): Promise<Uint8Array | null> {
    return this.b.objectGet(ctx, tenantObjectName(tenant, name))
  }
  async putObjectPersistent(ctx: AbortSignal, tenant: string, name: string, data: Uint8Array): Promise<void> {
    await this.b.objectPutPersistent(ctx, tenantObjectName(tenant, name), data)
  }
  async getObjectPersistent(ctx: AbortSignal, tenant: string, name: string): Promise<Uint8Array | null> {
    return this.b.objectGetPersistent(ctx, tenantObjectName(tenant, name))
  }

  async close(): Promise<void> {
    this.presenceWatch?.stop()
    await this.b.close()
  }

  /**
   * consumeDLQ subscribes to every dead-letter message and hands each to `handler`.
   *
   * Dead letters are messages a consumer gave up on after repeated failures. Without this, they
   * accumulate in the DLQ stream and nobody finds out — the failure is real but silent, which is
   * the worst combination. Returns a stop function.
   *
   * The handler returning false means "leave it in the DLQ" (it is nacked and retried later);
   * returning true acks it. A message that cannot be resolved to a tenant or session is
   * TERMINATED rather than dead-lettered again: dead letters of dead letters help nobody.
   */
  async consumeDLQ(
    ctx: AbortSignal,
    handler: (m: { id: string; tenant: string; sessionName: string; type: string; payload: unknown }) => boolean | Promise<boolean>,
  ): Promise<() => void> {
    const sub = await this.b.inboxConsume(ctx, { subject: 'easybus.*.dlq.>' })
    let stopped = false
    void (async () => {
      for (;;) {
        if (stopped) return
        const msg = await sub.next(ctx)
        if (msg === null) return
        const env = msg.envelope
        const sessionName = env.sessionName ?? ''
        const tenant = env.tenant || subjectTenant(env.ch)
        const m = valueToJson(env.payload) as { id?: string; type?: string; payload?: unknown }
        if (sessionName === '' || tenant === '' || env.id === undefined || m?.id === undefined) {
          // A dead letter with no address cannot be retried meaningfully.
          msg.termNoDLQ()
          continue
        }
        const ok = await handler({
          id: m.id,
          tenant,
          sessionName,
          type: m.type ?? '',
          payload: m.payload,
        })
        if (ok) msg.ack()
        else msg.nak(5000)
      }
    })()
    return () => {
      stopped = true
      void sub.close()
    }
  }
}

export { chInterruptAll }
