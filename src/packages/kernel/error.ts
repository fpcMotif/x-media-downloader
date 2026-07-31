/**
 * One human-readable reason from any thrown value. `Error` instances keep their
 * `message`; anything else (a thrown string/object — rare but legal in JS) is
 * stringified. Centralizes the `err instanceof Error ? … : String(err)` idiom
 * that the cloud adapters, messaging, and sync status all repeated.
 */
export const errorReason = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)
