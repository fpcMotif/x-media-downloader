import { clampPercent, formatPercentValue } from './lib/impl'

export function formatPercent(value: number): string {
  return formatPercentValue(clampPercent(value))
}
