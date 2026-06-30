import { describe, it, expect } from 'vitest'
import { expandText, linksFromEntities, cardMeta, type Link } from './card'
import cardFixture from '../../test/fixtures/tweet-with-card.json'

describe('expandText', () => {
  it('replaces every t.co inline by its expanded_url with an astral/emoji char before the offset', () => {
    // "👍" is one code point but TWO UTF-16 code units, so a naive offset would
    // corrupt the rewrite. Indices below are code-unit based (X's convention).
    const first = 'https://t.co/aaaaaaaaaa' // 23 code units
    const second = 'https://t.co/bbbbbbbbbb' // 23 code units
    const fullText = `👍 ${first} and ${second} fin`
    const i1 = fullText.indexOf(first)
    const i2 = fullText.indexOf(second)
    const urlEntities = [
      {
        url: first,
        expanded_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        display_url: 'youtube.com/watch?v=dQw4w9…',
        indices: [i1, i1 + first.length] as [number, number],
      },
      {
        url: second,
        expanded_url: 'https://arxiv.org/abs/1706.03762',
        display_url: 'arxiv.org/abs/1706.03762',
        indices: [i2, i2 + second.length] as [number, number],
      },
    ]

    const out = expandText(fullText, urlEntities)

    expect(out).toBe(
      '👍 https://www.youtube.com/watch?v=dQw4w9WgXcQ and https://arxiv.org/abs/1706.03762 fin',
    )
    // emoji preserved verbatim at the head; no shifted/truncated chars.
    expect(out.startsWith('👍 ')).toBe(true)
    expect(out.endsWith(' fin')).toBe(true)
  })

  it('leaves text without entities untouched and tolerates entities missing indices', () => {
    expect(expandText('no links here', [])).toBe('no links here')
    expect(
      expandText('plain https://t.co/zzzzzzzzzz tail', [
        { url: 'https://t.co/zzzzzzzzzz', expanded_url: 'https://example.com/x' },
      ]),
    ).toBe('plain https://t.co/zzzzzzzzzz tail')
  })
})

describe('linksFromEntities', () => {
  it('projects URL entities into Link[] with expandedUrl and displayUrl', () => {
    const links = linksFromEntities([
      {
        url: 'https://t.co/aaaaaaaaaa',
        expanded_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        display_url: 'youtube.com/watch?v=dQw4w9…',
      },
      {
        url: 'https://t.co/bbbbbbbbbb',
        expanded_url: 'https://arxiv.org/abs/1706.03762',
      },
    ])

    const expected: Link[] = [
      {
        expandedUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        displayUrl: 'youtube.com/watch?v=dQw4w9…',
      },
      { expandedUrl: 'https://arxiv.org/abs/1706.03762' },
    ]
    expect(links).toEqual(expected)
  })
})

const cardNodeOf = (key: 'flatCardTweet' | 'unifiedCardTweet') =>
  (cardFixture as Record<string, { data: { tweetResult: { result: { card: unknown } } } }>)[key]!
    .data.tweetResult.result.card

describe('cardMeta', () => {
  it('reads title/description/domain from a flat summary card', () => {
    expect(cardMeta(cardNodeOf('flatCardTweet'))).toEqual({
      title: 'Example Blog Post',
      description: 'A short description of the blog post.',
      domain: 'example.com',
    })
  })

  it('reads title/description/domain from a unified_card JSON blob', () => {
    expect(cardMeta(cardNodeOf('unifiedCardTweet'))).toEqual({
      title: 'Attention Is All You Need',
      description: 'arxiv.org',
      domain: 'arxiv.org',
    })
  })

  it('reads a flat card passed without a legacy wrapper, omitting absent fields', () => {
    // node IS the binding-values holder (no `legacy`); only `title` present.
    expect(
      cardMeta({
        binding_values: [{ key: 'title', value: { string_value: 'Bare Title' } }],
      }),
    ).toEqual({ title: 'Bare Title' })
  })

  it('omits absent flat-card fields (description present, title missing)', () => {
    expect(
      cardMeta({
        legacy: {
          binding_values: [{ key: 'description', value: { string_value: 'only a description' } }],
        },
      }),
    ).toEqual({ description: 'only a description' })
  })

  it('reads partial unified_card fields and omits the rest', () => {
    const unifiedWith = (inner: unknown) =>
      cardMeta({
        legacy: {
          binding_values: [{ key: 'unified_card', value: { string_value: JSON.stringify(inner) } }],
        },
      })

    // component present but `data` not a record, no destination_objects → all omitted.
    expect(unifiedWith({ component_objects: { c1: { data: 'nope' } } })).toEqual({})
    // component map whose only value is not a record, and a destination whose
    // url_data is bad → loop skips the non-record value, falls through.
    expect(
      unifiedWith({
        component_objects: { c1: 'not-a-record' },
        destination_objects: { d1: { data: { url_data: 'bad' } } },
      }),
    ).toEqual({})
    // title/subtitle content present but non-string; vanity non-string → all omitted.
    expect(
      unifiedWith({
        component_objects: { c1: { data: { title: { content: 1 }, subtitle: { content: 2 } } } },
        destination_objects: { d1: { data: { url_data: { vanity: 3 } } } },
      }),
    ).toEqual({})
    // a unified blob that parses to a non-object → no fields.
    expect(unifiedWith(42)).toEqual({})
  })

  it('returns no title and never throws on a malformed card', () => {
    let result: { title?: string; description?: string; domain?: string } | undefined
    expect(() => {
      result = cardMeta({ legacy: { binding_values: 'garbage' } })
    }).not.toThrow()
    expect(result?.title).toBeUndefined()

    expect(() => cardMeta(null)).not.toThrow()
    expect(() => cardMeta(undefined)).not.toThrow()
    expect(() => cardMeta(42)).not.toThrow()
    expect(cardMeta(null).title).toBeUndefined()
    // a unified_card whose string_value is not valid JSON must still not throw.
    expect(
      cardMeta({
        legacy: {
          binding_values: [
            { key: 'unified_card', value: { type: 'STRING', string_value: '{not json' } },
          ],
        },
      }).title,
    ).toBeUndefined()
  })
})
