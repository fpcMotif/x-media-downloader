/**
 * Narrowing predicates shared by every adapter walker that reads third-party
 * JSON (`@/packages/schema`'s {@link JsonValue}/{@link JsonObject} contract).
 * A bare `typeof v === 'string'` is only exempt from anti-slop's
 * `no-runtime-typeof` INSIDE a type-predicate function — so every walker reuses
 * these two instead of each inlining (and re-justifying) its own check.
 *
 * All three accept `| undefined` on top of {@link JsonValue}: `tsconfig.json`'s
 * `noUncheckedIndexedAccess` types every `JsonObject` property read
 * (`node['key']`) as `JsonValue | undefined`, never bare `JsonValue` — an absent
 * key reads the same as `undefined`, so a walker's "is this present and an
 * object/string/number" check is one call, not an `undefined` guard plus one.
 */
import type { JsonObject, JsonValue } from '@/packages/schema'
// Value import reaches past the `@/packages/schema` barrel straight to its
// dependency-free `json.ts`: this module is reachable from `wxt.config.ts`'s
// eager `registry.ts` import chain, loaded through jiti — jiti has no `@/`
// alias resolution (only vite's bundler does), and the barrel itself
// transitively pulls in `capture/record`.
import { isJsonObject as isJsonObjectValue } from '../../packages/schema/json'

/** Narrow a possibly-absent {@link JsonValue} to a string. */
export const isJsonString = (v: JsonValue | undefined): v is string => typeof v === 'string'

/** Narrow a possibly-absent {@link JsonValue} to a number. */
export const isJsonNumber = (v: JsonValue | undefined): v is number => typeof v === 'number'

/** {@link isJsonObjectValue}, widened to accept the `undefined` an absent or
 *  `noUncheckedIndexedAccess`-typed property read carries. */
export const isJsonObject = (v: JsonValue | undefined): v is JsonObject =>
  v !== undefined && isJsonObjectValue(v)
