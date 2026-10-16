// The agent-side config authority — the TS twin of the Go `agent/config.go`.
// It validates writes against manifest declarations, mirrors values into the
// `cfg` KV bucket, and delivers changes to extensions as 1:1 reqs (optional
// ack).

import { create } from '@bufbuild/protobuf'
import { ValueSchema } from '@bufbuild/protobuf/wkt'
import type { Bus } from '../bus/bus.js'
import {
  CONFIG_KV_BUCKET,
  chConfig,
  escapeKVSegment,
  tenantKVKey,
} from '../protocol/protocol.js'
import {
  ConfigSetSchema,
  type ConfigSet,
  type ExtensionConfigItem,
  type ExtensionManifest,
} from '../wire.js'
import { valueToJson } from '../transport/nats/nats.js'
import { jsonToValue } from '../wire.js'

/** ConfigError is the typed error set by agent-side config operations. */
export class ConfigError extends Error {
  constructor(public code: 'invalid_argument' | 'not_found' | 'retryable', message: string) {
    super(`${code}: ${message}`)
    this.name = 'ConfigError'
  }
}

interface ConfigValue {
  revision: number
  value: unknown
}

interface ConfigKVEnvelope {
  r: number
  v: unknown
}

function decodeConfigEnvelope(raw: string): ConfigKVEnvelope | null {
  try {
    const env = JSON.parse(raw) as ConfigKVEnvelope
    if (env && env.v !== undefined && env.v !== null) return env
  } catch {
    /* fall through */
  }
  try {
    const v = JSON.parse(raw)
    return { r: 0, v }
  } catch {
    return null
  }
}

function configKVKey(tenant: string, extId: string, scope: string, sessionName: string, name: string): string {
  if (scope === 'session') return tenantKVKey(tenant, `${extId}.${escapeKVSegment(sessionName)}.${name}`)
  return tenantKVKey(tenant, `${extId}.${name}`)
}

/** validateConfigValue mirrors the Go validator. Returns '' when valid. */
function validateConfigValue(item: ExtensionConfigItem, value: unknown): string {
  switch (item.type) {
    case 'string':
      if (typeof value !== 'string') return `expected string, got ${typeof value}`
      break
    case 'number':
      if (typeof value !== 'number') return `expected number, got ${typeof value}`
      break
    case 'boolean':
      if (typeof value !== 'boolean') return `expected boolean, got ${typeof value}`
      break
    case 'enum': {
      if (typeof value !== 'string') return `expected enum string, got ${typeof value}`
      // The manifest rides as plain JSON (snake_case), so read both shapes.
      const enumValues = (item as { enumValues?: string[]; enum_values?: string[] }).enumValues ?? (item as { enum_values?: string[] }).enum_values ?? []
      if (enumValues.length > 0 && !enumValues.includes(value)) {
        return `value "${value}" not in the declared enum values`
      }
      break
    }
    case 'json':
      return ''
    default:
      return `unknown config type "${item.type}"`
  }
  return ''
}

/** ConfigAuthority is the agent-side config source of truth. */
export class ConfigAuthority {
  // tenant -> extId -> items
  private declarations = new Map<string, Map<string, ExtensionConfigItem[]>>()
  // tenant -> extId -> name -> value
  private global = new Map<string, Map<string, Map<string, ConfigValue>>>()
  // tenant -> extId -> session -> name -> value
  private sessions = new Map<string, Map<string, Map<string, Map<string, ConfigValue>>>>()
  started = false

  constructor(private readonly bus: Bus, private readonly defaultAck: boolean) {}

  /** declare records a manifest's config items + recovers persisted values. */
  async declare(tenant: string, m: ExtensionManifest): Promise<void> {
    let byExt = this.declarations.get(tenant)
    if (!byExt) {
      byExt = new Map()
      this.declarations.set(tenant, byExt)
    }
    byExt.set(m.id, m.config ?? [])
    await this.recover(tenant, m.id)
  }

  private async recover(tenant: string, extId: string): Promise<void> {
    for (const item of this.declarations.get(tenant)?.get(extId) ?? []) {
      const raw = await this.bus.kvGet(AbortSignal.timeout(3000), CONFIG_KV_BUCKET, configKVKey(tenant, extId, 'global', '', item.name)).catch(() => '')
      if (raw === '') continue
      const env = decodeConfigEnvelope(raw)
      if (!env) continue
      let byExt = this.global.get(tenant)
      if (!byExt) {
        byExt = new Map()
        this.global.set(tenant, byExt)
      }
      let byName = byExt.get(extId)
      if (!byName) {
        byName = new Map()
        byExt.set(extId, byName)
      }
      const cur = byName.get(item.name)
      if (!cur || env.r > cur.revision) byName.set(item.name, { revision: env.r, value: env.v })
    }
  }

