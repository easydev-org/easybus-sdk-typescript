// Standard error codes — the wire form is the proto enum NUMBER (the Go SDK
// serializes `easybus.v1.Code` as an integer, e.g. CODE_BUSINESS -> 5). The
// TypeScript API uses the readable NAME internally and converts at the wire
// boundary, so TS <-> Go/Python/Rust interop works.

export type ToolErrorCode =
  | 'CODE_UNSPECIFIED'
  | 'CODE_INVALID_ARGUMENT'
  | 'CODE_NOT_FOUND'
  | 'CODE_PERMISSION_DENIED'
  | 'CODE_RETRYABLE'
  | 'CODE_BUSINESS'
  | 'CODE_INTERNAL'

/** Name -> number (must match proto/easybus/v1/protocol.proto enum Code). */
export const CODE_NUMBER: Record<string, number> = {
  CODE_UNSPECIFIED: 0,
  CODE_INVALID_ARGUMENT: 1,
  CODE_NOT_FOUND: 2,
  CODE_PERMISSION_DENIED: 3,
  CODE_RETRYABLE: 4,
  CODE_BUSINESS: 5,
  CODE_INTERNAL: 6,
}

/** Number -> name. */
export const CODE_NAME: Record<number, string> = Object.fromEntries(Object.entries(CODE_NUMBER).map(([n, v]) => [v, n]))

/**
 * codeToWire normalizes a code for the wire: a NAME becomes its NUMBER (Go
 * reads an int32 enum), a number passes through, an unknown value falls back
 * to CODE_INTERNAL (6).
 */
export function codeToWire(code: string | number): number {
  if (typeof code === 'number') return code
  return CODE_NUMBER[code] ?? 6
}

/**
 * codeFromWire normalizes a received code to its NAME: a NUMBER becomes the
 * name, a string is accepted as-is (a TS peer may send the name).
 */
export function codeFromWire(code: string | number): string {
  if (typeof code === 'number') return CODE_NAME[code] ?? 'CODE_UNSPECIFIED'
  return code
}
