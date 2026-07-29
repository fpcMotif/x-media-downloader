/**
 * Counts UTF-8 bytes without allocating an encoded copy. Lone UTF-16
 * surrogates match TextEncoder's replacement-character behavior.
 */
export const utf8ByteLengthAtMost = (text: string, maxBytes: number): number | undefined => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return undefined

  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else bytes += 3
    } else bytes += 3

    if (bytes > maxBytes) return undefined
  }

  return bytes
}
