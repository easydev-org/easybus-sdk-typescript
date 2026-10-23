/**
 * Permission enforcement, extension side.
 *
 * The agent stores what a session MAY do and hands those grants over on every call. This file
 * is the other half: deciding whether a grant COVERS the call about to happen.
 *
 * WHY the decision lives here: coverage depends on the call's target — this repository, that
 * sandbox — and turning the arguments into that target is domain knowledge only the extension
 * has ("https://host/o/r.git" -> "o/r" is a git rule, not a protocol rule). Keeping it here is
 * what lets the same mechanism serve an extension that guards repositories and one that guards
 * sandboxes.
 *
 * The agent's own check is an optimisation, not a boundary: it can say "this session has no
 * merge permission at all", but it cannot say "this grant covers THIS pull request". Only this
 * file can, and only this file is the security boundary — the extension holds the credential
 * and performs the action.
 */

import type { Grant } from '../wire.js'

/** A grant's params, flattened to strings. */
export type GrantParams = Record<string, string>

/**
 * PermissionDenied is raised when a required permission is absent or does not cover the call.
 *
 * It carries the target that was attempted, so the caller can say WHICH repository was refused
 * rather than "permission denied" — and so an audit log records what was tried.
 */
export class PermissionDenied extends Error {
  readonly key: string
  readonly target: GrantParams
  readonly granted: GrantParams[]

  constructor(key: string, target: GrantParams, granted: GrantParams[]) {
    super(formatDenial(key, target, granted))
    this.name = 'PermissionDenied'
    this.key = key
    this.target = target
    this.granted = granted
  }
}

function formatDenial(key: string, target: GrantParams, granted: GrantParams[]): string {
  const want = formatParams(target)
  let msg = `permission denied: ${key}`
  if (want) msg += ` on ${want}`
  if (granted.length === 0) return `${msg} (no grant held for this permission)`
  return `${msg} (held: ${granted.map(formatParams).join('; ')})`
}

/** Renders params deterministically, so the same gap always reads the same. */
function formatParams(p: GrantParams): string {
  const keys = Object.keys(p).sort()
  return keys.map(k => `${k}=${p[k]}`).join(',')
}

/**
 * The grants for one call, keyed by the AbortSignal that call was given.
 *
 * WHY a WeakMap rather than a new handler parameter: `execute(ctx, args, callId, session,
 * tenant)` is the signature every existing extension already implements. Adding a sixth
 * argument would break all of them for a feature most do not use, and a prompt-style "last
 * argument is optional" would be invisible at the call site.
 *
 * The signal is the right carrier because it is ALREADY per-call, already threaded everywhere a
 * handler can reach, and already garbage-collected with the call — so there is nothing to clean
 * up and nothing that can leak between calls.
 */
const grantsByCall = new WeakMap<AbortSignal, Grant[]>()

/** attachGrants records the grants for one call. Called by the dispatcher. */
export function attachGrants(ctx: AbortSignal, grants: Grant[] | undefined): void {
  if (grants && grants.length > 0) grantsByCall.set(ctx, grants)
}

/** grantsFrom returns the grants attached to a call. */
export function grantsFrom(ctx: AbortSignal): Grant[] {
  return grantsByCall.get(ctx) ?? []
}

/**
 * grantsFor returns the params of every grant held for one key.
 *
 * A session may hold SEVERAL grants of the same key with different params — "merge in
 * agentdev/mrflow" and "merge in scratch/*" are two authorisations, not one. Coverage means at
 * least one of them matches.
 */
export function grantsFor(ctx: AbortSignal, key: string): GrantParams[] {
  const out: GrantParams[] = []
  for (const g of grantsFrom(ctx)) {
    if (g.key !== key) continue
    out.push(structToStrings((g.params ?? {}) as Record<string, unknown>))
  }
  return out
}

/**
 * allowed reports whether the caller may perform `key` against `target`.
 *
 * A grant covers the call when EVERY param it declares matches the target (AND across keys), and
 * at least one grant covers it.
 */
export function allowed(ctx: AbortSignal, key: string, target: GrantParams): boolean {
  return grantsFor(ctx, key).some(granted => matches(granted, target))
}

/**
 * require throws PermissionDenied when the call is not covered, and returns when it is.
 *
 * The expected shape inside a tool:
 *
 *     const target = { repo: repoSlug(argStr(args, 'remote')) }
 *     requirePermission(ctx, 'mr.merge', target)
 */
export function requirePermission(ctx: AbortSignal, key: string, target: GrantParams): void {
  if (allowed(ctx, key, target)) return
  throw new PermissionDenied(key, target, grantsFor(ctx, key))
}

/**
 * matches reports whether a grant's params cover a target.
 *
 * Semantics, deliberately small:
 *  - every key in the GRANT must appear in the target and match (AND across keys);
 *  - a value may use `*` as a wildcard: "agentdev/*" covers "agentdev/mrflow", "*" covers
 *    anything;
 *  - otherwise it is an exact comparison.
 *
 * WHY not regex: a permission a reader cannot predict is one they cannot judge. `*` is the
 * smallest thing that makes "all my repositories" expressible, and a client can explain it in
 * one sentence. An extension that needs more can ignore these params and enforce its own rule.
 */
export function matches(granted: GrantParams, target: GrantParams): boolean {
  for (const [k, want] of Object.entries(granted)) {
    const got = target[k]
    if (got === undefined) return false
    if (!matchValue(want, got)) return false
  }
  return true
}

/** matchValue compares one param value, honouring `*`. */
function matchValue(pattern: string, value: string): boolean {
  if (pattern === '*') return true
  const i = pattern.indexOf('*')
  if (i >= 0) {
    const prefix = pattern.slice(0, i)
    const suffix = pattern.slice(i + 1)
    if (value.length < prefix.length + suffix.length) return false
    return value.startsWith(prefix) && value.endsWith(suffix)
  }
  return pattern === value
}

/** Flattens a param object to strings: the declared leaves are scalars. */
function structToStrings(m: Record<string, unknown>): GrantParams {
  const out: GrantParams = {}
  for (const [k, v] of Object.entries(m)) {
    out[k] = v === null || v === undefined ? '' : String(v)
  }
  return out
}
