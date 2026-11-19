import { Option, Schema } from 'effect'
import type { JsonValue } from '@/packages/schema'

export const UPLOADED_KEYS_CAP = 20_000

const decodeKeys = Schema.decodeUnknownOption(Schema.Array(Schema.String))

export function decodeUploadedKeys(raw: JsonValue): ReadonlyArray<string> {
  return Option.getOrElse(decodeKeys(raw ?? []), () => [])
}

export function rememberUploaded(
  keys: ReadonlyArray<string>,
  added: ReadonlyArray<string>,
  cap: number = UPLOADED_KEYS_CAP,
): ReadonlyArray<string> {
  const known = new Set(keys)
  const fresh = [...new Set(added)].filter((key) => !known.has(key))
  if (fresh.length === 0) return keys
  const next = [...keys, ...fresh]
  return next.length > cap ? next.slice(next.length - cap) : next
}