  /** set validates, persists, then delivers a change with an optional ack. */
  async set(ctx: AbortSignal, tenant: string, extId: string, name: string, value: unknown, sessionName: string, ack?: boolean): Promise<void> {
    const items = this.declarations.get(tenant)?.get(extId) ?? []
    const item = items.find(it => it.name === name)
    if (!item) throw new ConfigError('not_found', `config ${name} not declared by ${extId}`)
    let scope = item.scope || 'global'
    if (scope === 'session' && sessionName === '') {
      throw new ConfigError('invalid_argument', `config ${name} requires a session name (scope=session)`)
    }
    const vmsg = validateConfigValue(item, value)
    if (vmsg !== '') throw new ConfigError('invalid_argument', vmsg)

    const useAck = ack === undefined ? this.defaultAck : ack

    // Bump the revision per (extId, scope, session, name).
    let revision: number
    if (scope === 'global') {
      const byName = this.globalEnsure(tenant, extId)
      revision = (byName.get(name)?.revision ?? 0) + 1
      byName.set(name, { revision, value })
    } else {
      const bySess = this.sessionsEnsure(tenant, extId)
      let byName = bySess.get(sessionName)
      if (!byName) {
        byName = new Map()
        bySess.set(sessionName, byName)
      }
      revision = (byName.get(name)?.revision ?? 0) + 1
      byName.set(name, { revision, value })
    }

    // Persist first (crash-safe): the cfg KV bucket is the source of truth.
    await this.bus
      .kvPut(ctx, CONFIG_KV_BUCKET, configKVKey(tenant, extId, scope, sessionName, name), JSON.stringify({ r: revision, v: value }), 0)
      .catch(() => {})

    // Deliver as a 1:1 req with an optional ack.
    const payload = create(ConfigSetSchema, {
      name,
      value: jsonToValue(value),
      revision,
      scope,
      ack: useAck,
      tenant,
      ...(sessionName !== '' ? { sessionName } : {}),
    })
    let reply: Awaited<ReturnType<Bus['request']>>
    try {
      reply = await this.bus.request(ctx, chConfig(tenant, extId), payload, {
        timeoutMs: useAck ? 5000 : 300,
        tenant,
        ...(sessionName !== '' ? { sessionName } : {}),
      })
    } catch {
      // Best-effort delivery: the value is already committed to KV.
      return
    }
    if (!useAck || !reply) return
    const hr = valueToJson(reply.payload) as { ok?: boolean; error?: { message?: string } } | undefined
    if (hr === undefined) throw new ConfigError('retryable', 'extension ack was not a HookResponse')
    if (!hr.ok) {
      // Roll back memory + KV.
      if (scope === 'global') {
        const byName = this.global.get(tenant)?.get(extId)
        if (byName?.get(name)?.revision === revision) byName.delete(name)
      } else {
        const byName = this.sessions.get(tenant)?.get(extId)?.get(sessionName)
        if (byName?.get(name)?.revision === revision) byName.delete(name)
      }
      await this.bus.kvDelete(ctx, CONFIG_KV_BUCKET, configKVKey(tenant, extId, scope, sessionName, name)).catch(() => {})
      throw new ConfigError('retryable', hr.error?.message ?? 'extension rejected the config change')
    }
    void payload
  }

  /** dropSessionConfig removes per-session overrides when a session ends. */
  async dropSessionConfig(ctx: AbortSignal, tenant: string, extId: string, sessionName: string): Promise<void> {
    const byName = this.sessions.get(tenant)?.get(extId)?.get(sessionName)
    if (!byName) return
    for (const name of byName.keys()) {
      await this.bus.kvDelete(ctx, CONFIG_KV_BUCKET, configKVKey(tenant, extId, 'session', sessionName, name)).catch(() => {})
    }
    this.sessions.get(tenant)?.get(extId)?.delete(sessionName)
  }

  private globalEnsure(tenant: string, extId: string): Map<string, ConfigValue> {
    let byExt = this.global.get(tenant)
    if (!byExt) {
      byExt = new Map()
      this.global.set(tenant, byExt)
    }
    let byName = byExt.get(extId)
    if (!byName) {
      byName = new Map()
      byExt.set(extId, byName)
    }
    return byName
  }

  private sessionsEnsure(tenant: string, extId: string): Map<string, Map<string, ConfigValue>> {
    let byExt = this.sessions.get(tenant)
    if (!byExt) {
      byExt = new Map()
      this.sessions.set(tenant, byExt)
    }
    let bySess = byExt.get(extId)
    if (!bySess) {
      bySess = new Map()
      byExt.set(extId, bySess)
    }
    return bySess
  }
}

export type { ConfigSet }
export { ValueSchema }
