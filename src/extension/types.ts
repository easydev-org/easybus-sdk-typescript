// The extension-role type surface (separated so `extension.ts` can import the
// ConfigStore without a cycle).

import type { ToolErrorCode } from '../protocol/code.js'
export type { ToolErrorCode }

/** Config knob kinds (kind is an open string; these are the special values). */
export const CONFIG_KIND_VALUE = 'value'
export const CONFIG_KIND_MODEL = 'model'
export const CONFIG_KIND_SECRET = 'secret'

/** ToolResultData is what a tool Execute returns. */
export interface ToolResultData {
  content?: string
  data?: unknown
  object?: { id: string; contentType?: string }
}

/** ToolSpec describes a tool and its executor. */
export interface ToolSpec {
  description?: string
  descriptions?: Record<string, string>
  inputSchema?: Record<string, unknown>
  requiredConfig?: string[]
  /** Grouping of this tool (pvc, build, storage, ...). Organisational only. */
  namespace?: string
  /**
   * Permission keys a caller must hold to invoke this tool.
   *
   * Checked twice, on purpose. The dispatcher does a COARSE check — is the key present at all —
   * because it cannot know what the params mean. The tool then calls `requirePermission` with
   * the target it resolved from its own arguments, and that second check is the real boundary.
   */
  requires?: string[]
  execute: (ctx: AbortSignal, args: Record<string, unknown>, callId: string, sessionName: string, tenant: string) => Promise<ToolResultData>
}

/** VariableSpec describes one template variable and its lazy resolver. */
export interface VariableSpec {
  description?: string
  descriptions?: Record<string, string>
  scope?: string // "global" | "session"
  resolve?: (ctx: AbortSignal, sessionName: string, tenant: string) => Promise<string>
}

/** ConfigSpec declares one config knob. */
export interface ConfigSpec {
  description?: string
  descriptions?: Record<string, string>
  // string | number | boolean | enum | json | list | object
  type: string
  kind?: string // "value" (default) | "model"
  capability?: string
  enumValues?: string[]
  default?: unknown
  scope?: string
  /** Shape of a structured knob (type list/object). Empty = json blob fallback. */
  fields?: FieldSpec[]
  /** Element type when type === 'list'. */
  itemType?: string
  minItems?: number
  maxItems?: number
  /**
   * Scopes this knob's stored value to one namespace of the extension.
   * Empty = extension-level (shared by all its namespaces).
   */
  namespace?: string
}

/**
 * FieldSpec is one key of a structured config value (or of one list item's keys).
 *
 * It is what lets a client render a form instead of a JSON textarea: `enum`
 * becomes a picker, `kind: 'secret'` a masked input, `format: 'uri'` a URL field.
 */
export interface FieldSpec {
  name: string
  type?: string
  kind?: string
  format?: string
  enumValues?: string[]
  default?: unknown
  required?: boolean
  description?: string
  descriptions?: Record<string, string>
  /** Nested shape for an object field (one level, like the manifest). */
  fields?: FieldSpec[]
}

/** NamespaceSpec is one declared grouping of an extension's tools and config. */
export interface NamespaceSpec {
  name: string
  description?: string
  descriptions?: Record<string, string>
}

export interface HookSchemas {
  call?: Record<string, Record<string, unknown>>
  event?: Record<string, Record<string, unknown>>
}

export type OnCallHook = (ctx: AbortSignal, hook: string, sessionName: string, args: Record<string, unknown>, tenant: string) => Promise<{ ok: boolean; data?: unknown; error?: { code: ToolErrorCode; message: string } }>
export type OnEventHook = (ctx: AbortSignal, hook: string, sessionName: string, payload: unknown, tenant: string) => Promise<void>
export type OnConfigChange = (ctx: AbortSignal, name: string, value: unknown, sessionName: string, get: (name: string, sessionName: string) => unknown) => Promise<void>
export type OnLifecycle = (ctx: AbortSignal, ev: LifecycleEvent, tenant: string) => Promise<void>

export interface LifecycleEvent {
  kind: string // created | forked | renamed | deleted
  sessionName: string
  from?: string
  to?: string
  parent?: string
  id?: string
  payload?: unknown
}

/** Config describes an extension. */
export interface Config {
  id: string
  version: string
  replicaId?: string
  tools?: Record<string, ToolSpec>
  variables?: Record<string, VariableSpec>
  config?: Record<string, ConfigSpec>
  /** Declared groupings (pvc, build, storage, ...), in the author's ORDER. */
  namespaces?: NamespaceSpec[]
  callHooks?: string[]
  eventHooks?: string[]
  lifecycle?: string[]
  hookSchemas?: HookSchemas
  onCallHook?: OnCallHook
  onEventHook?: OnEventHook
  onConfigChange?: OnConfigChange
  onLifecycle?: OnLifecycle
  onInterrupt?: (ctx: AbortSignal, sessionName: string, reason: string, tenant: string) => void
}
