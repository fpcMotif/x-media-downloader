/** Narrow decoders for untrusted provider JSON. Extra fields remain forward-compatible. */
export type ControlRecord = Readonly<Record<string, unknown>>

export function controlRecord(value: unknown, label: string): ControlRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${label} must be an object`)
  return value as ControlRecord
}

export function controlArray(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new TypeError(`${label} must be a bounded array`)
  return value
}

export function controlString(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maximum)
    throw new TypeError(`${label} must be bounded text`)
  return value
}

export function optionalControlString(
  value: unknown,
  label: string,
  maximum: number,
): string | undefined {
  return value === undefined ? undefined : controlString(value, label, maximum, true)
}

export function controlSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError(`${label} must be a nonnegative safe integer`)
  return value as number
}

export function optionalControlBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean`)
  return value
}
