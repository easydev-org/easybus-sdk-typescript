// The extension role — the TypeScript twin of the Go `easybus-sdk/extension`
// package. An Extension registers on the bus (discovery + tool/variable/config/
// hook/lifecycle/interrupt channels), heartbeats a per-replica presence key,
// and executes tool calls.

import {
  CH_DISCOVER,
  LIFECYCLE_WILDCARD,
  GLOBAL_TENANT,
  chMailbox,
  chSessionEvents,
  chToolProgress,
  newID,
  sessionVarKey,
  subjectTenant,
  tenantObjectName,
  varKey,
  VARS_BUCKET,
  CONFIG_KV_BUCKET,
} from '../protocol/protocol.js'
import type { Bus, Envelope, InboxPublishOpts, Subscription } from '../bus/bus.js'
import { ConfigStore } from './config.js'
import type { Config, LifecycleEvent, ToolErrorCode, ToolResultData, ToolSpec } from './types.js'
import { codeToWire } from '../protocol/code.js'

export * from './types.js'

/** maxToolContentBytes caps a tool's `content` text returned to the agent. */
export const MAX_TOOL_CONTENT_BYTES = 128 * 1024

/** TypedError carries a standard protocol error code from a tool execution. */
export class TypedError extends Error {
  constructor(public code: ToolErrorCode, message: string) {
    super(message)
    this.name = 'TypedError'
  }
}

/** PresenceBucket carries extension liveness. */
export const PRESENCE_BUCKET = 'easybus-presence'
export const PRESENCE_TTL = 15_000
const PRESENCE_INTERVAL = 5_000

/** The cooperative feature set this SDK build speaks. */
export const EASYBUS_FEATURES = ['dlq', 'config-kv', 'presence', 'kv-escaping', 'interrupt-abort', 'progress', 'multitenant']

function sanitizeReplicaId(id: string): string {
  let out = ''
  for (const c of id) out += /[A-Za-z0-9_-]/.test(c) ? c : '-'
  return out === '' ? newID() : out
}

function resolveReplicaId(explicit?: string): string {
  const id = explicit || process.env['EASYBUS_REPLICA_ID'] || process.env['POD_NAME'] || newID()
  return sanitizeReplicaId(id)
}

/** validateHookSchema implements the small declarative JSON-schema subset. */
export function validateHookSchema(schema: Record<string, unknown> | undefined, value: unknown, path: string): string {
  if (!schema) return ''
  const t = schema['type'] as string | undefined
  if (t === 'string' && typeof value !== 'string') return `${path}: expected string, got ${typeof value}`
  if (t === 'number' && typeof value !== 'number') return `${path}: expected number, got ${typeof value}`
  if (t === 'boolean' && typeof value !== 'boolean') return `${path}: expected boolean, got ${typeof value}`
  if (t === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return `${path}: expected object`
    const m = value as Record<string, unknown>
    const req = schema['required'] as unknown[] | undefined
    if (Array.isArray(req)) for (const r of req) if (typeof r === 'string' && !(r in m)) return `${path}: missing required field "${r}"`
    const props = schema['properties'] as Record<string, Record<string, unknown>> | undefined
    if (props) {
      for (const [name, p] of Object.entries(props)) {
        if (name in m) {
          const msg = validateHookSchema(p, m[name], `${path}.${name}`)
          if (msg) return msg
        }
      }
    }
  }
  const enumVals = schema['enum'] as unknown[] | undefined
  if (Array.isArray(enumVals) && !enumVals.some(e => String(e) === String(value))) return `${path}: value not in the declared enum`
  return ''
}

/** The extension-side role. */
export class Extension {
  private subs: Subscription[] = []
  private readonly configStore = new ConfigStore()
  readonly replicaId: string
  /** The discovery manifest. */
  manifest: Record<string, unknown>
  /** in-flight tool calls per tenant\x00session, so interrupt can cancel them. */
  private inflight = new Map<string, Map<string, AbortController>>()

  constructor(private readonly b: Bus, private readonly cfg: Config) {
    this.replicaId = resolveReplicaId(cfg.replicaId)
    this.manifest = this.buildManifest()
  }

