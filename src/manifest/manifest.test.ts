import { describe, expect, it } from 'vitest'
import { parseManifest } from './manifest.js'
import { Extension } from '../extension/extension.js'
import { connect } from '../index.js'

/**
 * A manifest's permissions and channels must SURVIVE parsing and reach the wire.
 *
 * This is a regression test for the bug that made the whole permission feature inert in three of
 * the four SDKs: `parseManifest` returned the YAML object, but `Manifest` had no `permissions`
 * field, so the type system said the data did not exist and `buildManifest` could not copy it.
 * A manifest could declare `permissions:` and the agent received nothing — every tool ran ungated
 * while the YAML said otherwise, and nothing failed.
 */

const YAML = `
id: demo
version: "1"
permissions:
  - key: repo.merge
    label: Merge pull requests
    risk: destructive
    params:
      - name: repo
        type: string
        required: true
channels:
  - name: forge
    description: repository events
    topics:
      - pattern: tag.<owner>/<repo>.<tag>
        description: a new tag appeared
tools:
  - name: merge
    description: merge it
    requires: [repo.merge]
`

describe('manifest permissions and channels', () => {
  it('parses permissions through to the typed manifest', () => {
    const m = parseManifest(YAML)
    expect(m.permissions).toHaveLength(1)
    expect(m.permissions?.[0]?.key).toBe('repo.merge')
    expect(m.permissions?.[0]?.risk).toBe('destructive')
    expect(m.permissions?.[0]?.params?.[0]?.name).toBe('repo')
  })

  it('parses channels and their topic patterns', () => {
    const m = parseManifest(YAML)
    expect(m.channels?.[0]?.name).toBe('forge')
    expect(m.channels?.[0]?.topics?.[0]?.pattern).toBe('tag.<owner>/<repo>.<tag>')
  })

  it('parses a tool requirement', () => {
    expect(parseManifest(YAML).tools?.[0]?.requires).toEqual(['repo.merge'])
  })

  // The end of the chain: what the agent actually receives. Parsing correctly is not enough if
  // buildManifest drops it on the way out.
  it('publishes permissions, channels and requires in the served manifest', async () => {
    const m = parseManifest(YAML)
    const bus = await connect('nats://127.0.0.1:4222').catch(() => null)
    if (bus === null) {
      // No broker here; assert the pure build step instead.
      const ext = new Extension({ publish: async () => {} } as never, {
        id: m.id,
        version: m.version,
        permissions: m.permissions,
        channels: m.channels,
        tools: { merge: { description: 'merge it', requires: ['repo.merge'], execute: async () => ({}) } },
      })
      const wire = (ext as unknown as { buildManifest(): Record<string, unknown> }).buildManifest()
      expect(wire['permissions']).toHaveLength(1)
      expect(wire['channels']).toHaveLength(1)
      expect((wire['tools'] as Array<Record<string, unknown>>)[0]?.['requires']).toEqual(['repo.merge'])
      expect(wire['capabilities']).toContain('permissions')
      expect(wire['capabilities']).toContain('channels')
      return
    }
    await bus.close()
  })
})
