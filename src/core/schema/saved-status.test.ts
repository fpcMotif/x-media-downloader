import { describe, expect, it } from 'vitest'
import {
  decodeSavedStatusRequest,
  decodeSavedStatusResponse,
  decodeSavedStatusUpdate,
  MAX_SAVED_STATUS_REQUEST_BYTES,
} from './saved-status'
import { MAX_SAVED_TWEET_IDS_PER_REQUEST } from '../wire/limits'

const ids = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => String(index + 1))

describe('Saved status wire', () => {
  it('accepts exactly 100 unique decimal snowflakes', () => {
    const tweetIds = ids(MAX_SAVED_TWEET_IDS_PER_REQUEST)
    expect(decodeSavedStatusRequest({ _tag: 'SavedStatusRequest', tweetIds })).toEqual({
      _tag: 'SavedStatusRequest',
      tweetIds,
    })
    expect(
      decodeSavedStatusRequest({
        _tag: 'SavedStatusRequest',
        tweetIds: ids(MAX_SAVED_TWEET_IDS_PER_REQUEST + 1),
      }),
    ).toBeUndefined()
  })

  it('rejects duplicate, malformed, and oversized snowflakes', () => {
    for (const tweetIds of [['1', '1'], ['abc'], ['1'.repeat(21)], ['١٢٣']]) {
      expect(decodeSavedStatusRequest({ _tag: 'SavedStatusRequest', tweetIds })).toBeUndefined()
    }
  })

  it('rejects extra request keys and data beyond the derived JSON cap', () => {
    expect(
      decodeSavedStatusRequest({ _tag: 'SavedStatusRequest', tweetIds: ['1'], extra: true }),
    ).toBeUndefined()
    expect(
      decodeSavedStatusRequest({
        _tag: 'SavedStatusRequest',
        tweetIds: ['9'.repeat(20)],
        padding: 'x'.repeat(MAX_SAVED_STATUS_REQUEST_BYTES),
      }),
    ).toBeUndefined()
  })

  it('accepts only a unique valid response subset of the requested IDs', () => {
    expect(
      decodeSavedStatusResponse({ _tag: 'SavedStatusResponse', saved: ['2', '1'] }, [
        '1',
        '2',
        '3',
      ]),
    ).toEqual({ _tag: 'SavedStatusResponse', saved: ['2', '1'] })
    expect(
      decodeSavedStatusResponse({ _tag: 'SavedStatusResponse', saved: ['4'] }, ['1', '2', '3']),
    ).toBeUndefined()
    expect(
      decodeSavedStatusResponse({ _tag: 'SavedStatusResponse', saved: ['1', '1'] }, ['1', '2']),
    ).toBeUndefined()
    expect(
      decodeSavedStatusResponse({ _tag: 'SavedStatusResponse', saved: ['1'], extra: true }, ['1']),
    ).toBeUndefined()
  })

  it('accepts only exact, bounded Saved-status broadcasts', () => {
    expect(decodeSavedStatusUpdate({ _tag: 'SavedStatusUpdate', saved: ['1'] })).toEqual({
      _tag: 'SavedStatusUpdate',
      saved: ['1'],
    })
    expect(
      decodeSavedStatusUpdate({ _tag: 'SavedStatusUpdate', saved: ['1', '1'] }),
    ).toBeUndefined()
    expect(
      decodeSavedStatusUpdate({ _tag: 'SavedStatusUpdate', saved: ['1'.repeat(21)] }),
    ).toBeUndefined()
    expect(
      decodeSavedStatusUpdate({ _tag: 'SavedStatusUpdate', saved: ['1'], extra: true }),
    ).toBeUndefined()
  })
})
