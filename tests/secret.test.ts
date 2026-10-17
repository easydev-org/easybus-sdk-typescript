import { describe, expect, it } from 'vitest'
import { parseManifest } from '../src/manifest/manifest.js'
import { CONFIG_KIND_SECRET } from '../src/extension/types.js'

describe('secret config validation', () => {
  it('accepts a string secret with no default', () => {
    const m = parseManifest(`
id: x
version: "1"
config:
  - name: gh-token
    type: string
    kind: secret
`)
    expect(m.config?.[0]?.kind).toBe(CONFIG_KIND_SECRET)
  })

  it('rejects a non-string secret', () => {
    expect(() =>
      parseManifest(`
id: x
version: "1"
config:
  - name: gh-token
    type: number
    kind: secret
`),
    ).toThrow(/type=string/)
  })

  it('rejects a secret with a default', () => {
    expect(() =>
      parseManifest(`
id: x
version: "1"
config:
  - name: gh-token
    type: string
    kind: secret
    default: ghp_leaked
`),
    ).toThrow(/must not declare a default/)
  })

  it('leaves an ordinary knob alone', () => {
    const m = parseManifest(`
id: x
version: "1"
config:
  - name: region
    type: string
    default: us
`)
    expect(m.config?.[0]?.default).toBe('us')
  })
})
