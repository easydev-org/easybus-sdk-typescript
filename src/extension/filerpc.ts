// Agent-served file RPCs — the TS twin of the Go `easybus-sdk/extension`
// `filerpc.go`. A DB-less, store-less extension (no S3 credentials, no agent
// DB) cannot mint a canonical `file:<code>` on its own, so it asks the AGENT
// to persist the bytes + metadata via the SAME path as an in-process ingest.
//
// BYTES NEVER RIDE THE MESSAGE: the bytes are first put in the transient
// object store (chunked by the transport, so any size is fine) and only the
// object reference travels in the request.

import type { Bus } from '../bus/bus.js'
import { chFileGet, chFileIngest, newID, tenantObjectName } from '../protocol/protocol.js'
import { valueToJson } from '../transport/nats/nats.js'

/** FileIngestRequest asks the agent to store bytes and return a file code. */
export interface FileIngestRequest {
  code?: string
  name: string
  object: string
  session_name?: string
}

/** FileIngestResponse is the reply to a FileIngestRequest. `mime` is the content
 *  type the agent DERIVED from the bytes (the caller supplies none). */
export interface FileIngestResponse {
  ok: boolean
  code?: string
  mime?: string
  error?: { code: string; message: string }
}

/** FileMetaWire mirrors the agent's file metadata record on the wire. */
export interface FileMetaWire {
  code: string
  sha256: string
  name: string
  mime: string
  size: number
  uploader_session?: string
  created_at: string
  width?: number
  height?: number
  duration_ms?: number
  thumb_code?: string
  thumbhash?: string
}

/** FileGetResponse is the reply to a FileGetRequest. As with ingest, bytes never
 *  ride the message: the agent writes them to the transient object store and
 *  returns only the object reference; the caller reads it via objectGet. */
export interface FileGetResponse {
  ok: boolean
  meta?: FileMetaWire
  object?: string
  error?: { code: string; message: string }
}

/**
 * ingestFileViaAgent stores bytes through the AGENT (a 1:1 `req` on
 * `easybus.<tenant>.file.ingest`) and returns the canonical `file:<code>` plus
 * the content type the agent DERIVED from the bytes (callers pass no mime).
 */
export async function ingestFileViaAgent(
  bus: Bus,
  tenant: string,
  input: { name: string; data: Uint8Array; sessionName?: string },
): Promise<{ code: string; mime: string }> {
  const object = `${newID()}.ingest`
  await bus.objectPut(AbortSignal.timeout(60_000), tenantObjectName(tenant, object), input.data)
  const req: FileIngestRequest = { name: input.name, object }
  if (input.sessionName) req.session_name = input.sessionName
  const env = await bus.request(AbortSignal.timeout(60_000), chFileIngest(tenant), req, {
    tenant,
    ...(input.sessionName ? { sessionName: input.sessionName } : {}),
  })
  if (!env) throw new Error('file ingest: no reply')
  const res = valueToJson(env.payload) as FileIngestResponse
  if (!res.ok) {
    throw new Error(`file ingest: ${res.error?.message || 'failed'}`)
  }
  return { code: res.code ?? '', mime: res.mime ?? '' }
}

/**
 * getFileViaAgent fetches a stored file's bytes + metadata through the agent
 * (a 1:1 `req` on `easybus.<tenant>.file.get`). Returns null when the file is
 * absent. The agent writes the bytes to the transient object store and returns
 * the reference, so the bytes never ride the message.
 */
export async function getFileViaAgent(
  bus: Bus,
  tenant: string,
  code: string,
): Promise<{ meta: FileMetaWire; data: Uint8Array } | null> {
  const env = await bus.request(AbortSignal.timeout(60_000), chFileGet(tenant), { code }, { tenant })
  if (!env) return null
  const res = valueToJson(env.payload) as FileGetResponse
  if (!res.ok || !res.meta || !res.object) return null
  const data = await bus.objectGet(AbortSignal.timeout(60_000), tenantObjectName(tenant, res.object))
  if (data === null) return null
  return { meta: res.meta, data }
}
