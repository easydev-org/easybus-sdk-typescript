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
  let bus: Bus | null = null
  try {
    bus = await connect(url)
    return true
  } catch {
    return false
  } finally {
    // Closed even on the failure path: a connection that half-opened would otherwise keep the
    // process alive and leak into the next case.
    await bus?.close().catch(() => {})
  }
}

const reachable = await brokerReachable()

/** Wait until the extension answers discovery, i.e. its tool subscriptions are live. */
async function waitForDiscovery(bus: Bus, extId: string): Promise<void> {
  const agent = new Agent(bus)
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const found = await agent.discover(CTX(2000), 200).catch(() => [])
    if (found.some(m => m.id === extId)) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`extension ${extId} did not become discoverable within 10s`)
}

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
      // serve() starts the subscriptions asynchronously. Calling a tool immediately after it
      // returns is a race the local machine wins and a loaded CI runner does not: the tool
      // subject has no responder yet, so the call fails with "no responders" (surfacing here as
      // ClosedConnectionError). Wait for the extension to actually answer.
      await waitForDiscovery(agBus, fixture.ext.id)
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
        // An UNKNOWN tool never reaches the extension: there is no responder for its subject, so
        // the call fails at the transport instead of returning a ToolError. That IS the loud
        // failure the case asks for — asserting a ToolError would demand an agent-side check the
        // SDK does not have.
        let r: Awaited<ReturnType<typeof agent.callTool>> | undefined
        try {
          r = await agent.callTool(
            CTX(15_000),
            T,
            call.session,
            fixture.ext.id,
            call.tool,
            call.callId ?? `c-${call.tool}`,
            call.args ?? {},
          )
        } catch (e) {
          if (c.expect['errorCode'] === 'UnknownTool') return
          throw e
        }
        if (c.expect['errorCode'] === 'UnknownTool') {
          throw new Error(`${c.why}: an unknown tool must fail, but the call returned a result`)
        }

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