  private buildManifest(): Record<string, unknown> {
    const caps: string[] = []
    const tools: Array<Record<string, unknown>> = []
    for (const [name, spec] of Object.entries(this.cfg.tools ?? {})) {
      tools.push({ name, description: spec.description ?? '', descriptions: spec.descriptions ?? {}, input_schema: spec.inputSchema ?? {}, required_config: spec.requiredConfig ?? [] })
    }
    if (tools.length > 0) caps.push('tools')
    const promptVariables: Array<Record<string, unknown>> = []
    for (const [name, spec] of Object.entries(this.cfg.variables ?? {})) {
      promptVariables.push({ name, description: spec.description ?? '', descriptions: spec.descriptions ?? {}, scope: spec.scope || 'global' })
    }
    if (promptVariables.length > 0) caps.push('prompt')
    const config: Array<Record<string, unknown>> = []
    for (const [name, spec] of Object.entries(this.cfg.config ?? {})) {
      config.push({
        name,
        type: spec.type,
        kind: spec.kind || 'value',
        ...(spec.capability ? { capability: spec.capability } : {}),
        ...(spec.description ? { description: spec.description } : {}),
        descriptions: spec.descriptions ?? {},
        enum_values: spec.enumValues ?? [],
        ...(spec.default !== undefined ? { default: spec.default } : {}),
        scope: spec.scope || 'global',
      })
    }
    const m: Record<string, unknown> = {
      id: this.cfg.id,
      version: this.cfg.version,
      capabilities: caps,
      features: EASYBUS_FEATURES,
      config,
      tools,
      prompt_variables: promptVariables,
      lifecycle: this.cfg.lifecycle ?? [],
    }
    if ((this.cfg.callHooks?.length ?? 0) > 0 || (this.cfg.eventHooks?.length ?? 0) > 0) {
      m.hooks = { call: this.cfg.callHooks ?? [], event: this.cfg.eventHooks ?? [], call_schemas: this.cfg.hookSchemas?.call ?? {}, event_schemas: this.cfg.hookSchemas?.event ?? {} }
    }
    return m
  }

  /** Serve registers every channel. */
  async serve(ctx: AbortSignal): Promise<void> {
    this.startPresence(ctx)
    await this.serveDiscovery(ctx)
    await this.serveConfig(ctx)
    await this.serveTools(ctx)
    await this.serveVariables(ctx)
    await this.serveCallHooks(ctx)
    await this.serveEventHooks(ctx)
    await this.serveLifecycle(ctx)
    await this.serveInterrupt(ctx)
  }

  async close(): Promise<void> {
    for (const s of this.subs) await s.close()
    this.subs = []
    await this.b.kvDelete(AbortSignal.timeout(2000), PRESENCE_BUCKET, this.presenceKey()).catch(() => {})
    await this.b.close()
  }

  private presenceKey(): string {
    return `${this.cfg.id}.${this.replicaId}`
  }

  private startPresence(ctx: AbortSignal): void {
    const put = () => {
      void this.b.kvPut(ctx, PRESENCE_BUCKET, this.presenceKey(), JSON.stringify(this.manifest), PRESENCE_TTL).catch(() => {})
    }
    put()
    const timer = setInterval(put, PRESENCE_INTERVAL)
    ctx.addEventListener('abort', () => clearInterval(timer), { once: true })
  }

  /** ReportProgress reports in-flight progress for a tool call. */
  async reportProgress(ctx: AbortSignal, tenant: string, callId: string, progress: Record<string, unknown>): Promise<void> {
    await this.b.publish(ctx, chToolProgress(tenant, callId), { call_id: callId, ...progress }, { tenant })
  }

  private async serveDiscovery(ctx: AbortSignal): Promise<void> {
    const sub = await this.b.subscribe(ctx, CH_DISCOVER, { queue: this.cfg.id })
    this.subs.push(sub)
    void (async () => {
      for (;;) {
        const env = await sub.next(ctx)
        if (!env) return
        if (env.replyTo) await this.b.publish(ctx, env.replyTo, this.manifest, { tenant: GLOBAL_TENANT })
      }
    })()
  }

  private async serveTools(ctx: AbortSignal): Promise<void> {
    for (const [name, spec] of Object.entries(this.cfg.tools ?? {})) {
      const sub = await this.b.subscribe(ctx, `easybus.*.tool.call.${this.cfg.id}.${name}`, { queue: this.cfg.id })
      this.subs.push(sub)
      void (async () => {
        for (;;) {
          const env = await sub.next(ctx)
          if (!env) return
          if (!env.replyTo) continue
          void this.handleToolCall(ctx, name, spec, env)
        }
      })()
    }
  }

