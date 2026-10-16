import { describe, expect, it } from 'vitest'
import { goldenVectors } from '../src/protocol/golden.js'
import { authHeader, verify } from '../src/identity/index.js'

// The cross-language vectors: these MUST equal easybus-sdk (Go). If this fails,
// a derivation drifted and cross-language traffic will break silently.
describe('golden vectors', () => {
  for (const [name, [got, want]] of Object.entries(goldenVectors)) {
    it(name, () => {
      expect(got).toBe(want)
    })
  }
})

describe('identity', () => {
  it('signs and verifies', () => {
    const id = { id: 'agent-1', secret: 's3cret' }
    const f = { ch: 'easybus.discover', kind: 'req', id: 'c1', payload: { x: 1 } }
    const h = authHeader(id, f)
    expect(h.id).toBe('agent-1')
    expect(verify('agent-1', 's3cret', f, h.sig)).toBe(true)
    expect(verify('agent-1', 'wrong', f, h.sig)).toBe(false)
    // tampered payload fails
    expect(verify('agent-1', 's3cret', { ...f, payload: { x: 2 } }, h.sig)).toBe(false)
  })
})
