import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { pageScope } from './scope'

describe('pageScope', () => {
  it('maps only Likes and Bookmarks list paths', () => {
    expect(Option.getOrNull(pageScope('/lambda_functor/likes'))).toBe('like')
    expect(Option.getOrNull(pageScope('/i/bookmarks'))).toBe('bookmark')
    expect(Option.getOrNull(pageScope('/i/bookmarks/all'))).toBe('bookmark')
    expect(Option.getOrNull(pageScope('/home'))).toBe(null)
    expect(Option.getOrNull(pageScope('/jack/status/123'))).toBe(null)
  })
})
