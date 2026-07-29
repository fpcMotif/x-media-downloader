// JSON.stringify looks up `toJSON` through the prototype chain. The only
// accepted prototypes are intrinsic Object and Array prototypes, so inspect
// their own descriptors rather than reading the property.
const hasToJson = (prototype: object | null): boolean => {
  for (let current = prototype; current !== null; current = Object.getPrototypeOf(current)) {
    if (Object.getOwnPropertyDescriptor(current, 'toJSON') !== undefined) return true
  }
  return false
}

/**
 * Counts the bytes Chrome would use for JSON message serialization without
 * allocating the serialized payload or invoking getters or `toJSON`.
 *
 * `undefined` means the value is not safe JSON input, or exceeds `maxBytes`.
 */
export const measureJsonBytes = (value: unknown, maxBytes: number): number | undefined => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return undefined

  let bytes = 0
  const ancestors = new Set<object>()
  const maxDepth = 128

  const add = (count: number): boolean => {
    bytes += count
    return bytes <= maxBytes
  }

  const stringBytes = (text: string): boolean => {
    if (!add(1)) return false
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index)
      if (
        code === 0x22 ||
        code === 0x5c ||
        code === 0x08 ||
        code === 0x0c ||
        code === 0x0a ||
        code === 0x0d ||
        code === 0x09
      ) {
        if (!add(2)) return false
        continue
      }
      if (code < 0x20) {
        if (!add(6)) return false
        continue
      }
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = text.charCodeAt(index + 1)
        if (low >= 0xdc00 && low <= 0xdfff) {
          if (!add(4)) return false
          index += 1
          continue
        }
        if (!add(6)) return false
        continue
      }
      if (code >= 0xdc00 && code <= 0xdfff) {
        if (!add(6)) return false
        continue
      }
      if (!add(code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3)) return false
    }
    return add(1)
  }

  const visit = (candidate: unknown, depth = 0): boolean => {
    if (candidate === null) return add(4)
    switch (typeof candidate) {
      case 'boolean':
        return add(candidate ? 4 : 5)
      case 'number':
        return (
          Number.isFinite(candidate) && add(String(Object.is(candidate, -0) ? 0 : candidate).length)
        )
      case 'string':
        return stringBytes(candidate)
      case 'object':
        break
      default:
        return false
    }

    const object = candidate
    if (depth >= maxDepth) return false
    if (ancestors.has(object)) return false
    ancestors.add(object)
    try {
      if (Array.isArray(object)) {
        if (Object.getPrototypeOf(object) !== Array.prototype) return false
        if (hasToJson(Array.prototype)) return false
        if (Object.getOwnPropertySymbols(object).length !== 0) return false
        const names = Object.getOwnPropertyNames(object)
        const lengthDescriptor = Object.getOwnPropertyDescriptor(object, 'length')
        if (
          lengthDescriptor === undefined ||
          !('value' in lengthDescriptor) ||
          lengthDescriptor.enumerable ||
          !Number.isSafeInteger(lengthDescriptor.value) ||
          lengthDescriptor.value < 0 ||
          names.length !== lengthDescriptor.value + 1 ||
          !names.includes('length')
        )
          return false
        const length = lengthDescriptor.value
        if (!add(1)) return false
        for (let index = 0; index < length; index += 1) {
          if (index > 0 && !add(1)) return false
          const descriptor = Object.getOwnPropertyDescriptor(object, String(index))
          if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable)
            return false
          if (!visit(descriptor.value, depth + 1)) return false
        }
        return add(1)
      }

      const prototype = Object.getPrototypeOf(object)
      if (prototype !== Object.prototype && prototype !== null) return false
      if (hasToJson(prototype)) return false
      if (Object.getOwnPropertySymbols(object).length !== 0) return false
      const names = Object.getOwnPropertyNames(object)
      if (!add(1)) return false
      let first = true
      for (const key of names) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key)
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable)
          return false
        if (!first && !add(1)) return false
        first = false
        if (!stringBytes(key) || !add(1) || !visit(descriptor.value, depth + 1)) return false
      }
      return add(1)
    } finally {
      ancestors.delete(object)
    }
  }

  try {
    if (!visit(value)) return undefined

    // A Proxy can present benign descriptors while changing JSON reads. The
    // structured-clone algorithm rejects every Proxy before it reads traps.
    // Descriptor validation above rejects accessors, so this check cannot run
    // a getter on an otherwise accepted value.
    if (typeof value === 'object' && value !== null) structuredClone(value)
    return bytes
  } catch {
    return undefined
  }
}

/** True only when a safe JSON value fits the supplied byte budget. */
export const isJsonWithinByteBudget = (value: unknown, maxBytes: number): boolean =>
  measureJsonBytes(value, maxBytes) !== undefined
