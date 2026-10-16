// Static pre-shared identity signing (HMAC-SHA256). The TS twin of the Go
// `easybus-sdk/identity` package: a message carries the sender's `easybus-id`
// plus an HMAC (`easybus-sig`) over canonical fields, so receivers authenticate
// the sender without a CA.

import { createHmac, timingSafeEqual } from 'node:crypto'

/** Identity is a static pre-shared id + secret. */
export interface Identity {
  id: string
  secret: string
}

/** Fields are the covered message fields, in signing order. */
export interface Fields {
  tenant?: string
  ch: string
  kind: string
  id?: string
  payload?: unknown
}

/** Header is the sender-side auth attachment. */
export interface Header {
  id: string
  sig: string
}

function canonical(id: string, f: Fields): string {
  let payload = ''
  if (f.payload !== undefined && f.payload !== null) {
    try {
      payload = JSON.stringify(f.payload)
    } catch {
      payload = ''
    }
  }
  return `${id}\n${f.tenant ?? ''}\n${f.ch}\n${f.kind}\n${f.id ?? ''}\n${payload}`
}

function sign(identity: Identity, f: Fields): string {
  return createHmac('sha256', identity.secret)
    .update(canonical(identity.id, f), 'utf8')
    .digest('base64url')
}

/** AuthHeader builds the sender-side auth header. */
export function authHeader(identity: Identity, f: Fields): Header {
  return { id: identity.id, sig: sign(identity, f) }
}

/** Verify checks an HMAC against a known secret, constant-time. */
export function verify(claimedId: string, secret: string, f: Fields, provided: string): boolean {
  const want = sign({ id: claimedId, secret }, f)
  const a = Buffer.from(want)
  const b = Buffer.from(provided)
  return a.length === b.length && timingSafeEqual(a, b)
}
