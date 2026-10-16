// The extension-role type surface (separated so `extension.ts` can import the
// ConfigStore without a cycle).

import type { ToolErrorCode } from '../protocol/code.js'
export type { ToolErrorCode }

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
  type: string // string | number | boolean | enum | json
  kind?: string // "value" (default) | "model"
  capability?: string
  enumValues?: string[]
  default?: unknown
  scope?: string
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
