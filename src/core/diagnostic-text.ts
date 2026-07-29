/** One bounded human-readable failure or trace line on any runtime wire. */
export const MAX_DIAGNOSTIC_TEXT_LENGTH = 1_024

/** Preserve the prefix and mark truncation without splitting a surrogate pair. */
export function boundedDiagnosticText(text: string, maximum = MAX_DIAGNOSTIC_TEXT_LENGTH): string {
  if (!Number.isSafeInteger(maximum) || maximum < 1)
    throw new RangeError('maximum must be a positive safe integer')
  if (text.length <= maximum) return text
  if (maximum === 1) return '…'
  let end = maximum - 1
  const unit = text.charCodeAt(end - 1)
  if (unit >= 0xd800 && unit <= 0xdbff) end -= 1
  return `${text.slice(0, end)}…`
}
