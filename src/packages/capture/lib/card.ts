/**
 * Pure card / link de-shortening helpers (spec §6.3). `t.co`→`expanded_url`
 * inline, projecting URL entities into `Link[]`, and reading card metadata from
 * both the flat `summary` binding-values encoding and the `unified_card` JSON
 * blob. Best-effort: never throws on malformed input.
 */
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

type BindingValue = { key?: unknown; value?: { string_value?: unknown } }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

const bindingString = (values: ReadonlyArray<BindingValue>, key: string): string | undefined => {
  const hit = values.find((b) => b.key === key)
  const s = hit?.value?.string_value
  return typeof s === 'string' ? s : undefined
}

const firstValue = (node: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(node)) return undefined
  for (const v of Object.values(node)) if (isRecord(v)) return v
  return undefined
}

const unifiedMeta = (json: string): { title?: string; description?: string; domain?: string } => {
  const parsed: unknown = JSON.parse(json)
  if (!isRecord(parsed)) return {}
  const component = firstValue(parsed.component_objects)
  const data = isRecord(component?.data) ? component.data : undefined
  const title =
    isRecord(data?.title) && typeof data.title.content === 'string' ? data.title.content : undefined
  const description =
    isRecord(data?.subtitle) && typeof data.subtitle.content === 'string'
      ? data.subtitle.content
      : undefined
  const destination = firstValue(parsed.destination_objects)
  const urlData =
    isRecord(destination?.data) && isRecord(destination.data.url_data)
      ? destination.data.url_data
      : undefined
  const domain = typeof urlData?.vanity === 'string' ? urlData.vanity : undefined
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
export function cardMeta(cardNode: unknown): {
  title?: string
  description?: string
  domain?: string
} {
  try {
    if (!isRecord(cardNode)) return {}
    const legacy = isRecord(cardNode.legacy) ? cardNode.legacy : cardNode
    const values = legacy.binding_values
    if (!Array.isArray(values)) return {}
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
