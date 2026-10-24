import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'

import { connect, type Bus } from '../src/index.js'
import { Agent } from '../src/agent/index.js'
import { Extension, TypedError, type Config, type ToolSpec } from '../src/extension/index.js'

/**
 * The broker-backed shared cases.
 *
 * Declared as CALLS and EXPECTATIONS in conformance-cases/broker-cases.json, driving the extension
 * declared in broker-fixture.json. Both files are read by every SDK, so four implementations cannot
 * quietly disagree — the failure mode that let the config decoder carry the same defect in all
 * four languages while every suite passed.
 *
 * Only the STATEMENTS are shared. How a case is expressed here is not: TypeScript has an
 * AbortSignal where Go has a context.
 */

const CASES = join(process.cwd(), 'conformance-cases')
const T = 't1'
const CTX = (ms: number) => AbortSignal.timeout(ms)

interface Fixture {
  ext: { id: string; version: string }
  tools: Array<{ name: string; description: string; behaviour: string; ms?: number }>
  variables: Array<{ name: string; description: string; value: string }>
  config: Array<{ name: string; type: string; kind?: string; scope?: string; default?: unknown; description?: string }>
}

interface BrokerCase {
  id: string
  why: string
  call?: { tool: string; session: string; callId?: string; args?: Record<string, unknown> }
  resolveVariable?: { provider: string; name: string; session: string }
  expect: Record<string, unknown>
}

const fixture = JSON.parse(readFileSync(join(CASES, 'broker-fixture.json'), 'utf8')) as Fixture
const table = JSON.parse(readFileSync(join(CASES, 'broker-cases.json'), 'utf8')) as { cases: BrokerCase[] }

const url = process.env['EASYBUS_NATS_URL']

/**
 * Whether a broker is actually reachable.
 *
 * EASYBUS_NATS_URL being SET is not the same as a broker being there: the test matrix exports it
 * pointing at 127.0.0.1:4222 while starting no server, so the variable is non-empty and the
 * connection is refused. The other suites in this repo probe for the nats-server BINARY and skip;
 * this one connects instead, so a refused connection surfaced as eight failures with
 * "ClosedConnectionError" rather than as a skip.
 */
async function brokerReachable(): Promise<boolean> {
  if (!url) return false
  try {
    const bus = await connect(url)
    await bus.close()
    return true
  } catch {
    return false
  }
}

const reachable = await brokerReachable()

if (!reachable && url) {
  console.warn(
    `[broker-cases] EASYBUS_NATS_URL=${url} but nothing answered there; broker cases will skip`,
  )
}

/** Builds the conformance extension FROM THE SHARED FIXTURE. */
function buildExt(bus: Bus): Extension {
  const tools: Record<string, ToolSpec> = {}
  for (const td of fixture.tools) {
    const ms = td.ms ?? 0
    switch (td.behaviour) {
      case 'echo':
        tools[td.name] = {
          description: td.description,
          execute: async (_ctx, args) => ({ content: `echo:${String(args['msg'] ?? '')}` }),
        }
        break
      case 'add':
        tools[td.name] = {
          description: td.description,
          execute: async (_ctx, args) => ({ data: { sum: Number(args['a'] ?? 0) + Number(args['b'] ?? 0) } }),
        }
        break
      case 'boom':
        tools[td.name] = {
          description: td.description,
          execute: async () => {
            throw new TypedError('CODE_BUSINESS', 'nope')
          },
        }
        break
      case 'big':
        tools[td.name] = {
          description: td.description,
          // Over the SDK's 128 KiB cap, so the refusal is exercised rather than a value that
          // happens to be small.
          execute: async () => ({ content: 'x'.repeat(200 * 1024) }),
        }
        break
      case 'session':
        tools[td.name] = {
          description: td.description,
          execute: async (_ctx, _args, _callId, session) => ({ content: `session=${session}` }),
        }
        break
      case 'slow':
        tools[td.name] = {
          description: td.description,
          execute: async () => {
            await delay(ms)
            return { content: 'slow-done' }
          },
        }
        break
      case 'hang':
        tools[td.name] = {
          description: td.description,
          execute: async ctx => {
            // Waits until cancelled, which is how interrupt is tested.
            await new Promise<void>(resolve => {
              const timer = setTimeout(resolve, ms)
              ctx.addEventListener('abort', () => {
                clearTimeout(timer)
                resolve()
              }, { once: true })
            })
            return { content: 'never' }
          },
        }
        break
      default:
        throw new Error(`fixture tool ${td.name}: unknown behaviour ${td.behaviour}`)
    }
  }

  const variables: Config['variables'] = {}
  for (const v of fixture.variables) {
    variables[v.name] = { description: v.description, resolve: async () => v.value }
  }

  const config: Config['config'] = {}
  for (const c of fixture.config) {
    config[c.name] = {
      type: c.type,
      ...(c.kind ? { kind: c.kind } : {}),
      ...(c.scope ? { scope: c.scope } : {}),
      ...(c.default !== undefined ? { default: c.default } : {}),
      description: c.description ?? '',
    }
  }

  return new Extension(bus, {
    id: fixture.ext.id,
    version: fixture.ext.version,
    tools,
    variables,
    config,
  })
}

describe('shared broker cases', () => {
  for (const c of table.cases) {
    it.skipIf(!reachable)(`${c.id}: ${c.why}`, async () => {
      const agBus = await connect(url!)
      const exBus = await connect(url!)
      const ext = buildExt(exBus)
      await ext.serve(CTX(10_000))
      try {
        const agent = new Agent(agBus)

        if (c.resolveVariable) {
          const rv = c.resolveVariable
          const [value, ok] = await agent.resolveVariable(CTX(15_000), T, rv.session, rv.provider, rv.name)
          expect(ok).toBe(c.expect['ok'])
          expect(value).toBe(c.expect['value'])
          return
        }

        const call = c.call!
        const r = await agent.callTool(
          CTX(15_000),
          T,
          call.session,
          fixture.ext.id,
          call.tool,
          call.callId ?? `c-${call.tool}`,
          call.args ?? {},
        )

        if (c.expect['errorCode'] !== undefined) {
          expect(r.error, `${c.why}: expected an error`).toBeDefined()
          expect(r.error?.code).toBe(c.expect['errorCode'])
        }
        if (c.expect['errorMessage'] !== undefined) {
          expect(r.error?.message).toBe(c.expect['errorMessage'])
        }
        if (c.expect['content'] !== undefined) {
          expect(r.content).toBe(c.expect['content'])
        }
        if (c.expect['contentEmpty'] === true) {
          expect(r.content ?? '').toBe('')
        }
        if (c.expect['data'] !== undefined) {
          expect(r.data).toEqual(c.expect['data'])
        }
      } finally {
        await ext.close()
        await agBus.close()
        await exBus.close()
      }
    })
  }
})
