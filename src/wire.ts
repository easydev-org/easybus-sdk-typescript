// Wire types — re-exported from the protoc-generated module (protoc-gen-es),
// the TypeScript twin of the Go SDK's `compat.go`. EVERY message that rides the
// NATS transport is defined by proto/easybus/v1/protocol.proto and generated;
// NOTHING here is hand-written. Runtime SDK-authoring types (extension.Config,
// manifest.Manifest, bus.RequestOpts, …) are NOT wire types and live elsewhere.
//
// The Go SDK marshals these with `encoding/json` (NOT protojson): snake_case
// field names, proto enum values as INTEGERS. Encode/decode must therefore use
// protobuf-es with `useProtoFieldName: true` + `enumAsInteger: true` — see
// `encodeMessage`/`decodeMessage` below.

import { fromJson, toJson, type JsonValue, type MessageShape, type DescMessage } from '@bufbuild/protobuf'
import { ValueSchema, type Value } from '@bufbuild/protobuf/wkt'
import {
  Envelope_Kind,
  ConfigSetSchema,
  ConfigSnapshotSchema,
  EnvelopeSchema,
  ErrorPayloadSchema,
  ExtensionConfigItemSchema,
  ExtensionManifestSchema,
  ExtensionToolSchema,
  ExtensionVariableSchema,
  ExtensionVariableValueSchema,
  HookCallSchema,
  HookEventSchema,
  HookResponseSchema,
  HookSpecSchema,
  InterruptSignalSchema,
  LifecycleEventSchema,
  MailboxMessageSchema,
  ObjectRefSchema,
  ToolCallEnvelopeSchema,
  ToolErrorSchema,
  ToolProgressSchema,
  ToolResultSchema,
  GrantSchema,
  PermissionDeclSchema,
  ExtensionChannelSchema,
  ChannelTopicSchema,
} from './gen/easybus/v1/protocol_pb.js'

// ---- message types (generated) --------------------------------------------

export type {
  Envelope,
  ErrorPayload,
  ObjectRef,
  ToolCallEnvelope,
  ToolProgress,
  ToolResult,
  ToolError,
  // Permission and channel types. Re-exported so an extension author does not have to reach
  // into the generated module to describe a grant.
  Grant,
  PermissionDecl,
  ExtensionChannel,
  ChannelTopic,
  ExtensionVariable,
  ExtensionVariableValue,
  ExtensionConfigItem,
  ConfigSet,
  ConfigSnapshot,
  HookCall,
  HookEvent,
  HookResponse,
  HookSpec,
  LifecycleEvent,
  MailboxMessage,
  InterruptSignal,
  ExtensionTool,
  ExtensionManifest,
} from './gen/easybus/v1/protocol_pb.js'

// ---- enums (generated) -----------------------------------------------------

export { Code, Envelope_Kind, LifecycleEvent_Kind } from './gen/easybus/v1/protocol_pb.js'

// ---- schemas (generated; used by encode/decode) ----------------------------

export {
  ConfigSetSchema,
  ConfigSnapshotSchema,
  EnvelopeSchema,
  ErrorPayloadSchema,
  ExtensionConfigItemSchema,
  ExtensionManifestSchema,
  ExtensionToolSchema,
  ExtensionVariableSchema,
  ExtensionVariableValueSchema,
  HookCallSchema,
  HookEventSchema,
  HookResponseSchema,
  HookSpecSchema,
  InterruptSignalSchema,
  LifecycleEventSchema,
  MailboxMessageSchema,
  ObjectRefSchema,
  ToolCallEnvelopeSchema,
  ToolErrorSchema,
  ToolProgressSchema,
  ToolResultSchema,
} from './gen/easybus/v1/protocol_pb.js'

// ---- the Go-compatible JSON codec ------------------------------------------

/** Encode a generated message to the Go-compatible JSON bytes (snake_case,
 *  integer enums) — the wire form `encoding/json` produces on the Go side. */
export function encodeMessage<Desc extends DescMessage>(schema: Desc, msg: MessageShape<Desc>): Uint8Array {
  const json = toJson(schema, msg, { useProtoFieldName: true, enumAsInteger: true })
  return new TextEncoder().encode(JSON.stringify(json))
}

/** Decode Go-compatible JSON bytes into a generated message. */
export function decodeMessage<Desc extends DescMessage>(schema: Desc, data: Uint8Array): MessageShape<Desc> {
  const json = JSON.parse(new TextDecoder().decode(data)) as JsonValue
  return fromJson(schema, json)
}

// ---- Envelope (special: `kind` is a SHORT STRING on the wire) --------------
//
// The Go transport marshals a `rawEnvelope` whose `Kind` field is a plain
// `string` ("req" / "pub" / "queue") — NOT the proto enum name and NOT an
// integer. (The generated `Envelope_Kind` enum is only used in-process.) Every
// OTHER enum on the wire (e.g. `Code`) IS an integer, so this override is
// specific to the envelope's `kind`.

const ENVELOPE_KIND_TO_STRING: Record<number, string> = {
  [Envelope_Kind.REQ]: 'req',
  [Envelope_Kind.PUB]: 'pub',
  [Envelope_Kind.QUEUE]: 'queue',
}
const ENVELOPE_KIND_FROM_STRING: Record<string, Envelope_Kind> = {
  req: Envelope_Kind.REQ,
  pub: Envelope_Kind.PUB,
  queue: Envelope_Kind.QUEUE,
}

/** jsonToValue wraps a JSON body into a google.protobuf.Value. */
export function jsonToValue(payload: unknown): Value {
  return fromJson(ValueSchema, (payload ?? {}) as JsonValue)
}

/** encodeEnvelope builds the Go-compatible JSON bytes for an Envelope. */
export function encodeEnvelope(env: MessageShape<typeof EnvelopeSchema>): Uint8Array {
  const json = toJson(EnvelopeSchema, env, { useProtoFieldName: true, enumAsInteger: true }) as Record<string, unknown>
  json['kind'] = ENVELOPE_KIND_TO_STRING[env.kind] ?? 'pub'
  return new TextEncoder().encode(JSON.stringify(json))
}

/** decodeEnvelope parses Go-compatible JSON bytes into an Envelope. */
export function decodeEnvelope(data: Uint8Array): MessageShape<typeof EnvelopeSchema> {
  const json = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>
  if (typeof json['kind'] === 'string') json['kind'] = ENVELOPE_KIND_FROM_STRING[json['kind']] ?? Envelope_Kind.PUB
  return fromJson(EnvelopeSchema, json as JsonValue)
}

/** envelopeKindString maps the enum back to the wire string. */
export function envelopeKindString(env: MessageShape<typeof EnvelopeSchema>): string {
  return ENVELOPE_KIND_TO_STRING[env.kind] ?? 'pub'
}
