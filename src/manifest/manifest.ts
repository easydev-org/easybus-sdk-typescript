// The YAML manifest -> extension Config builder, the TS twin of the Go
// `easybus-sdk/manifest` package. The manifest declares id/version/tools/
// variables/config/lifecycle/hooks; handlers are bound by name.

import { parse as parseYaml } from 'yaml'
import type { Config, ConfigSpec, FieldSpec, HookSchemas, NamespaceSpec, OnCallHook, OnConfigChange, OnEventHook, OnLifecycle, ToolSpec, VariableSpec } from '../extension/types.js'
import { CONFIG_KIND_SECRET } from '../extension/types.js'

export interface ManifestTool {
  name: string
  description?: string
  descriptions?: Record<string, string>
  input_schema?: Record<string, unknown>
  required_config?: string[]
  /**
   * Grouping of this tool (pvc, build, storage, ...). Organisational only: the
   * tool keeps its name; it lets a client group the list.
   */
  namespace?: string
  /**
   * Permission keys a caller must hold to invoke this tool.
   *
   * The manifest is the single source: the dispatcher reads this to refuse a call the session
   * holds no grant for, and a client reads it to know what to ask the user for.
   */
  requires?: string[]
}

/**
 * One permission an extension can require.
 *
 * A permission is a (key, params) pair, NOT a bare name: "merge in agentdev/mrflow" is a
 * different authorisation from "merge in other/repo", so a session may hold several grants of
 * the same key with different params.
 */
export interface ManifestPermission {
  key: string
  label?: string
  descriptions?: Record<string, string>
  /** How loudly a client should warn: read | write | destructive. Presentation only. */
  risk?: string
  /**
   * The params a grant of this key carries, reusing the config field schema so a client renders
   * one form implementation for both instead of a second type system.
   */
  params?: ManifestField[]
}

/**
 * One channel an extension publishes to, and the topics it uses.
 *
 * Declared so a user can see the topic format before subscribing: "tag.<owner>/<repo>.<tag>" is
 * something they can write a pattern from; a bare channel name is not.
 */
export interface ManifestChannel {
  name: string
  description?: string
  descriptions?: Record<string, string>
  topics?: { pattern: string; description?: string; descriptions?: Record<string, string> }[]
}

/**
 * One key of a structured config value (or of one list item's keys).
 *
 * It exists so a client can render a real form instead of a JSON textarea: an
 * `enum` becomes a picker, `kind: 'secret'` a masked input, `format: 'uri'` a URL
 * field, and a list of objects becomes repeatable cards with a "+".
 */
export interface ManifestField {
  name: string
  type?: string
  kind?: string
  format?: string
  enum_values?: string[]
  default?: unknown
  required?: boolean
  description?: string
  descriptions?: Record<string, string>
  /** Nested shape for an object field (one level, like the manifest). */
  fields?: ManifestField[]
}

/** One declared grouping of an extension's tools and config. */
export interface ManifestNamespace {
  name: string
  description?: string
  descriptions?: Record<string, string>
}

/**
 * toFieldSpecs maps declared fields onto the runtime specs (recursing one level).
 *
 * A field may itself be an object; both the client renderer and the validator
 * stop at that depth on purpose.
 */
function toFieldSpecs(fields: ManifestField[] | undefined): FieldSpec[] {
  return (fields ?? []).map(f => ({
    name: f.name,
    type: f.type ?? 'string',
    kind: f.kind ?? '',
    format: f.format ?? '',
    enumValues: f.enum_values ?? [],
    default: f.default,
    required: f.required ?? false,
    description: f.description ?? '',
    descriptions: f.descriptions ?? {},
    fields: toFieldSpecs(f.fields),
  }))
}

export interface ManifestVariable {
  name: string
  description?: string
  descriptions?: Record<string, string>
  scope?: string
}

export interface ManifestConfig {
  name: string
  type?: string
  kind?: string
  capability?: string
  enum_values?: string[]
  default?: unknown
  description?: string
  descriptions?: Record<string, string>
  scope?: string
  /** Shape of a structured knob (type list/object). Empty = json blob fallback. */
  fields?: ManifestField[]
  /** Element type when type === 'list'. */
  item_type?: string
  min_items?: number
  max_items?: number
  /**
   * Scopes this knob's stored value to one namespace of the extension.
   * Empty = extension-level (shared by all its namespaces).
   */
  namespace?: string
}

export interface ManifestHooks {
  call?: string[]
  event?: string[]
  call_schemas?: Record<string, Record<string, unknown>>
  event_schemas?: Record<string, Record<string, unknown>>
}

/** Manifest is the YAML-declared extension protocol. */
export interface Manifest {
  id: string
  version: string
  tools?: ManifestTool[]
  variables?: ManifestVariable[]
  config?: ManifestConfig[]
  lifecycle?: string[]
  hooks?: ManifestHooks
  /** Declared groupings (pvc, build, storage, ...), in the author's ORDER. */
  namespaces?: ManifestNamespace[]
  /**
   * Permissions this extension can require.
   *
   * Missing this field is why a manifest could declare `permissions:` and have them silently
   * dropped: the parser returned the object it was given, the dispatcher looked for a field the
   * type did not have, and every tool ran ungated while the YAML said otherwise.
   */
  permissions?: ManifestPermission[]
  /**
   * Channels this extension publishes to.
   *
   * Same reasoning: without the field here, a declared channel never reaches a client, so nobody
   * can discover the topic format to subscribe to.
   */
  channels?: ManifestChannel[]
}

