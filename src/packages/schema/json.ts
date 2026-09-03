/**
 * The value contract for third-party JSON this extension reads but does not own —
 * X/Instagram/Threads API and GraphQL payloads, `chrome.storage` reads, and the
 * tee'd response bodies the adapters walk.
 *
 * These payloads are undocumented and change without notice, so the adapters walk
 * them defensively rather than decoding them against a schema. That makes
 * `Record<string, unknown>` tempting, but `unknown` states only that a value exists
 * — it gives a caller no contract at all, and every read then needs an assertion to
 * do anything. {@link JsonValue} says the true thing instead: the value is whatever
 * `JSON.parse` can produce, and nothing else. Narrowing from it is ordinary control
 * flow (`typeof`, `Array.isArray`, an `in` check) rather than a cast.
 *
 * Use {@link JsonObject} for "one object out of a parsed response". Where a payload
 * IS owned and stable, decode it with an Effect `Schema` from this package instead —
 * these types are for the boundary, not a substitute for the schemas behind it.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

/** One object node inside a parsed third-party payload. See {@link JsonValue}. */
export type JsonObject = { readonly [key: string]: JsonValue }

/** Narrow an arbitrary {@link JsonValue} to an object node. Arrays and `null` are
 *  objects to `typeof`, so both are excluded explicitly. */
export const isJsonObject = (value: JsonValue): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