  private async handleToolCall(ctx: AbortSignal, name: string, spec: ToolSpec, env: Envelope): Promise<void> {
    const replyTo = env.replyTo ?? ''
    const call = env.payload as { call_id?: string; arguments?: Record<string, unknown> }
    if (!call || replyTo === '') return
    const sessionName = env.sessionName ?? ''
    const tenant = env.tenant || subjectTenant(env.ch)
    const callCtl = new AbortController()
    ctx.addEventListener('abort', () => callCtl.abort(), { once: true })
    if (sessionName !== '') this.trackInflight(tenant, sessionName, call.call_id ?? '', callCtl)
    const res: Record<string, unknown> = { call_id: call.call_id, tool: name }
    try {
      const data = await spec.execute(callCtl.signal, call.arguments ?? {}, call.call_id ?? '', sessionName, tenant)
      if (data.content !== undefined && Buffer.byteLength(data.content, 'utf8') > MAX_TOOL_CONTENT_BYTES) {
        res.error = { code: codeToWire('CODE_INVALID_ARGUMENT'), message: `tool '${name}' returned ${Buffer.byteLength(data.content, 'utf8')} bytes of text, over the ${MAX_TOOL_CONTENT_BYTES}-byte limit; return large data as a file (data.files) instead` }
      } else if (data.content !== undefined && data.content !== '') {
        res.content = data.content
      }
      if (res.error === undefined && data.data !== undefined) res.data = data.data
      if (res.error === undefined && data.object !== undefined) res.object = { id: data.object.id, content_type: data.object.contentType }
    } catch (e) {
      const code = e instanceof TypedError ? e.code : 'CODE_INTERNAL'
      res.error = { code: codeToWire(code), message: e instanceof Error ? e.message : String(e) }
    }
    this.untrackInflight(tenant, sessionName, call.call_id ?? '')
    await this.b.publish(AbortSignal.timeout(5000), replyTo, res, { tenant })
  }

  private async serveVariables(ctx: AbortSignal): Promise<void> {
    for (const [name, spec] of Object.entries(this.cfg.variables ?? {})) {
      const sub = await this.b.subscribe(ctx, `easybus.*.var.${this.cfg.id}.${name}`, { queue: this.cfg.id })
      this.subs.push(sub)
      void (async () => {
        for (;;) {
          const env = await sub.next(ctx)
          if (!env) return
          if (!env.replyTo || !spec.resolve) continue
          const tenant = env.tenant || subjectTenant(env.ch)
          const v = await spec.resolve(ctx, env.sessionName ?? '', tenant).catch(() => '')
          await this.b.publish(ctx, env.replyTo, { name, value: v }, { tenant })
        }
      })()
    }
  }

  private async serveCallHooks(ctx: AbortSignal): Promise<void> {
    for (const hook of this.cfg.callHooks ?? []) {
      const sub = await this.b.subscribe(ctx, `easybus.*.hook.call.${this.cfg.id}.${hook}`, { queue: this.cfg.id })
      this.subs.push(sub)
      void (async () => {
        for (;;) {
          const env = await sub.next(ctx)
          if (!env) return
          if (!env.replyTo) continue
          const call = env.payload as { session_name?: string; arguments?: Record<string, unknown> }
          const sessionName = call.session_name || env.sessionName || ''
          const tenant = env.tenant || subjectTenant(env.ch)
          const args = call.arguments ?? {}
          let res: { ok: boolean; data?: unknown; error?: { code: ToolErrorCode; message: string } }
          const msg = validateHookSchema(this.cfg.hookSchemas?.call?.[hook], args, 'arguments')
          if (msg) res = { ok: false, error: { code: codeToWire('CODE_INVALID_ARGUMENT') as unknown as ToolErrorCode, message: msg } }
          else if (!this.cfg.onCallHook) res = { ok: false, error: { code: codeToWire('CODE_NOT_FOUND') as unknown as ToolErrorCode, message: `no handler for hook ${hook}` } }
          else res = await this.cfg.onCallHook(ctx, hook, sessionName, args, tenant).catch(e => ({ ok: false, error: { code: codeToWire('CODE_INTERNAL') as unknown as ToolErrorCode, message: e instanceof Error ? e.message : String(e) } }))
          await this.b.publish(ctx, env.replyTo, res, { tenant })
        }
      })()
    }
  }

  private async serveEventHooks(ctx: AbortSignal): Promise<void> {
    for (const hook of this.cfg.eventHooks ?? []) {
      const sub = await this.b.subscribe(ctx, `easybus.*.hook.event.${hook}`, { queue: this.cfg.id })
      this.subs.push(sub)
      void (async () => {
        for (;;) {
          const env = await sub.next(ctx)
          if (!env) return
          const ev = env.payload as { session_name?: string; payload?: unknown }
          const sessionName = ev.session_name || env.sessionName || ''
          const tenant = env.tenant || subjectTenant(env.ch)
          if (validateHookSchema(this.cfg.hookSchemas?.event?.[hook], ev.payload, 'payload')) continue
          if (this.cfg.onEventHook) await this.cfg.onEventHook(ctx, hook, sessionName, ev.payload, tenant).catch(() => {})
        }
      })()
    }
  }

