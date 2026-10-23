/**
 * Channel subjects and matching.
 *
 * A channel is a PUBLISH/SUBSCRIBE topic, distinct from the mailbox, which is a point-to-point
 * command queue for one session. Keeping them separate matters: a mailbox message drives one
 * session, while a channel message may interest none or many.
 *
 *     easybus.<tenant>.channel.<channel>.<topic...>
 *
 * The tenant segment is not optional and not caller-supplied: publishers name a channel, never a
 * tenant. That is what makes cross-tenant delivery structurally impossible rather than merely
 * forbidden by a check.
 */

/** The KV bucket holding channel subscriptions. */
export const CHANNEL_KV_BUCKET = 'subs'

/** Matches every channel message in every tenant (the agent's fan-in consumer uses this). */
export const CH_CHANNEL_ALL = 'easybus.*.channel.>'

/** Rejects a channel or topic that cannot be a literal subject segment. */
const SEGMENT_RE = /^[A-Za-z0-9._/-]+$/

/** buildChannelSubject builds the subject for one channel message. */
export function chChannel(tenant: string, channel: string, topic: string): string {
  for (const v of [channel, topic]) {
    if (!v || !SEGMENT_RE.test(v) || v.startsWith('.') || v.endsWith('.')) {
      throw new Error(`channel and topic must be literal subject segments: ${JSON.stringify(v)}`)
    }
  }
  return `easybus.${tenant}.channel.${channel}.${topic}`
}

/**
 * parseChannelSubject splits a channel subject back into its parts.
 *
 * The consumer derives the tenant, channel and topic from the SUBJECT rather than from the
 * payload: a publisher that lied in its payload must not be able to deliver into another
 * tenant's channel. The subject is the one thing a publisher cannot forge, because the broker
 * routes on it.
 */
export function parseChannelSubject(subject: string): {
  tenant: string
  channel: string
  topic: string
} | null {
  const prefix = 'easybus.'
  if (!subject.startsWith(prefix)) return null
  const rest = subject.slice(prefix.length)
  const i = rest.indexOf('.')
  if (i <= 0) return null
  const tenant = rest.slice(0, i)
  let tail = rest.slice(i + 1)
  if (!tail.startsWith('channel.')) return null
  tail = tail.slice('channel.'.length)
  const j = tail.indexOf('.')
  if (j <= 0 || j === tail.length - 1) return null
  return { tenant, channel: tail.slice(0, j), topic: tail.slice(j + 1) }
}

/**
 * matchSubject reports whether a topic matches a subscription pattern, with NATS subject
 * semantics:
 *
 *   `*` matches exactly one segment
 *   `>` matches the rest, and must be last, and must cover at least one segment
 *   anything else is a literal
 *
 * The `>` rule was verified against a real broker rather than assumed: subscribing to `tag.>`
 * delivers `tag.v1` but NOT `tag`.
 */
export function matchSubject(pattern: string, topic: string): boolean {
  if (!pattern) return false
  const p = pattern.split('.')
  const t = topic.split('.')
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]
    if (seg === '>') return t.length > i
    if (i >= t.length) return false
    if (seg !== '*' && seg !== t[i]) return false
  }
  return p.length === t.length
}
