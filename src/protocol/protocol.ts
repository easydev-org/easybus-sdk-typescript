// Runtime protocol conventions — the TypeScript twin of the Go
// `easybus-sdk/protocol` package. Every derivation here MUST match the Go
// implementation byte-for-byte (see ./golden.ts for the frozen vectors).
//
// The wire MESSAGES come from proto/easybus/v1/protocol.proto (the single
// source of truth); this module owns the SUBJECT layout, KV-key layout, tenant
// rules and small arg readers that proto cannot express.

import { createHash } from 'node:crypto'

/** SessionToken derives the transport-safe token for a session name. */
export function sessionToken(sessionName: string): string {
  const sum = createHash('sha256').update(sessionName, 'utf8').digest()
  // base64url WITHOUT padding, truncated to 22 chars (matches Go's
  // base64.RawURLEncoding.EncodeToString(sum)[:22]).
  return sum.toString('base64url').slice(0, 22)
}

// ---- tenant namespacing (v2) ----------------------------------------------
//
// A tenant is an opaque, plaintext isolation key (typically a user id). It is
// the SECOND subject segment for every data-plane channel — easybus.<tenant>.<...>
// — and rides every envelope in its tenant field. The strict charset prevents a
// tenant from injecting a subject separator ('.'), wildcard ('*'/'>'), or
// whitespace.

const TENANT_RE = /^[A-Za-z0-9_-]{1,64}$/

/** GlobalTenant is the reserved tenant for GLOBAL control-plane messages. */
export const GLOBAL_TENANT = 'global'

export function isValidTenant(raw: string): boolean {
  return TENANT_RE.test(raw)
}

/** TenantPrefix is the data-plane subject prefix for a tenant: easybus.<tenant>. */
export function tenantPrefix(tenant: string): string {
  return `easybus.${tenant}.`
}

/** SubjectTenant extracts the tenant segment, or '' when not namespaced. */
export function subjectTenant(ch: string): string {
  const p = 'easybus.'
  if (!ch.startsWith(p)) return ''
  const rest = ch.slice(p.length)
  const dot = rest.indexOf('.')
  if (dot <= 0) return ''
  const tenant = rest.slice(0, dot)
  return TENANT_RE.test(tenant) ? tenant : ''
}

/** TenantKVKey is a tenant-scoped KV key in a shared bucket: t.<tenant>.<rest>. */
export function tenantKVKey(tenant: string, rest: string): string {
  return `t.${tenant}.${rest}`
}

/** TenantObjectName is a tenant-scoped object-store name: t.<tenant>.<name>. */
export function tenantObjectName(tenant: string, name: string): string {
  return `t.${tenant}.${name}`
}

export const CH_DISCOVER = 'easybus.discover'
/** Per-tenant mailbox prefix (append the session token). */
export const MAILBOX_WILDCARD = 'easybus.'
/** Spans every tenant (cross-tenant consumers). */
export const MAILBOX_WILDCARD_ALL = 'easybus.*.mailbox.'
/** Spans every tenant's lifecycle subject. */
export const LIFECYCLE_WILDCARD = 'easybus.*.session.lifecycle.'
/** Stores extension variables, keyed tenant-first. */
export const VARS_BUCKET = 'vars'
/** Mirrors applied config values for persistence (caps.kv). */
export const CONFIG_KV_BUCKET = 'cfg'

export function chToolCall(tenant: string, extId: string, tool: string): string {
  return `${tenantPrefix(tenant)}tool.call.${extId}.${tool}`
}
export function chToolProgress(tenant: string, callId: string): string {
  return `${tenantPrefix(tenant)}tool.progress.${callId}`
}
export function chVariable(tenant: string, extId: string, name: string): string {
  return `${tenantPrefix(tenant)}var.${extId}.${name}`
}
export function chMailbox(tenant: string, session: string): string {
  return `${tenantPrefix(tenant)}mailbox.${sessionToken(session)}`
}
export function chSessionEvents(tenant: string, session: string): string {
  return `${tenantPrefix(tenant)}session.events.${sessionToken(session)}`
}
export function chSessionChanged(tenant: string): string {
  return `${tenantPrefix(tenant)}session.changed`
}
export function chInterrupt(tenant: string, extId: string): string {
  return `${tenantPrefix(tenant)}ctl.interrupt.${extId}`
}
export function chInterruptAll(tenant: string): string {
  return `${tenantPrefix(tenant)}ctl.interrupt.>`
}
export function chHookCall(tenant: string, extId: string, hook: string): string {
  return `${tenantPrefix(tenant)}hook.call.${extId}.${hook}`
}
export function chHookEvent(tenant: string, hook: string): string {
  return `${tenantPrefix(tenant)}hook.event.${hook}`
}
export function chLifecycle(tenant: string, kind: string): string {
  return `${tenantPrefix(tenant)}session.lifecycle.${kind}`
}
export function chConfig(tenant: string, extId: string): string {
  return `${tenantPrefix(tenant)}config.${extId}`
}

