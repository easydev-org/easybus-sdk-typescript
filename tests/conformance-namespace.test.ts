// Conformance: a manifest's structured config and namespaces reach the WIRE.
//
// Three hops, all asserted here:
//   YAML manifest -> parsed types -> buildConfig -> the published manifest
//
// Asserting only the first hop is what let this ship broken: the field existed on
// the interface and was still dropped on the way out, so a TS extension could
// declare a typed config knob and the world would never see it.

import { describe, expect, it } from 'vitest'
import { buildConfig, parseManifest } from '../src/manifest/manifest.js'
import { Extension } from '../src/extension/extension.js'

const OPS_MANIFEST = `
id: ops
version: "1"
namespaces:
  - name: services
    description: Deploy workloads
  - name: build
    description: Image builds
config:
  - name: easyops-url
    type: string
  - name: buildkit-addr
    type: string
    namespace: build
  - name: sandboxes
    type: list
    kind: secret
    item_type: object
    min_items: 1
    fields:
      - name: name
        type: string
        required: true
      - name: url
        type: string
        format: uri
        required: true
      - name: token
        type: string
        kind: secret
        required: true
      - name: os
        type: enum
        enum_values: [linux, windows, macos, android]
        default: linux
tools:
  - name: create-pvc
    description: Create a PVC
    namespace: storage
`

const noop = async () => ({ content: '' })

function wireManifest(): Record<string, any> {
  const m = parseManifest(OPS_MANIFEST)
  const cfg = buildConfig(m, { handlers: { 'create-pvc': { execute: noop } as any } })
  // buildManifest is private; the wire form is what we are asserting on.
  return (new Extension(null as any, cfg) as any).buildManifest()
}

describe('structured config + namespaces', () => {
  it('declared namespaces reach the wire, in the author order', () => {
    const w = wireManifest()
    expect(w.namespaces.map((n: any) => n.name)).toEqual(['services', 'build'])
    expect(w.namespaces[0].description).toBe('Deploy workloads')
  })

  it('a tool carries its namespace and keeps its name', () => {
    const w = wireManifest()
    const tool = w.tools.find((t: any) => t.name === 'create-pvc')
    expect(tool.namespace).toBe('storage')
    expect(tool.name).toBe('create-pvc')
  })

  it('a structured knob ships its shape', () => {
    const w = wireManifest()
    const knob = w.config.find((c: any) => c.name === 'sandboxes')
    expect(knob.type).toBe('list')
    expect(knob.item_type).toBe('object')
    expect(knob.min_items).toBe(1)

    const byName = Object.fromEntries(knob.fields.map((f: any) => [f.name, f]))
    expect(Object.keys(byName).sort()).toEqual(['name', 'os', 'token', 'url'])
    expect(byName.url.format).toBe('uri')
    expect(byName.token.kind).toBe('secret')
    expect(byName.os.type).toBe('enum')
    expect(byName.os.enum_values).toEqual(['linux', 'windows', 'macos', 'android'])
    expect(byName.name.required).toBe(true)
  })

  it('an empty namespace means extension-level', () => {
    const w = wireManifest()
    const byName = Object.fromEntries(w.config.map((c: any) => [c.name, c]))
    expect(byName['easyops-url'].namespace).toBeUndefined()
    expect(byName['buildkit-addr'].namespace).toBe('build')
  })
})
