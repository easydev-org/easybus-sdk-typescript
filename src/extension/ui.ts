// The browser UI an extension ships, if any.
//
// WHY THIS IS IN THE SDK: every extension that wants a UI needs the same three things — serve static
// files, fall back to index.html for client-side routes, and say where it is mounted so the host can
// set a base path. Written once here, an extension author supplies a directory and a short spec;
// written per repo, every copy drifts and only some handle the fallback correctly.
//
// The UI is served UNDER A PREFIX (`base`) and the host proxies that prefix to this extension. That
// indirection is the point: the browser talks only to the webui's origin, so an iframe embedding the
// UI is SAME-ORIGIN with the host — no CORS, no second certificate, and the host's own credentials
// apply to the requests the UI makes.
//
// THIS IS THE TYPESCRIPT TWIN OF THE GO SDK'S `UISpec`. The behaviour is deliberately identical
// rather than merely similar, because the host treats every extension the same way: it probes
// `<base>/api/v1/ui`, proxies `<base>`, and expects the `api` sub-path to reach the handlers. An
// extension written in one language must be indistinguishable from one written in another.

import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'

/** A handler shaped like Node's request listener, so a UI can wrap an existing server. */
export type UIHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/**
 * Everything the host needs to embed this extension's UI.
 *
 * `dir` is a DIRECTORY ON DISK rather than an embedded asset map: Node has no `go:embed`, and reading
 * from disk keeps the bundle out of the source tree. The image copies the built frontend in beside
 * the code.
 */
export interface UISpec {
  /** Absolute path to the built frontend, e.g. `resolve('ui/dist')`. */
  dir: string
  /**
   * URL prefix the host mounts this UI at, e.g. `/ext/playwright`.
   *
   * Served VERBATIM (not stripped), because a hash-routed SPA needs its base to resolve its own asset
   * URLs. Requests outside it are left to the wrapped handler untouched.
   */
  base: string
  /** Shown in the host's breadcrumb and tab. */
  title: string
  /**
   * The extension's own id, reported by the host's probe.
   *
   * Passed in rather than derived from `base`: they agree by convention, and when they do not, the
   * host needs to hear the extension's own answer so a mismatch shows up as a 404 rather than as
   * data attributed to the wrong extension.
   */
  id: string
  /**
   * A sub-path of `base` that belongs to this extension's OWN handlers rather than to the bundle.
   *
   * Without it a request like `/ext/playwright/api/contexts` has no file extension, so the SPA
   * fallback would answer it with index.html — the browser then fails to parse HTML as JSON and every
   * call looks broken, with no failing URL to point at.
   *
   * Relative to `base` (e.g. `/api`), and only meaningful when `handler` also serves those paths.
   */
  apiPrefix?: string
  /**
   * The extension's own API, called for paths under `apiPrefix`.
   *
   * Omitted means a UI with no API of its own. Requests under `apiPrefix` then 404 rather than
   * falling through to index.html, which would look like a successful call that returned HTML.
   */
  handler?: UIHandler
}

/** The MIME types a built frontend needs; anything else is served as octet-stream. */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

/** A path with no extension is a client-side ROUTE, not a file. */
function isRoute(rel: string): boolean {
  const last = rel.split('/').pop() ?? ''
  return !last.includes('.')
}

/**
 * Resolve a request path to a file INSIDE `dir`, or null when it escapes.
 *
 * The containment check is the security boundary of this file: without it a traversal in the path
 * would read the host's filesystem. Compared after `resolve`, so it holds for `..` segments and for
 * any platform's separator in one step.
 */
function safeJoin(dir: string, rel: string): string | null {
  const root = resolve(dir)
  const full = resolve(root, '.' + sep + rel)
  if (full !== root && !full.startsWith(root + sep)) return null
  return full
}

/**
 * Wrap `handler` so the UI is served, and return the composite handler.
 *
 * Paths OUTSIDE `base` reach `handler` untouched, so probes and API routes keep working exactly as
 * before. Paths INSIDE it serve the UI: a file if one matches, otherwise index.html — what a
 * client-side router needs.
 */
export function mountUI(handler: UIHandler | undefined, spec: UISpec): UIHandler {
  const base = spec.base.replace(/\/+$/, '')
  const apiPrefix = spec.apiPrefix ? base + '/' + spec.apiPrefix.replace(/^\/+|\/+$/g, '') : ''

  return async (req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'

    // Not ours: let the extension's own routing deal with it.
    if (path !== base && !path.startsWith(base + '/')) {
      await handler?.(req, res)
      return
    }

    // Answer the host's "does this extension have a UI?" probe.
    //
    // FIRST, before the API prefix below: `apiPrefix` is usually `/api`, and the probe lives at
    // `/api/v1/ui` — so checking the prefix first hands the probe to the extension's own handler,
    // which does not know that path and answers 404. The host then concludes there is no UI and
    // never offers it, with the extension serving one perfectly well.
    if (path === base + '/api/v1/ui') {
      send(
        res,
        200,
        'application/json; charset=utf-8',
        JSON.stringify({ id: spec.id, base: spec.base, title: spec.title }),
      )
      return
    }

    // The extension's own API lives under the same prefix, so it must reach the handler instead of
    // the bundle. Checked BEFORE the SPA fallback, which would otherwise swallow it.
    if (apiPrefix !== '' && (path === apiPrefix || path.startsWith(apiPrefix + '/'))) {
      if (handler) {
        await handler(req, res)
        return
      }
      send(res, 404, 'application/json; charset=utf-8', JSON.stringify({ error: 'no API here' }))
      return
    }

    const rel = path.slice(base.length).replace(/^\/+/, '')
    const file = safeJoin(spec.dir, rel === '' || isRoute(rel) ? 'index.html' : rel)
    if (file === null) {
      send(res, 404, 'text/plain; charset=utf-8', 'not found')
      return
    }

    try {
      send(res, 200, MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', await readFile(file))
    } catch {
      // A missing FILE must 404 rather than fall back to index.html: a missing asset answered with
      // HTML is a blank page with no error anywhere.
      send(res, 404, 'text/plain; charset=utf-8', 'not found')
    }
  }
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.statusCode = status
  res.setHeader('content-type', type)
  res.setHeader('x-content-type-options', 'nosniff')
  // Content a host embeds must not be framed by anything else.
  res.setHeader('x-frame-options', 'SAMEORIGIN')
  res.end(body)
}
