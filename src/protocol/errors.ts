// Classifying a transport error is a PROTOCOL concern, not a transport detail.
//
// Four SDKs talk to the same broker, and each has to answer the same question when a KV call
// fails: is this an expected outcome (a lost race, an absent key) or a real failure? Getting it
// wrong is silent in both directions:
//
//   - a lost CAS reported as a failure → the lease is renewed against a revision it no longer owns,
//     or a healthy turn is aborted because a network blip looked like a takeover;
//   - a network failure reported as "the key is absent" → an extension starts with no
//     configuration and reports itself unconfigured, while the config is plainly set.
//
// Every SDK had the second shape (`catch { return 0 }`). The classification lives here once, and
// the shared conformance table pins it for all four implementations.

/** The server's rejection of a CAS that lost a race (10071 "wrong last sequence: N"). */
export function isLostRace(err: unknown): boolean {
  if (err === null || err === undefined) return false
  // Two phrasings exist in the wild, with and without the `stream` prefix; the shared substring
  // covers both, so a server-version difference cannot silently reclassify a normal outcome.
  return messageOf(err).includes('wrong last sequence')
}

/**
 * A create() that found the key already present.
 *
 * The other losing side of a claim race, and equally normal: the caller reads revision 0 as
 * "somebody else holds it". Deliberately NOT in the shared conformance table — the server's
 * phrasing for it ("key already exists", "wrong last sequence") differs between a create and an
 * update, so it is matched per-operation rather than shared.
 */
export function isAlreadyExists(err: unknown): boolean {
  if (err === null || err === undefined) return false
  const m = messageOf(err)
  return m.includes('key already exists') || m.includes('already exists')
}

/**
 * An absent key: deleted, or expired under a short TTL.
 *
 * "no message found" (10037) is what get() returns once the value expired between being listed and
 * being read. It is a MISS — treating it as an error makes the caller take its error path when the
 * correct behaviour is the default one.
 */
export function isAbsentKey(err: unknown): boolean {
  if (err === null || err === undefined) return false
  const m = messageOf(err)
  return m.includes('no message found') || m.includes('key not found')
}

/**
 * A JetStream consumer that no longer exists.
 *
 * A durable consumer can be deleted underneath a long-lived subscription: operator cleanup, a
 * stream reset, or the server reclaiming it. A pull Fetch then fails IMMEDIATELY with "no
 * responders", which one deployment read as "nothing to read" — 2,814,600 empty pulls, no
 * delivery, no log. The fix is to rebuild, not to keep asking.
 */
export function isConsumerGone(err: unknown): boolean {
  if (err === null || err === undefined) return false
  const m = messageOf(err)
  return (
    m.includes('consumer not found') ||
    m.includes('consumer deleted') ||
    m.includes('no responders')
  )
}

/**
 * Lower-cased text of an error, whatever shape it arrived in.
 *
 * The NATS client throws plain Error objects, but a wrapper may surface `{ message }` or a bare
 * string. Matching on `String(err)` alone would produce "[object Object]" for the last two and
 * classify every fault as unknown.
 */
function messageOf(err: unknown): string {
  if (typeof err === 'string') return err.toLowerCase()
  if (typeof err === 'object' && err !== null) {
    const m = (err as { message?: unknown }).message
    if (typeof m === 'string') return m.toLowerCase()
  }
  return String(err).toLowerCase()
}
