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
import { matches as matchesGrant } from '../src/extension/permission.js'
import { chChannel, matchSubject, parseChannelSubject } from '../src/protocol/channel.js'
import * as Proto from '../src/protocol/protocol.js'

const CASES_DIR = join(process.cwd(), 'conformance-cases')
const CTX = (ms: number) => AbortSignal.timeout(ms)

interface SharedCase {
  id: string
  why: string
  kind:
    | 'kv'
    | 'constant'
    | 'permission-matching'
    | 'channel-matching'
    | 'channel-subjects'
    | 'protocol-subjects'
    // Not assertions: the INPUTS to the broker suite, skipped here (see the loop below).
    | 'broker-fixture'
    | 'broker-cases'
  kv?: { key: string; value: string }
  knobs?: Record<string, { type: string }>
  expect?: { knob: string; value: unknown; valueType: string }
  constant?: { name: string; value: string }
  /**
   * The assertions for every pure-computation kind. One shape per kind, discriminated by which
   * fields are present — the JSON already says which, so a separate TS type per kind would only
   * duplicate it.
   */
  cases?: Array<Record<string, any>>
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
      // A pure-computation case: no broker, so every SDK can run it everywhere.
      if (raw.kind === 'permission-matching') {
        runPermissionMatching(raw)
        return
      }
      if (raw.kind === 'channel-matching') {
        runChannelMatching(raw)
        return
      }
      if (raw.kind === 'channel-subjects') {
        runChannelSubjects(raw)
        return
      }
      if (raw.kind === 'protocol-subjects') {
        runProtocolSubjects(raw)
        return
      }
      // Not a case: the INPUTS to the broker suite (the extension it builds, the calls it makes).
      // They live in the shared directory so every SDK reads the same bytes, and are read by
      // tests/broker-cases.test.ts. Running them through the generic loop made them demand a
      // broker they never needed.
      if (raw.kind === 'broker-fixture' || raw.kind === 'broker-cases') {
        return
      }
      await runKV(raw)
    })
  }
})

/**
 * The grant-matching rules, from the shared table.
 *
 * These are the security boundary of every extension, implemented once per language. Two SDKs that
 * disagree do not fail loudly — they authorise different things for the same grant, depending on
 * which language the extension happens to be written in.
 */
function runPermissionMatching(c: SharedCase): void {
  expect(c.cases?.length, `${c.id}: no cases`).toBeGreaterThan(0)
  for (const [i, mc] of (c.cases ?? []).entries()) {
    expect(
      matchesGrant(mc['grant'] as Record<string, string>, mc['target'] as Record<string, string>),
      `${c.id} case ${i}: ${String(mc['why'])}`,
    ).toBe(mc['want'])
  }
}

/**
 * Maps the shared table's function names onto this SDK's exports.
 *
 * A missing entry is a test failure, not a skip: the table names a behaviour the protocol has,
 * so "this SDK does not have it" is exactly what the table should report.
 */
function subjectFn(name: string): ((a: Record<string, string>) => unknown) | undefined {
  const M: Record<string, (a: Record<string, string>) => unknown> = {
    chMailbox: a => Proto.chMailbox(a['tenant']!, a['session']!),
    chToolCall: a => Proto.chToolCall(a['tenant']!, a['ext']!, a['tool']!),
    chToolProgress: a => Proto.chToolProgress(a['tenant']!, a['callId']!),
    chVariable: a => Proto.chVariable(a['tenant']!, a['ext']!, a['name']!),
    chSessionEvents: a => Proto.chSessionEvents(a['tenant']!, a['session']!),
    chSessionChanged: a => Proto.chSessionChanged(a['tenant']!),
    chInterrupt: a => Proto.chInterrupt(a['tenant']!, a['ext']!),
    chInterruptAll: a => Proto.chInterruptAll(a['tenant']!),
    chLifecycle: a => Proto.chLifecycle(a['tenant']!, a['kind']!),
    chHookCall: a => Proto.chHookCall(a['tenant']!, a['ext']!, a['hook']!),
    chHookEvent: a => Proto.chHookEvent(a['tenant']!, a['hook']!),
    chConfig: a => Proto.chConfig(a['tenant']!, a['ext']!),
    chFileGet: a => Proto.chFileGet(a['tenant']!),
    chFileIngest: a => Proto.chFileIngest(a['tenant']!),
    chChannel: a => {
      try {
        return chChannel(a['tenant']!, a['channel']!, a['topic']!)
      } catch {
        return 'REJECTED'
      }
    },
    subjectTenant: a => Proto.subjectTenant(a['subject']!),
  }
  return M[name]
}

function runChannelMatching(c: SharedCase): void {
  expect(c.cases?.length, `${c.id}: no cases`).toBeGreaterThan(0)
  for (const [i, mc] of (c.cases ?? []).entries()) {
    expect(
      matchSubject(String(mc['pattern'] ?? ''), String(mc['topic'] ?? '')),
      `${c.id} case ${i}: ${String(mc.why)}`,
    ).toBe(mc['want'])
  }
}

function runChannelSubjects(c: SharedCase): void {
  expect(c.cases?.length, `${c.id}: no cases`).toBeGreaterThan(0)
  for (const [i, mc] of (c.cases ?? []).entries()) {
    const why = String(mc.why ?? '')
    const build = mc['build'] as Record<string, string> | undefined
    if (build) {
      expect(chChannel(build['tenant']!, build['channel']!, build['topic']!), `${c.id} ${i}: ${why}`)
        .toBe(mc['want'])
      continue
    }
    const p = mc['parse']
    if (typeof p === 'string') {
      const got = parseChannelSubject(p)
      if (mc['want'] === null) expect(got, `${c.id} ${i}: ${why}`).toBeNull()
      else expect([got?.tenant, got?.channel, got?.topic], `${c.id} ${i}: ${why}`).toEqual(mc['want'])
      continue
    }
    const r = mc['reject'] as Record<string, string> | undefined
    if (r) {
      // A wildcard or empty segment must be refused, not published as a broadcast.
      expect(() => chChannel(r['tenant']!, r['channel']!, r['topic']!), `${c.id} ${i}: ${why}`).toThrow()
    }
  }
}

function runProtocolSubjects(c: SharedCase): void {
  expect(c.cases?.length, `${c.id}: no cases`).toBeGreaterThan(0)
  for (const [i, mc] of (c.cases ?? []).entries()) {
    const fn = subjectFn(String(mc['fn'] ?? ''))
    expect(fn, `${c.id} case ${i}: no mapping for ${String(mc['fn'])}`).toBeDefined()
    expect(fn!(mc['args'] as Record<string, string>), `${c.id} ${i}: ${String(mc.why)}`).toBe(mc['want'])
  }
}

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
