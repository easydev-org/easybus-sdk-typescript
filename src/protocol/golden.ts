// Frozen derivations — the cross-language interop vectors. These MUST equal the
// Go vectors in easybus-sdk/conformance/golden_test.go. If either side changes
// a derivation, the other must be updated in lockstep, or cross-language traffic
// breaks silently.
//
// v2: every data-plane channel is easybus.<tenant>.<...>.

import {
  CH_DISCOVER,
  MAILBOX_WILDCARD_ALL,
  chConfig,
  chHookCall,
  chHookEvent,
  chMailbox,
  chSessionEvents,
  chToolCall,
  chToolProgress,
  chVariable,
  chInterrupt,
  sessionToken,
  sessionVarKey,
  varKey,
} from './protocol.js'

export const GOLDEN_TENANT = 'alice'

/** name -> [got, want]. Every entry must hold exactly. */
export const goldenVectors: Record<string, [string, string]> = {
  session_token: [sessionToken('sess-1'), 'q-Yz86R6J1gXTqvpFg2vNs'],
  discover: [CH_DISCOVER, 'easybus.discover'],
  tool_call: [chToolCall(GOLDEN_TENANT, 'ops', 'echo'), 'easybus.alice.tool.call.ops.echo'],
  tool_progress: [chToolProgress(GOLDEN_TENANT, 'c1'), 'easybus.alice.tool.progress.c1'],
  variable: [chVariable(GOLDEN_TENANT, 'ops', 'base-url'), 'easybus.alice.var.ops.base-url'],
  interrupt: [chInterrupt(GOLDEN_TENANT, 'ops'), 'easybus.alice.ctl.interrupt.ops'],
  hook_call: [chHookCall(GOLDEN_TENANT, 'ops', 'session.before_create'), 'easybus.alice.hook.call.ops.session.before_create'],
  hook_event: [chHookEvent(GOLDEN_TENANT, 'session.created'), 'easybus.alice.hook.event.session.created'],
  mailbox_wildcard: [MAILBOX_WILDCARD_ALL + '>', 'easybus.*.mailbox.>'],
  mailbox_sess1: [chMailbox(GOLDEN_TENANT, 'sess-1'), 'easybus.alice.mailbox.q-Yz86R6J1gXTqvpFg2vNs'],
  session_events_s1: [chSessionEvents(GOLDEN_TENANT, 'sess-1'), 'easybus.alice.session.events.q-Yz86R6J1gXTqvpFg2vNs'],
  config: [chConfig(GOLDEN_TENANT, 'ops'), 'easybus.alice.config.ops'],
  var_key: [varKey(GOLDEN_TENANT, 'ops', 'base-url'), 't.alice.ops.base-url'],
  session_var_key: [sessionVarKey(GOLDEN_TENANT, 'ops', 'sess-1', 'ws'), 't.alice.ops.q-Yz86R6J1gXTqvpFg2vNs.ws'],
}
