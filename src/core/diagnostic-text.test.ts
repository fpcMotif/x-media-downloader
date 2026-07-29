import { describe, expect, it } from 'vitest'
import { boundedDiagnosticText, MAX_DIAGNOSTIC_TEXT_LENGTH } from './diagnostic-text'

describe('boundedDiagnosticText', () => {
  it('preserves short text and truncates long text within the shared limit', () => {
    expect(boundedDiagnosticText('short')).toBe('short')
    const result = boundedDiagnosticText('x'.repeat(MAX_DIAGNOSTIC_TEXT_LENGTH + 1))
    expect(result).toHaveLength(MAX_DIAGNOSTIC_TEXT_LENGTH)
    expect(result.endsWith('…')).toBe(true)
  })

  it('does not split a UTF-16 surrogate pair', () => {
    expect(boundedDiagnosticText(`a😀tail`, 3)).toBe('a…')
  })
})
