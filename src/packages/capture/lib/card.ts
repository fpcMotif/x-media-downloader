/**
 * Pure card / link de-shortening helpers (spec §6.3). `t.co`→`expanded_url`
 * inline, projecting URL entities into `Link[]`, and reading card metadata from
 * both the flat `summary` binding-values encoding and the `unified_card` JSON
 * blob. Best-effort: never throws on malformed input.
 */
// Imported from the dependency-free leaf module, not the `@/packages/schema`
// barrel: that barrel imports `TweetRecord` FROM `../record.ts`, which imports
// THIS file, so importing the barrel here (even type-only) creates a cycle that
// breaks Effect Schema's module-init order.
import { type JsonObject, type JsonValue } from '@/packages/schema/json'

export type Link = {
  expandedUrl: string
  displayUrl?: string
  title?: string
  description?: string
  domain?: string
}

export type UrlEntity = {
  url: string
  expanded_url: string
  display_url?: string
  indices?: [number, number]
}

/**
 * Replace every `t.co` with its `expanded_url` inline. Index-safe: apply
 * replacements from the highest UTF-16 offset backwards so earlier code-unit
 * offsets stay valid even when astral/emoji characters precede an entity.
 */
export function expandText(fullText: string, urlEntities: ReadonlyArray<UrlEntity>): string {
  const withRange = urlEntities.filter((e): e is UrlEntity & { indices: [number, number] } =>
    Array.isArray(e.indices),
  )
  const ordered = [...withRange].toSorted((a, b) => b.indices[0] - a.indices[0])
  let out = fullText
  for (const e of ordered) {
    const [start, end] = e.indices
    out = out.slice(0, start) + e.expanded_url + out.slice(end)
  }
  return out
}

/** Project each URL entity into a `Link` (carrying `displayUrl` when present). */
export function linksFromEntities(urlEntities: ReadonlyArray<Omit<UrlEntity, 'indices'>>): Link[] {
  return urlEntities.map((e) => ({
    expandedUrl: e.expanded_url,
    ...(e.display_url !== undefined ? { displayUrl: e.display_url } : {}),
  }))
}

type BindingValue = { key?: JsonValue; value?: { string_value?: JsonValue } }

/** `{title?, description?, domain?}` recovered from a card node — the shared return
 *  shape of {@link unifiedMeta} and {@link cardMeta}. Named so their return-type
 *  annotations reference an owner contract instead of an anonymous object literal. */
export type CardMeta = {
  readonly title?: string
  readonly description?: string
  readonly domain?: string
}

const isRecord = (v: JsonValue | undefined): v is JsonObject => typeof v === 'object' && v !== null

const isString = (v: JsonValue | undefined): v is string => typeof v === 'string'

const bindingString = (values: ReadonlyArray<BindingValue>, key: string): string | undefined => {
  const hit = values.find((b) => b.key === key)
  const s = hit?.value?.string_value
  return isString(s) ? s : undefined
}

const firstValue = (node: JsonValue | undefined): JsonObject | undefined => {
  if (!isRecord(node)) return undefined
  for (const v of Object.values(node)) if (isRecord(v)) return v
  return undefined
}

/** Safely navigate a path of keys in nested records, returning the string value or undefined. */
const extractNestedString = (
  base: JsonValue | undefined,
  ...path: string[]
): string | undefined => {
  let current = base
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return isString(current) ? current : undefined
}

/** Safely navigate a path of keys in nested records, returning the final record or undefined. */
const extractNestedRecord = (
  base: JsonValue | undefined,
  ...path: string[]
): JsonObject | undefined => {
  let current = base
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return isRecord(current) ? current : undefined
}

const unifiedMeta = (json: string): CardMeta => {
  const parsed: JsonValue = JSON.parse(json)
  if (!isRecord(parsed)) return {}
  const component = firstValue(parsed.component_objects)
  const data = isRecord(component?.data) ? component.data : undefined
  const title = extractNestedString(data, 'title', 'content')
  const description = extractNestedString(data, 'subtitle', 'content')
  const destination = firstValue(parsed.destination_objects)
  const urlData = extractNestedRecord(destination?.data, 'url_data')
  const domain = extractNestedString(urlData, 'vanity')
  return {
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(domain !== undefined ? { domain } : {}),
  }
}

/**
 * Read `{ title?, description?, domain? }` from a card node. Supports the flat
 * `summary`/`summary_large_image` `binding_values[]` (keyed `title`/`description`/
 * `domain`) and the `unified_card` JSON `string_value`. Best-effort: any
 * structural mismatch or parse failure yields the fields it could read (or none),
 * never throwing.
 */
export function cardMeta(cardNode: JsonValue | undefined): CardMeta {
  try {
    if (!isRecord(cardNode)) return {}
    const legacy = isRecord(cardNode.legacy) ? cardNode.legacy : cardNode
    const values = legacy.binding_values
    if (!Array.isArray(values)) return {}
    // SAFETY: every BindingValue field is optional, so this only asserts the
    // array holds JSON object/scalar nodes — exactly what `Array.isArray` above
    // already proved. `bindingString` re-validates `key`/`string_value` itself
    // (typeof/isString checks), so a malformed element degrades to `undefined`
    // rather than reading garbage.
    const bindings = values as ReadonlyArray<BindingValue>

    const unified = bindingString(bindings, 'unified_card')
    if (unified !== undefined) return unifiedMeta(unified)

    const title = bindingString(bindings, 'title')
    const description = bindingString(bindings, 'description')
    const domain = bindingString(bindings, 'domain')
    return {
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(domain !== undefined ? { domain } : {}),
    }
  } catch {
    return {}
  }
}
