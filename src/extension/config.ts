// The config store — applied values per tenant (global set + per-session
// overrides), the TS twin of the Go `extension.ConfigStore`.

import type { ConfigSpec } from './types.js'

/** Keeps applied values per tenant: global set + per-session overrides. */
export class ConfigStore {
  // tenant -> name -> value
  private global = new Map<string, Map<string, unknown>>()
  // tenant -> session -> name -> value
  private session = new Map<string, Map<string, Map<string, unknown>>>()

  /** Resolve session override > global set > declared default. */
  get(specs: Record<string, ConfigSpec>, tenant: string, name: string, sessionName: string): unknown {
    if (sessionName !== '') {
      const v = this.session.get(tenant)?.get(sessionName)?.get(name)
      if (v !== undefined) return v
    }
    const g = this.global.get(tenant)?.get(name)
    if (g !== undefined) return g
    const spec = specs[name]
    return spec ? spec.default : undefined
  }

  applySet(_specs: Record<string, ConfigSpec>, tenant: string, name: string, value: unknown, sessionName?: string): void {
    if (sessionName) {
      let s = this.session.get(tenant)
      if (!s) {
        s = new Map()
        this.session.set(tenant, s)
      }
      let m = s.get(sessionName)
      if (!m) {
        m = new Map()
        s.set(sessionName, m)
      }
      m.set(name, value)
      return
    }
    let g = this.global.get(tenant)
    if (!g) {
      g = new Map()
      this.global.set(tenant, g)
    }
    g.set(name, value)
  }

  rollbackSet(_specs: Record<string, ConfigSpec>, tenant: string, name: string, sessionName?: string): void {
    if (sessionName) {
      this.session.get(tenant)?.get(sessionName)?.delete(name)
      return
    }
    this.global.get(tenant)?.delete(name)
  }

  setGlobal(tenant: string, name: string, value: unknown, deleted: boolean): void {
    let g = this.global.get(tenant)
    if (!g) {
      g = new Map()
      this.global.set(tenant, g)
    }
    if (deleted) g.delete(name)
    else g.set(name, value)
  }

  setSession(tenant: string, sessionName: string, name: string, value: unknown, deleted: boolean): void {
    let s = this.session.get(tenant)
    if (!s) {
      s = new Map()
      this.session.set(tenant, s)
    }
    let m = s.get(sessionName)
    if (!m) {
      m = new Map()
      s.set(sessionName, m)
    }
    if (deleted) m.delete(name)
    else m.set(name, value)
  }
}
