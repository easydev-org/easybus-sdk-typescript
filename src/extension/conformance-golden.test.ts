import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { matches } from './permission.js'

/**
 * The shared matching table, from conformance-cases/permission-matching.json.
 *
 * WHY a shared file rather than a test written once here: the rules are implemented four times,
 * and they are the security boundary of every extension. Two SDKs that disagree do not fail
 * loudly — they authorise different things for the same grant, silently, depending on which
 * language the extension happens to be written in. Every SDK reads this same table.
 */
interface Case {
  grant: Record<string, string>
  target: Record<string, string>
  want: boolean
  why: string
}

const table = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'conformance-cases', 'permission-matching.json'), 'utf8'),
) as { cases: Case[] }

describe('shared matching table', () => {
  it('has cases', () => {
    expect(table.cases.length).toBeGreaterThan(0)
  })

  for (const [i, c] of table.cases.entries()) {
    it(`case ${i}: ${c.why}`, () => {
      expect(matches(c.grant, c.target)).toBe(c.want)
    })
  }
})
