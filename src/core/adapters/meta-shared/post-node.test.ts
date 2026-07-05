import { describe, it, expect } from 'vitest'
import { forEachPostNode } from './post-node'

describe('forEachPostNode', () => {
  it('finds a post node anywhere in an arbitrary response tree', () => {
    const json = {
      data: {
        items: [{ media_or_ad: { pk: '123', code: 'ABC123', user: { username: 'alice' } } }],
      },
    }
    const visited: unknown[] = []
    forEachPostNode(json, (ctx) => visited.push(ctx))
    expect(visited).toEqual([{ postId: '123', code: 'ABC123', author: 'alice' }])
  })

  it('falls back to the shortcode as postId when pk is absent', () => {
    const json = { code: 'XYZ', user: { username: 'bob' } }
    const visited: unknown[] = []
    forEachPostNode(json, (ctx) => visited.push(ctx))
    expect(visited).toEqual([{ postId: 'XYZ', code: 'XYZ', author: 'bob' }])
  })

  it('accepts a numeric pk (Instagram/Threads ids are often numbers, not strings)', () => {
    const json = { pk: 987654321, code: 'C1', user: { username: 'carol' } }
    const visited: unknown[] = []
    forEachPostNode(json, (ctx) => visited.push(ctx))
    expect(visited).toEqual([{ postId: '987654321', code: 'C1', author: 'carol' }])
  })

  it('visits a nested quoted_post/reposted_post as its own independent post (Threads)', () => {
    const json = {
      code: 'OUTER',
      user: { username: 'dave' },
      text_post_app_info: {
        share_info: { quoted_post: { code: 'INNER', user: { username: 'erin' } } },
      },
    }
    const visited: unknown[] = []
    forEachPostNode(json, (ctx) => visited.push(ctx))
    expect(visited).toEqual([
      { postId: 'OUTER', code: 'OUTER', author: 'dave' },
      { postId: 'INNER', code: 'INNER', author: 'erin' },
    ])
  })

  it('does not treat a node with only code, or only user, as a post', () => {
    const json = [
      { code: 'ONLY_CODE' },
      { user: { username: 'only_user' } },
      { code: '', user: {} },
    ]
    const visited: unknown[] = []
    forEachPostNode(json, (ctx) => visited.push(ctx))
    expect(visited).toEqual([])
  })

  it('rejects a user object with a non-string/empty username', () => {
    const json = [
      { code: 'A', user: { username: '' } },
      { code: 'B', user: { username: 42 } },
    ]
    const visited: unknown[] = []
    forEachPostNode(json, (ctx) => visited.push(ctx))
    expect(visited).toEqual([])
  })

  it('is a no-op for non-object/array json (primitives, null)', () => {
    expect(() => forEachPostNode(null, () => {})).not.toThrow()
    expect(() => forEachPostNode('a string', () => {})).not.toThrow()
    expect(() => forEachPostNode(42, () => {})).not.toThrow()
  })

  it('fails closed (does not throw) on a circular object reference', () => {
    const node: Record<string, unknown> = { a: {} }
    ;(node['a'] as Record<string, unknown>)['b'] = node
    expect(() => forEachPostNode(node, () => {})).not.toThrow()
  })

  it('still visits a post node reachable alongside a cycle elsewhere in the tree', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    const json = { cyclic, post: { code: 'OK', user: { username: 'frank' } } }
    const visited: unknown[] = []
    forEachPostNode(json, (ctx) => visited.push(ctx))
    expect(visited).toEqual([{ postId: 'OK', code: 'OK', author: 'frank' }])
  })
})