/** ParseManifest parses YAML manifest text. */
export function parseManifest(data: string): Manifest {
  const m = parseYaml(data) as Manifest
  if (!m || !m.id) throw new Error('manifest: id is required')
  for (const c of m.config ?? []) {
    if (c.kind !== CONFIG_KIND_SECRET) continue
    // A secret knob is a credential: its value is never returned to a client,
    // and a `default` would ride the (broadcast) manifest — so a secret MUST NOT
    // declare a default.
    //
    // It MAY be structured (a list/object whose records each carry their own
    // `kind: secret`), which is how a sandbox list declares a token per sandbox:
    // withholding the whole knob is then a second guard on top of the per-field
    // masking.
    if (c.type && !['string', 'list', 'object'].includes(c.type)) {
      throw new Error(`manifest: config "${c.name}": kind=secret requires type string, list or object (got "${c.type}")`)
    }
    if (c.default !== undefined && c.default !== null && c.default !== '') {
      throw new Error(`manifest: config "${c.name}": kind=secret must not declare a default`)
    }
  }
  return m
}

/** Bindings carries the name-keyed handlers/resolvers used to build a Config. */
export interface Bindings {
  handlers: Record<string, Omit<ToolSpec, 'description' | 'descriptions' | 'inputSchema' | 'requiredConfig'>>
  variables?: Record<string, VariableSpec>
  onCallHook?: OnCallHook
  onEventHook?: OnEventHook
  onConfigChange?: OnConfigChange
  onLifecycle?: OnLifecycle
}

/** BuildConfig builds an extension.Config from the manifest + bindings. */
export function buildConfig(m: Manifest, b: Bindings): Config {
  const tools: Record<string, ToolSpec> = {}
  for (const t of m.tools ?? []) {
    const h = b.handlers[t.name]
    if (!h) continue
    tools[t.name] = {
      ...h,
      description: t.description ?? '',
      descriptions: t.descriptions ?? {},
      inputSchema: t.input_schema ?? {},
      requiredConfig: t.required_config ?? [],
      namespace: t.namespace ?? '',
      // The manifest is the single source for what a tool requires. Dropping it here meant a
      // tool could declare `requires: [mr.merge]` in YAML and reach the dispatcher with an empty
      // list — no coarse check, no refusal, and no sign anything was wrong.
      requires: t.requires ?? [],
    }
  }
  const variables: Record<string, VariableSpec> = {}
  for (const v of m.variables ?? []) {
    const r = b.variables?.[v.name]
    variables[v.name] = { description: v.description ?? '', descriptions: v.descriptions ?? {}, scope: v.scope || 'global', ...(r?.resolve ? { resolve: r.resolve } : {}) }
  }
  const config: Record<string, ConfigSpec> = {}
  for (const c of m.config ?? []) {
    config[c.name] = {
      description: c.description ?? '',
      descriptions: c.descriptions ?? {},
      type: c.type ?? 'string',
      kind: c.kind ?? 'value',
      capability: c.capability ?? '',
      enumValues: c.enum_values ?? [],
      default: c.default,
      scope: c.scope ?? 'global',
      fields: toFieldSpecs(c.fields),
      itemType: c.item_type ?? '',
      minItems: c.min_items ?? 0,
      maxItems: c.max_items ?? 0,
      namespace: c.namespace ?? '',
    }
  }
  const namespaces: NamespaceSpec[] = (m.namespaces ?? []).map(n => ({
    name: n.name,
    description: n.description ?? '',
    descriptions: n.descriptions ?? {},
  }))
  const hookSchemas: HookSchemas = { call: m.hooks?.call_schemas ?? {}, event: m.hooks?.event_schemas ?? {} }
  return {
    id: m.id,
    version: m.version,
    tools,
    variables,
    config,
    namespaces,
    // Permissions and channels, carried through from the manifest.
    //
    // This was the last link in a chain that silently dropped them: the YAML parsed, the
    // Manifest type gained the field, and then buildConfig — the function every extension uses to
    // turn a manifest into a running Config — copied everything EXCEPT these. The extension came
    // up looking healthy and declared no permissions at all.
    ...(m.permissions?.length ? {
      permissions: m.permissions.map(p => ({
        key: p.key,
        label: p.label ?? '',
        descriptions: p.descriptions ?? {},
        risk: p.risk ?? '',
        params: toFieldSpecs(p.params ?? []),
      })),
    } : {}),
    ...(m.channels?.length ? {
      channels: m.channels.map(c => ({
        name: c.name,
        description: c.description ?? '',
        descriptions: c.descriptions ?? {},
        topics: (c.topics ?? []).map(t => ({
          pattern: t.pattern,
          description: t.description ?? '',
          descriptions: t.descriptions ?? {},
        })),
      })),
    } : {}),
    callHooks: m.hooks?.call ?? [],
    eventHooks: m.hooks?.event ?? [],
    lifecycle: m.lifecycle ?? [],
    hookSchemas,
    onCallHook: b.onCallHook,
    onEventHook: b.onEventHook,
    onConfigChange: b.onConfigChange,
    onLifecycle: b.onLifecycle,
  }
}
