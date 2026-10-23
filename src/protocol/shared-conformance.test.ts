import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { matchSubject, parseChannelSubject, chChannel } from './channel.js'
import * as P from './protocol.js'

/**
 * The shared cross-language tables.
 *
 * Each describes behaviour implemented once per language. They are read from the SAME files in
 * every SDK, so a divergence fails a test here instead of surfacing as a message that silently
 * never arrives — a wrong subject or a wrong `>` rule produces no error anywhere.
 */

const CASES = join(__dirname, '..', '..', 'conformance-cases')

function load(name: string): { cases: any[] } {
  return JSON.parse(readFileSync(join(CASES, name), 'utf8'))
}

describe('shared channel-matching table', () => {
  const table = load('channel-matching.json')
  it('has cases', () => expect(table.cases.length).toBeGreaterThan(0))
  for (const [i, c] of table.cases.entries()) {
    it(`case ${i}: ${c.why}`, () => {
      expect(matchSubject(c.pattern, c.topic)).toBe(c.want)
    })
  }
})

describe('shared channel-subjects table', () => {
  const table = load('channel-subjects.json')
  for (const [i, c] of table.cases.entries()) {
    if (c.build) {
      it(`build ${i}: ${c.why}`, () => {
        expect(chChannel(c.build.tenant, c.build.channel, c.build.topic)).toBe(c.want)
      })
    } else if (c.parse !== undefined) {
      it(`parse ${i}: ${c.why}`, () => {
        const got = parseChannelSubject(c.parse)
        if (c.want === null) expect(got).toBeNull()
        else expect([got?.tenant, got?.channel, got?.topic]).toEqual(c.want)
      })
    } else if (c.reject) {
      it(`reject ${i}: ${c.why}`, () => {
        // A wildcard or empty segment must be refused, not silently published as a broadcast.
        expect(() => chChannel(c.reject.tenant, c.reject.channel, c.reject.topic)).toThrow()
      })
    }
  }
})

/** Maps the table's function names onto this SDK's exports. */
const SUBJECT_FNS: Record<string, (a: Record<string, string>) => unknown> = {
  chMailbox: a => P.chMailbox(a['tenant']!, a['session']!),
  chToolCall: a => P.chToolCall(a['tenant']!, a['ext']!, a['tool']!),
  chToolProgress: a => P.chToolProgress(a['tenant']!, a['callId']!),
  chVariable: a => P.chVariable(a['tenant']!, a['ext']!, a['name']!),
  chSessionEvents: a => P.chSessionEvents(a['tenant']!, a['session']!),
  chSessionChanged: a => P.chSessionChanged(a['tenant']!),
  chInterrupt: a => P.chInterrupt(a['tenant']!, a['ext']!),
  chInterruptAll: a => P.chInterruptAll(a['tenant']!),
  chLifecycle: a => P.chLifecycle(a['tenant']!, a['kind']!),
  chHookCall: a => P.chHookCall(a['tenant']!, a['ext']!, a['hook']!),
  chHookEvent: a => P.chHookEvent(a['tenant']!, a['hook']!),
  chConfig: a => P.chConfig(a['tenant']!, a['ext']!),
  chFileGet: a => P.chFileGet(a['tenant']!),
  chFileIngest: a => P.chFileIngest(a['tenant']!),
  chChannel: a => {
    try {
      return chChannel(a['tenant']!, a['channel']!, a['topic']!)
    } catch {
      return 'REJECTED'
    }
  },
  subjectTenant: a => P.subjectTenant(a['subject']!),
}

describe('shared protocol-subjects table', () => {
  const table = load('protocol-subjects.json')
  for (const [i, c] of table.cases.entries()) {
    it(`case ${i}: ${c.fn} — ${c.why}`, () => {
      const fn = SUBJECT_FNS[c.fn]
      expect(fn, `no mapping for ${c.fn}`).toBeDefined()
      expect(fn!(c.args)).toBe(c.want)
    })
  }
})
