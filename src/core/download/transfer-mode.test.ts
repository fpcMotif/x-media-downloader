import { describe, expect, it } from 'vitest'
import { browserTransferModeForInitialRequest } from './transfer-mode'

describe('browserTransferModeForInitialRequest', () => {
  it('keeps Fetched for HTTP and routes data and aria2 sidecars through Chrome', () => {
    expect(browserTransferModeForInitialRequest('fetched', 'https://cdn.example/a.mp4')).toBe(
      'fetched',
    )
    expect(browserTransferModeForInitialRequest('fetched', 'data:application/json,{}')).toBe(
      'direct',
    )
    expect(browserTransferModeForInitialRequest('aria2', 'data:application/json,{}')).toBe('direct')
  })
})
