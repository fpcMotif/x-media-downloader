/** Validate one persisted wall-clock timestamp. */
export function cloudTime(value: number, label = 'cloud time'): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} must be a nonnegative safe integer`)
  return value
}

/** Add a duration without creating an unsafe persisted timestamp. */
export function cloudDeadline(start: number, duration: number): number {
  cloudTime(start)
  if (!Number.isSafeInteger(duration) || duration < 0)
    throw new RangeError('cloud duration must be a nonnegative safe integer')
  return start > Number.MAX_SAFE_INTEGER - duration ? Number.MAX_SAFE_INTEGER : start + duration
}

/** Never let a backward wall clock predate the durable step being settled. */
export function monotonicCloudTime(now: number, floor: number): number {
  return Math.max(cloudTime(now), cloudTime(floor))
}