/** VarKey is the global variable KV key (t.<tenant>.<extId>.<name>). */
export function varKey(tenant: string, extId: string, name: string): string {
  return tenantKVKey(tenant, `${extId}.${name}`)
}

/** SessionVarKey is the session variable KV key (t.<tenant>.<extId>.<token>.<name>). */
export function sessionVarKey(tenant: string, extId: string, sessionName: string, name: string): string {
  return tenantKVKey(tenant, `${extId}.${sessionToken(sessionName)}.${name}`)
}

// ---- file RPCs (agent-served) ---------------------------------------------
//
// A DB-less, store-less extension (no S3 credentials, no agent DB) cannot mint
// a canonical `file:<code>` on its own, so it asks the AGENT to persist the
// bytes + metadata via the SAME path as an in-process ingest. The tenant rides
// the subject (`easybus.<tenant>.file.ingest`) and the envelope, so no separate
// credential is introduced. BYTES NEVER RIDE THE MESSAGE: the caller first
// stores the bytes in the transient object store and sends only the reference.

/** FILE_INGEST_WILDCARD is the cross-tenant consume wildcard for file.ingest. */
export const FILE_INGEST_WILDCARD = 'easybus.*.file.ingest'
/** FILE_GET_WILDCARD is the cross-tenant consume wildcard for file.get. */
export const FILE_GET_WILDCARD = 'easybus.*.file.get'

/** chFileIngest routes a file-ingest request for one tenant. */
export function chFileIngest(tenant: string): string {
  return `${tenantPrefix(tenant)}file.ingest`
}

/** chFileGet routes a file-get request for one tenant. */
export function chFileGet(tenant: string): string {
  return `${tenantPrefix(tenant)}file.get`
}

// ---- more arg readers (the extension-kit surface) --------------------------

export function argStrArray(args: Record<string, unknown>, key: string): string[] {
  const v = args[key]
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string')
}

// ---- arg readers -----------------------------------------------------------

export function argString(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v : ''
}
export function argInt(args: Record<string, unknown>, key: string, def: number): number {
  const v = args[key]
  return typeof v === 'number' ? Math.trunc(v) : def
}
export function argFloat(args: Record<string, unknown>, key: string, def: number): number {
  const v = args[key]
  return typeof v === 'number' ? v : def
}
export function argBool(args: Record<string, unknown>, key: string, def: boolean): boolean {
  const v = args[key]
  return typeof v === 'boolean' ? v : def
}

// ---- id / KV escaping ------------------------------------------------------

/** NewID returns a fresh random UUID-v4-shaped id (matches Go's protocol.NewID). */
export function newID(): string {
  const b = new Uint8Array(16)
  globalThis.crypto.getRandomValues(b)
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const hex = Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * EscapeKVSegment encodes a string into a NATS KV-safe key segment using only
 * [a-zA-Z0-9-/_=]. The escape char '=' introduces a two-hex-digit byte
 * ('.' -> "=2E", '=' -> "=3D"); every other byte outside the safe set is
 * hex-encoded. Never produces the '.' separator.
 */
export function escapeKVSegment(s: string): string {
  const HEX = '0123456789ABCDEF'
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (
      (c >= 0x61 && c <= 0x7a) ||
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x30 && c <= 0x39) ||
      c === 0x2d ||
      c === 0x5f ||
      c === 0x2f
    ) {
      out += s[i]
    } else {
      out += '=' + HEX[(c >> 4) & 0xf] + HEX[c & 0xf]
    }
  }
  return out
}

/** UnescapeKVSegment reverses escapeKVSegment. */
export function unescapeKVSegment(s: string): string {
  const hexVal = (c: number): number => {
    if (c >= 0x30 && c <= 0x39) return c - 0x30
    if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10
    if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10
    return -1
  }
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && i + 2 < s.length) {
      const hi = hexVal(s.charCodeAt(i + 1))
      const lo = hexVal(s.charCodeAt(i + 2))
      if (hi >= 0 && lo >= 0) {
        out += String.fromCharCode((hi << 4) | lo)
        i += 2
        continue
      }
    }
    out += s[i]
  }
  return out
}
