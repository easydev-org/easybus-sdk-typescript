import { describe, expect, it } from 'vitest'
import {
  allowed,
  attachGrants,
  grantsFor,
  matches,
  PermissionDenied,
  requirePermission,
} from './permission.js'
import type { Grant } from '../wire.js'

/** A signal standing in for one call's AbortSignal. */
function call(grantList: Grant[]): AbortSignal {
  const ctl = new AbortController()
  attachGrants(ctl.signal, grantList)
  return ctl.signal
}

function grant(key: string, params: Record<string, unknown>): Grant {
  return { key, params } as Grant
}

describe('matches', () => {
  it('accepts an exact match', () => {
    expect(matches({ repo: 'agentdev/mrflow' }, { repo: 'agentdev/mrflow' })).toBe(true)
    expect(matches({ repo: 'agentdev/mrflow' }, { repo: 'agentdev/other' })).toBe(false)
  })

  // The wildcard is the whole reason a user can say "all my repositories"; without it every
  // repository would need its own grant.
  it('honours the wildcard', () => {
    const cases: [string, string, boolean][] = [
      ['agentdev/*', 'agentdev/mrflow', true],
      ['agentdev/*', 'easydev-org/x', false],
      ['*', 'anything/at/all', true],
      ['agentdev/*.go', 'agentdev/main.go', true],
      ['agentdev/*.go', 'agentdev/main.md', false],
      // A wildcard must not match the parent it was anchored to.
      ['agentdev/*', 'agentdev', false],
    ]
    for (const [pattern, value, want] of cases) {
      expect(matches({ repo: pattern }, { repo: value }), `${pattern} vs ${value}`).toBe(want)
    }
  })

  // Every declared param must match (AND). A grant naming two params is narrower than one
  // naming one, which is what a reader expects.
  it('requires every declared param', () => {
    const g = { namespace: 'dev', service: 'api' }
    expect(matches(g, { namespace: 'dev', service: 'api' })).toBe(true)
    expect(matches(g, { namespace: 'dev', service: 'web' })).toBe(false)
    expect(matches(g, { namespace: 'dev' })).toBe(false)
  })

  // Params the grant does not declare are not compared: the extension decides what matters.
  it('ignores target params the grant does not declare', () => {
    expect(matches({ repo: 'agentdev/*' }, { repo: 'agentdev/mrflow', branch: 'x' })).toBe(true)
  })
})

describe('allowed', () => {
  it('passes with one matching instance', () => {
    const ctx = call([
      grant('mr.merge', { repo: 'agentdev/mrflow' }),
      grant('mr.merge', { repo: 'scratch/*' }),
    ])
    expect(allowed(ctx, 'mr.merge', { repo: 'agentdev/mrflow' })).toBe(true)
    expect(allowed(ctx, 'mr.merge', { repo: 'scratch/anything' })).toBe(true)
    expect(allowed(ctx, 'mr.merge', { repo: 'easydev-org/easyagent' })).toBe(false)
  })

  // Holding one key says nothing about another: they are separate authorisations.
  it('does not leak between keys', () => {
    const ctx = call([grant('mr.merge', { repo: '*' })])
    expect(allowed(ctx, 'repo.delete', { repo: 'anything' })).toBe(false)
  })

  it('allows nothing without grants', () => {
    const ctl = new AbortController()
    expect(allowed(ctl.signal, 'anything', {})).toBe(false)
  })
})

describe('requirePermission', () => {
  it('passes when covered', () => {
    const ctx = call([grant('mr.merge', { repo: 'agentdev/*' })])
    expect(() => requirePermission(ctx, 'mr.merge', { repo: 'agentdev/mrflow' })).not.toThrow()
  })

  // The message has to name BOTH what was wanted and what is held, or a caller cannot tell
  // "no permission" from "wrong repository".
  it('names the gap when a grant does not cover', () => {
    const ctx = call([grant('mr.merge', { repo: 'agentdev/mrflow' })])
    let err: unknown
    try {
      requirePermission(ctx, 'mr.merge', { repo: 'easydev-org/easyagent' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(PermissionDenied)
    const msg = (err as Error).message
    expect(msg).toContain('easydev-org/easyagent')
    expect(msg).toContain('agentdev/mrflow')
  })

  it('distinguishes "none held" from "held but not covering"', () => {
    const ctl = new AbortController()
    expect(() => requirePermission(ctl.signal, 'mr.merge', { repo: 'x/y' })).toThrow(/no grant held/)
  })
})

describe('grantsFor', () => {
  it('returns every instance of one key', () => {
    const ctx = call([
      grant('mr.merge', { repo: 'a/one' }),
      grant('mr.merge', { repo: 'a/two' }),
      grant('exec', { sandbox: 's' }),
    ])
    expect(grantsFor(ctx, 'mr.merge')).toHaveLength(2)
    expect(grantsFor(ctx, 'exec')).toHaveLength(1)
  })
})
