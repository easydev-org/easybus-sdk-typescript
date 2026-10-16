// The transport-agnostic message bus — the TS twin of the Go `easybus-sdk/bus`
// package. Exactly one production transport exists (NATS); the in-process
// transport (`./inproc`) is the conformance/test double with the same contract.

/** RequestOpts tunes a request or broadcast. */
export interface RequestOpts {
  /** TimeoutMs bounds a 1:1 request; 0 means no timeout. */
  timeoutMs?: number
  /** MaxWaitMs bounds a 1:N collect. */
  maxWaitMs?: number
  /** Rides the envelope's first-class session_name field. */
  sessionName?: string
  /** Rides the envelope's first-class tenant field (else derived from the subject). */
  tenant?: string
}

export interface SubscribeOpts {
  /** Queue group: N subscribers with the same group load-balance. */
  queue?: string
}

export interface InboxConsumeOpts {
  subject: string
}

export interface InboxPublishOpts {
  id: string
  sessionName?: string
  tenant?: string
}

export interface PublishOpts {
  replyTo?: string
  tenant?: string
}

/** Subscription is a live channel subscription. */
export interface Subscription {
  /** Blocks until the next envelope, or null on close/ctx-done. */
  next(ctx: AbortSignal): Promise<Envelope | null>
  close(): Promise<void>
}

/** KvEvent is one KV watch delivery (initial snapshot first, then live). */
export interface KvEvent {
  key: string
  value: string
  revision: number
  deleted: boolean
  isUpdate: boolean
  /** Marks the snapshot/initial-state boundary. */
  done: boolean
}

/** InboxMsg is a durable-inbox message with explicit ack/nak/term. */
export interface InboxMsg {
  envelope: Envelope
  ack(): void
  nak(delayMs: number): void
  /** Terminate + copy to the dead-letter stream. */
  term(): void
  /** Terminate without the dead-letter copy. */
  termNoDLQ(): void
}

/** InboxSubscription consumes durable-inbox messages. */
export interface InboxSubscription {
  next(ctx: AbortSignal): Promise<InboxMsg | null>
  close(): Promise<void>
}

/**
 * Envelope is the decoded bus envelope. It mirrors the proto `Envelope` but is
 * the SHAPE the bus interface exchanges (the transport maps proto <-> this).
 */
export interface Envelope {
  v?: number
  ch: string
  tenant: string
  kind: 'req' | 'pub' | 'queue'
  payload: unknown
  id?: string
  replyTo?: string
  sessionName?: string
  pending?: number
}

/** Bus is the transport-agnostic message bus. */
export interface Bus {
  request(ctx: AbortSignal, ch: string, payload: unknown, opts?: RequestOpts): Promise<Envelope | null>
  requestMany(ctx: AbortSignal, ch: string, payload: unknown, opts?: RequestOpts): Promise<Envelope[]>
  publish(ctx: AbortSignal, ch: string, payload: unknown, opts?: PublishOpts): Promise<void>
  subscribe(ctx: AbortSignal, ch: string, opts?: SubscribeOpts): Promise<Subscription>

  inboxPublish(ctx: AbortSignal, ch: string, payload: unknown, opts: InboxPublishOpts): Promise<void>
  inboxConsume(ctx: AbortSignal, opts: InboxConsumeOpts): Promise<InboxSubscription>

  /** Retained (durably queued) envelopes for a channel, oldest first. */
  replay(ctx: AbortSignal, ch: string): Promise<Envelope[]>

  objectPut(ctx: AbortSignal, name: string, data: Uint8Array): Promise<void>
  objectGet(ctx: AbortSignal, name: string): Promise<Uint8Array | null>
  objectPutPersistent(ctx: AbortSignal, name: string, data: Uint8Array): Promise<void>
  objectGetPersistent(ctx: AbortSignal, name: string): Promise<Uint8Array | null>

  kvWatch(ctx: AbortSignal, bucket: string, keys: string): Promise<{ events: AsyncIterable<KvEvent>; stop: () => void }>
  kvCreate(ctx: AbortSignal, bucket: string, key: string, value: string, ttlMs: number): Promise<number>
  kvPut(ctx: AbortSignal, bucket: string, key: string, value: string, ttlMs: number): Promise<void>
  kvGet(ctx: AbortSignal, bucket: string, key: string): Promise<string>
  kvCas(ctx: AbortSignal, bucket: string, key: string, value: string, revision: number): Promise<number>
  kvDelete(ctx: AbortSignal, bucket: string, key: string): Promise<void>

  close(): Promise<void>
}
