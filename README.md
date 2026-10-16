# easybus-sdk-typescript

The **TypeScript** implementation of the easybus protocol SDK — a multi-tenant
message bus between an agent and its extensions.

## Source of truth

The wire contract is `proto/easybus/v1/protocol.proto`, **copied** from the Go
reference (`easydev-org/easybus-sdk`) so every language ships the identical
message shapes. `buf generate` produces this repo's `src/gen` (protoc-gen-es).

Runtime conventions (subject layout `easybus.<tenant>.<...>`, KV-key escaping,
golden derivations) live in `src/protocol/` and MUST match the Go implementation
byte-for-byte (see `src/protocol/golden.ts`).

## Layout (mirrors the Go SDK)

```
proto/easybus/v1/protocol.proto   the wire contract (copied, never edited here)
src/gen/                          generated messages (protoc-gen-es)
src/protocol/                     subject conventions, KV keys, escaping, args, golden
src/identity/                     HMAC pre-shared identity
src/bus/                          transport-agnostic Bus interface
src/transport/nats/               the NATS transport
src/manifest/                     YAML manifest -> extension Config
src/extension/                    the extension role (tools/config/hooks/lifecycle)
src/agent/                        the agent role (discover/call/lease)
src/i18n/                         localized strings
src/conformance/                  the protocol test suite
```