  private async serveLifecycle(ctx: AbortSignal): Promise<void> {
    if (!this.cfg.lifecycle || this.cfg.lifecycle.length === 0 || !this.cfg.onLifecycle) return
    const wanted = new Set(this.cfg.lifecycle)
    const sub = await this.b.subscribe(ctx, `${LIFECYCLE_WILDCARD}>`, { queue: this.cfg.id })
    this.subs.push(sub)
    void (async () => {
      for (;;) {
        const env = await sub.next(ctx)
        if (!env) return
        const ev = env.payload as LifecycleEvent
        const tenant = env.tenant || subjectTenant(env.ch)
        if (!wanted.has(ev.kind)) continue
        if (ev.kind === 'deleted') await this.deleteSessionVariables(ctx, tenant, ev.sessionName).catch(() => {})
        await this.cfg.onLifecycle!(ctx, ev, tenant).catch(() => {})
      }
    })()
  }

  private async serveInterrupt(ctx: AbortSignal): Promise<void> {
    const sub = await this.b.subscribe(ctx, `easybus.*.ctl.interrupt.${this.cfg.id}`, { queue: this.cfg.id })
    this.subs.push(sub)
    void (async () => {
      for (;;) {
        const env = await sub.next(ctx)
        if (!env) return
        const sig = env.payload as { session_name?: string; reason?: string }
        const sessionName = sig.session_name ?? env.sessionName ?? ''
        const tenant = env.tenant || subjectTenant(env.ch)
        if (sessionName !== '') this.cancelInflight(tenant, sessionName)
        else if (tenant !== '') this.cancelTenantInflight(tenant)
        else this.cancelAllInflight()
        if (this.cfg.onInterrupt) this.cfg.onInterrupt(ctx, sessionName, sig.reason ?? '', tenant)
        else if (this.cfg.onEventHook) await this.cfg.onEventHook(ctx, 'interrupt', sessionName, sig.reason, tenant).catch(() => {})
      }
    })()
  }

  private inflightKey(tenant: string, session: string): string {
    return `${tenant}\x00${session}`
  }
  private trackInflight(tenant: string, session: string, callId: string, ctl: AbortController): void {
    const k = this.inflightKey(tenant, session)
    let m = this.inflight.get(k)
    if (!m) {
      m = new Map()
      this.inflight.set(k, m)
    }
    m.set(callId, ctl)
  }
  private untrackInflight(tenant: string, session: string, callId: string): void {
    if (session === '') return
    const m = this.inflight.get(this.inflightKey(tenant, session))
    if (m) {
      m.delete(callId)
      if (m.size === 0) this.inflight.delete(this.inflightKey(tenant, session))
    }
  }
  private cancelInflight(tenant: string, session: string): void {
    const k = this.inflightKey(tenant, session)
    const m = this.inflight.get(k)
    this.inflight.delete(k)
    m?.forEach(c => c.abort())
  }
  private cancelTenantInflight(tenant: string): void {
    const prefix = `${tenant}\x00`
    for (const [k, m] of [...this.inflight]) {
      if (k.startsWith(prefix)) {
        this.inflight.delete(k)
        m.forEach(c => c.abort())
      }
    }
  }
  private cancelAllInflight(): void {
    const all = this.inflight
    this.inflight = new Map()
    for (const m of all.values()) m.forEach(c => c.abort())
  }

  // ---- session-facing helpers ---------------------------------------------

  async publishSessionEvent(ctx: AbortSignal, tenant: string, sessionName: string, event: string, params: unknown): Promise<void> {
    const id = newID()
    await this.b.inboxPublish(ctx, chSessionEvents(tenant, sessionName), { event, params, eid: id }, { id, sessionName, tenant })
  }

