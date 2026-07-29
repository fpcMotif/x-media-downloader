/** Exact JSON-object guards for runtime wire decoders. */
export const isWireRecord = (value: unknown): value is Record<string, unknown> => {
  try {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  } catch {
    return false
  }
}

export type WireDataProperty = { readonly value: unknown }

/** Read one own enumerable data property without invoking a getter. */
export const readWireDataProperty = (value: unknown, key: string): WireDataProperty | undefined => {
  try {
    if (!isWireRecord(value)) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor
      ? { value: descriptor.value }
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Reads only an own enumerable data `_tag`. It never walks the payload or
 * invokes accessors. The selected decoder owns the full shape and byte checks.
 */
export const readWireTag = (value: unknown): string | undefined => {
  const property = readWireDataProperty(value, '_tag')
  return typeof property?.value === 'string' ? property.value : undefined
}

export const hasWireKeys = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> => {
  try {
    if (!isWireRecord(value)) return false
    const actual = Object.keys(value).toSorted()
    const expected = [...keys].toSorted()
    return (
      actual.length === expected.length && actual.every((key, index) => key === expected[index])
    )
  } catch {
    return false
  }
}
