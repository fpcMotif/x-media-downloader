export function clampPercent(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.min(100, Math.max(0, value))
}

export function formatPercentValue(value: number): string {
  return `${value.toFixed(1)}%`
}
