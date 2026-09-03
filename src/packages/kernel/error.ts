/**
 * One human-readable reason from a thrown value already narrowed to `Error |
 * string` at the catch site — `Error` instances keep their `message`; a
 * string passes through unchanged. Centralizes the `err instanceof Error ?
 * … : err` idiom that the cloud adapters, messaging, and sync status all
 * repeated.
 *
 * A JS throw or promise rejection can carry any value at all, so `unknown`
 * must not cross this boundary uncontested: narrow it at the catch site with
 * `x instanceof Error ? x : String(x)` before calling this — `String` is
 * idempotent on an already-`string` value, so this one check is both the
 * `Error`/non-`Error` split and the only stringification a non-`Error` needs.
 */
export const errorReason = (err: Error | string): string =>
  err instanceof Error ? err.message : err
