// Session lease semantics (protocol-level, cross-replica) — the TS twin of the
// Go `agent/lease.go`.
//
//   - claim:   KVCreate on the lease bucket — succeeds only when no live lease
//              exists; returns the KV revision needed to renew.
//   - renew:   CAS on that revision; returns the NEW revision or fails when the
//              lease was lost (expired / taken over after expiry).
//   - release: delete the key (back to idle).
//   - running: key present.

import type { Bus } from '../bus/bus.js'
import { sessionToken, tenantKVKey } from '../protocol/protocol.js'

/** LeaseBucket holds one key per running session. */
export const LEASE_BUCKET = 'easybus-session-state'
/** LeaseTTLDefaultMs is the default claim/renew TTL (30s). */
export const LEASE_TTL_DEFAULT_MS = 30_000

/** SessionLease implements the cross-replica session run lease. */
export class SessionLease {
  constructor(private readonly bus: Bus) {}

  /** claim atomically claims the lease. Returns the KV revision, or null. */
  async claim(ctx: AbortSignal, tenant: string, sessionName: string, ttlMs = LEASE_TTL_DEFAULT_MS): Promise<number | null> {
    const ttl = ttlMs > 0 ? ttlMs : LEASE_TTL_DEFAULT_MS
    try {
      const rev = await this.bus.kvCreate(ctx, LEASE_BUCKET, tenantKVKey(tenant, sessionToken(sessionName)), 'running', ttl)
      return rev === 0 ? null : rev
    } catch {
      return null
    }
  }

  /** renew extends the lease via CAS. Returns the new revision, or null. */
  async renew(ctx: AbortSignal, tenant: string, sessionName: string, revision: number, ttlMs = LEASE_TTL_DEFAULT_MS): Promise<number | null> {
    const ttl = ttlMs > 0 ? ttlMs : LEASE_TTL_DEFAULT_MS
    void ttl
    try {
      const rev = await this.bus.kvCas(ctx, LEASE_BUCKET, tenantKVKey(tenant, sessionToken(sessionName)), 'running', revision)
      return rev === 0 ? null : rev
    } catch {
      return null
    }
  }

  /** release frees the lease (back to idle). */
  async release(ctx: AbortSignal, tenant: string, sessionName: string): Promise<void> {
    await this.bus.kvDelete(ctx, LEASE_BUCKET, tenantKVKey(tenant, sessionToken(sessionName))).catch(() => {})
  }

  /** isRunning reports whether the lease is held. */
  async isRunning(ctx: AbortSignal, tenant: string, sessionName: string): Promise<boolean> {
    const v = await this.bus.kvGet(ctx, LEASE_BUCKET, tenantKVKey(tenant, sessionToken(sessionName))).catch(() => '')
    return v !== ''
  }

  /**
   * withSessionLease runs fn while holding the exclusive lease. Returns
   * { acquired: false } when another replica holds it. The lease is renewed on
   * a timer (TTL/3) and released after fn returns.
   */
  async withSessionLease(
    ctx: AbortSignal,
    tenant: string,
    sessionName: string,
    fn: (ctx: AbortSignal) => Promise<void>,
    ttlMs = LEASE_TTL_DEFAULT_MS,
  ): Promise<{ acquired: boolean; lost?: boolean }> {
    const ttl = ttlMs > 0 ? ttlMs : LEASE_TTL_DEFAULT_MS
    let revision = await this.claim(ctx, tenant, sessionName, ttl)
    if (revision === null) return { acquired: false }

    let lost = false
    const ctl = new AbortController()
    ctx.addEventListener('abort', () => ctl.abort(), { once: true })
    const timer = setInterval(() => {
      void this.renew(ctx, tenant, sessionName, revision!, ttl).then(next => {
        if (next === null) {
          lost = true
          ctl.abort()
        } else {
          revision = next
        }
      })
    }, Math.max(1, Math.floor(ttl / 3)))

    try {
      await fn(ctl.signal)
    } finally {
      clearInterval(timer)
      await this.release(AbortSignal.timeout(2000), tenant, sessionName)
    }
    return { acquired: true, lost }
  }
}