  async publishMailboxEvent(ctx: AbortSignal, tenant: string, sessionName: string, eventType: string, payload: unknown, source?: string): Promise<void> {
    const id = newID()
    const body: Record<string, unknown> = { id, type: eventType || 'event', payload }
    if (source) body.source = source
    const opts: InboxPublishOpts = { id, sessionName, tenant }
    await this.b.inboxPublish(ctx, chMailbox(tenant, sessionName), body, opts)
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

  async setVariable(ctx: AbortSignal, tenant: string, name: string, value: string): Promise<void> {
    await this.b.kvPut(ctx, VARS_BUCKET, varKey(tenant, this.cfg.id, name), value, 0)
  }
  async setSessionVariable(ctx: AbortSignal, tenant: string, sessionName: string, name: string, value: string): Promise<void> {
    await this.b.kvPut(ctx, VARS_BUCKET, sessionVarKey(tenant, this.cfg.id, sessionName, name), value, 0)
  }
  async deleteSessionVariables(ctx: AbortSignal, tenant: string, sessionName: string): Promise<void> {
    for (const [name, spec] of Object.entries(this.cfg.variables ?? {})) {
      if (spec.scope !== 'session') continue
      await this.b.kvDelete(ctx, VARS_BUCKET, sessionVarKey(tenant, this.cfg.id, sessionName, name)).catch(() => {})
    }
  }
  async getSessionVariable(ctx: AbortSignal, tenant: string, provider: string, sessionName: string, name: string, fallback: string): Promise<string> {
    if (sessionName === '') return fallback
    const v = await this.b.kvGet(ctx, VARS_BUCKET, sessionVarKey(tenant, provider, sessionName, name)).catch(() => '')
    return v === '' ? fallback : v
  }

  /** The effective config value (session > global > default) for a tenant. */
  getConfig(tenant: string, name: string, sessionName: string): unknown {
    return this.configStore.get(this.cfg.config ?? {}, tenant, name, sessionName)
  }

  private async serveConfig(ctx: AbortSignal): Promise<void> {
    if (!this.cfg.config || Object.keys(this.cfg.config).length === 0) return
    try {
      const w = await this.b.kvWatch(ctx, CONFIG_KV_BUCKET, `t.*.${this.cfg.id}.>`)
      void (async () => {
        for await (const ev of w.events) this.applyConfigKV(ev)
      })()
      ctx.addEventListener('abort', () => w.stop(), { once: true })
    } catch {
      /* no bucket yet */
    }
    const sub = await this.b.subscribe(ctx, `easybus.*.config.${this.cfg.id}`, { queue: this.cfg.id })
    this.subs.push(sub)
    void (async () => {
      for (;;) {
        const env = await sub.next(ctx)
        if (!env) return
        if (!env.replyTo) continue
        const set = env.payload as { name: string; scope?: string; value: unknown; session_name?: string; ack?: boolean }
        const tenant = env.tenant || subjectTenant(env.ch)
        this.configStore.applySet(this.cfg.config ?? {}, tenant, set.name, set.value, set.scope === 'session' ? set.session_name : undefined)
        let rejectErr: Error | null = null
        if (this.cfg.onConfigChange) {
          rejectErr = await this.cfg.onConfigChange(ctx, set.name, set.value, set.session_name ?? '', (n, s) => this.configStore.get(this.cfg.config ?? {}, tenant, n, s)).then(() => null).catch(e => (e instanceof Error ? e : new Error(String(e))))
        }
        if (rejectErr) this.configStore.rollbackSet(this.cfg.config ?? {}, tenant, set.name, set.scope === 'session' ? set.session_name : undefined)
        if (set.ack) {
          await this.b.publish(ctx, env.replyTo, rejectErr ? { ok: false, error: { code: codeToWire('CODE_INTERNAL'), message: rejectErr.message } } : { ok: true }, { tenant })
        }
      }
    })()
  }

  private applyConfigKV(ev: { key: string; value: string; deleted: boolean }): void {
    const segs = ev.key.split('.')
    if (segs.length < 3 || segs[0] !== 't') return
    const tenant = segs[1]!
    let rest = segs.slice(2).join('.')
    if (rest.startsWith(`${this.cfg.id}.`)) rest = rest.slice(this.cfg.id.length + 1)
    const parts = rest.split('.')
    let value: unknown = undefined
    if (!ev.deleted) {
      try {
        const parsed = JSON.parse(ev.value) as unknown
        value = parsed && typeof parsed === 'object' && 'v' in (parsed as object) ? (parsed as { v: unknown }).v : parsed
      } catch {
        return
      }
      if (value === undefined || value === null) return
    }
    if (parts.length === 1) this.configStore.setGlobal(tenant, parts[0]!, value, ev.deleted)
    else if (parts.length >= 2) this.configStore.setSession(tenant, parts[0]!, parts.slice(1).join('.'), value, ev.deleted)
  }
}
