/**
 * The UI mount, tested through the handler the host actually talks to.
 *
 * The rules that matter, and why each is here:
 *
 *   * paths outside the mount reach the extension untouched — probes and API routes must not be
 *     swallowed by a static file server;
 *   * the API sub-path reaches the handler, not index.html — otherwise every call returns HTML and
 *     the browser fails to parse it as JSON with no failing URL to point at;
 *   * a missing FILE 404s — a missing asset answered with index.html is a blank page and no error;
 *   * a traversal cannot escape the bundle directory.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mountUI, type UISpec } from './ui.js'

let root = ''
let spec: UISpec

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ui-test-'))
  await writeFile(join(root, 'index.html'), '<!doctype html><title>ui</title>')
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, 'assets', 'index-abc.js'), 'console.log(1)')
  // A secret outside the bundle, to prove the traversal guard.
  await writeFile(join(root, '..', 'secret.txt'), 'do not serve')

  spec = { dir: root, base: '/ext/demo', title: 'Demo', id: 'demo', apiPrefix: '/api' }
})

afterAll(async () => {
  await rm(join(root, '..', 'secret.txt'), { force: true })
  await rm(root, { recursive: true, force: true })
})

/** Drive the handler with a URL and report what it answered. */
async function call(
  url: string,
  handler?: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ status: number; type: string; body: string }> {
  const h = mountUI(handler, spec)
  let status = 0
  let type = ''
  let body = ''
  // A minimal response double. `statusCode` is captured through a local rather than `this`, because
  // the handler assigns it as a plain property and `this` inside `end` is not that object.
  let code = 0
  const res = {
    get statusCode() {
      return code
    },
    set statusCode(v: number) {
      code = v
    },
    setHeader(k: string, v: string) {
      if (k.toLowerCase() === 'content-type') type = v
    },
    end(b?: string | Buffer) {
      body = b === undefined ? '' : b.toString()
      status = code
    },
  } as unknown as ServerResponse
  await h({ url } as IncomingMessage, res)
  return { status, type, body }
}

describe('mountUI', () => {
  it('serves index.html at the mount root', async () => {
    const r = await call('/ext/demo/')
    expect(r.status).toBe(200)
    expect(r.type).toContain('text/html')
    expect(r.body).toContain('<title>ui</title>')
  })

  it('serves a real asset with its own content type', async () => {
    const r = await call('/ext/demo/assets/index-abc.js')
    expect(r.status).toBe(200)
    expect(r.type).toContain('javascript')
    expect(r.body).toBe('console.log(1)')
  })

  // A hash route still resolves to index.html, because the router needs the shell.
  it('falls back to index.html for a client-side route', async () => {
    const r = await call('/ext/demo/contexts/abc')
    expect(r.status).toBe(200)
    expect(r.body).toContain('<title>ui</title>')
  })

  // A missing asset is a 404, NOT the shell: answering HTML here is a blank page with no error.
  it('404s a missing file instead of returning index.html', async () => {
    const r = await call('/ext/demo/assets/gone.js')
    expect(r.status).toBe(404)
  })

  it('routes the API sub-path to the handler, not to the shell', async () => {
    const r = await call('/ext/demo/api/contexts', (_req, res) => {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end('{"ok":true}')
    })
    expect(r.status).toBe(200)
    expect(r.body).toBe('{"ok":true}')
  })

  it('answers the host probe under the mount', async () => {
    const r = await call('/ext/demo/api/v1/ui')
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toEqual({ id: 'demo', base: '/ext/demo', title: 'Demo' })
  })

  it('leaves paths outside the mount to the extension', async () => {
    const r = await call('/api/v1/health', (_req, res) => {
      res.statusCode = 200
      res.end('health')
    })
    expect(r.status).toBe(200)
    expect(r.body).toBe('health')
  })

  // The security boundary: a traversal must not read outside the bundle directory.
  it('refuses a path that escapes the bundle', async () => {
    for (const p of [
      '/ext/demo/../secret.txt',
      '/ext/demo/%2e%2e/secret.txt',
      '/ext/demo/assets/../../secret.txt',
    ]) {
      const r = await call(p)
      expect(r.body, `served something for ${p}`).not.toContain('do not serve')
    }
  })

  it('404s the API sub-path when the extension has no handler', async () => {
    const r = await call('/ext/demo/api/contexts')
    expect(r.status).toBe(404)
    // JSON, not HTML: the caller parses this and the error must be legible.
    expect(r.type).toContain('json')
  })
})
