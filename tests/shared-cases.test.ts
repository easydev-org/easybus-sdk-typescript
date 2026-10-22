// Run the shared, language-neutral conformance cases.
//
// The cases live in conformance-cases/ and describe behaviour every SDK must
// implement identically. Reading the same files in every SDK is what stops four
// hand-written test suites from drifting apart: the config decoder had the same
// defect in all four languages, every suite passed, and nothing compared them.
//
// The copy is pinned by cases.lock. A mismatch means this SDK has not been refreshed
// after the contract changed — which would otherwise keep passing while asserting
// older behaviour.

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, expect, it } from 'vitest'

import { connect } from '../src/index.js'
import { Extension, type Config } from '../src/extension/index.js'
import { CONFIG_KV_BUCKET } from '../src/protocol/protocol.js'

const CASES_DIR = join(process.cwd(), 'conformance-cases')
const CTX = (ms: number) => AbortSignal.timeout(ms)

interface SharedCase {
  id: string
  why: string
  kind: 'kv' | 'constant'
  kv?: { key: string; value: string }
  knobs?: Record<string, { type: string }>
  expect?: { knob: string; value: unknown; valueType: string }
  constant?: { name: string; value: string }
}

function caseFiles(): string[] {
  return readdirSync(CASES_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
}

function digest(): string {
  const h = createHash('sha256')
  for (const f of caseFiles()) h.update(readFileSync(join(CASES_DIR, f)))
  return h.digest('hex')
}

describe('shared conformance cases', () => {
  // A stale copy keeps passing while the real contract moved — the failure mode this
  // whole mechanism exists to stop.
  it('copy matches cases.lock', () => {
    const want = readFileSync(join(CASES_DIR, 'cases.lock'), 'utf8').trim()
    expect(digest()).toBe(want)
  })

  it('at least one case exists', () => {
    expect(caseFiles().length).toBeGreaterThan(0)
  })

  for (const file of caseFiles()) {
    const raw = JSON.parse(readFileSync(join(CASES_DIR, file), 'utf8')) as SharedCase
    it(`${raw.id}`, async () => {
      if (raw.kind === 'constant') {
        runConstant(raw)
        return
      }
      await runKV(raw)
    })
  }
})

function runConstant(c: SharedCase): void {
  const k = c.constant!
  if (k.name === 'configKVBucket') {
    expect(CONFIG_KV_BUCKET, c.why).toBe(k.value)
    return
  }
  throw new Error(`${c.id}: unknown constant ${k.name}`)
}

/** Seed one bucket key, start an extension, assert the knob resolves. */
async function runKV(c: SharedCase): Promise<void> {
  const url = process.env['EASYBUS_NATS_URL']
  if (!url) throw new Error(`${c.id}: EASYBUS_NATS_URL must be set (see docker-compose.yml)`)

  const tenant = 'shared-t1'
  const extId = 'shared-ext'
  const key = c.kv!.key.replace('{tenant}', tenant).replace('{ext}', extId)

  const config: Record<string, { type: string }> = {}
  for (const [name, spec] of Object.entries(c.knobs ?? {})) config[name] = { type: spec.type }

  const a = await connect(url)
  const e = await connect(url)
  try {
    await a.kvPut(CTX(3000), CONFIG_KV_BUCKET, key, c.kv!.value, 0)
    const ext = new Extension(e, { id: extId, version: '1', config } as Config)
    await ext.serve(CTX(10_000))
    try {
      const { knob, value, valueType } = c.expect!
      let ok = false
      for (let i = 0; i < 100 && !ok; i++) {
        ok = matches(ext.getConfig(tenant, knob, ''), value, valueType)
        if (!ok) await delay(50)
      }
      expect(ok, `${c.id}: ${knob} = ${JSON.stringify(ext.getConfig(tenant, knob, ''))}, want ${JSON.stringify(value)} (${valueType}). ${c.why}`).toBe(true)
    } finally {
      await ext.close()
    }
  } finally {
    await a.close()
  }
}

/** Compare by the TYPE the case declares, not the language's representation. */
function matches(got: unknown, want: unknown, valueType: string): boolean {
  switch (valueType) {
    case 'string':
      return typeof got === 'string' && got === want
    case 'number':
      return typeof got === 'number' && got === Number(want)
    case 'bool':
      return typeof got === 'boolean' && got === want
    case 'null':
      return got === null
    default:
      return false
  }
}
