import { describe, it, expect } from 'vitest'
import {
  findPostContainer,
  permalinkAnchorFromContainer,
  postCodeFromContainer,
} from './post-anchor'

describe('findPostContainer', () => {
  it('finds the nearest matching ancestor 2 levels up', () => {
    const root = document.createElement('div')
    root.innerHTML = `<article><div><video></video></div></article>`
    const video = root.querySelector('video')!
    expect(findPostContainer(video, 'article')).toBe(root.querySelector('article'))
  })

  it('returns null when no ancestor matches', () => {
    const root = document.createElement('div')
    root.innerHTML = `<div><video></video></div>`
    const video = root.querySelector('video')!
    expect(findPostContainer(video, 'article')).toBeNull()
  })
})

describe('postCodeFromContainer', () => {
  const IG_PATTERN = /^\/p\/([A-Za-z0-9_-]+)\//
  const THREADS_PATTERN = /^\/@[^/]+\/post\/([^/?#]+)/

  it('extracts the code from the first matching link', () => {
    const el = document.createElement('article')
    el.innerHTML = `<a href="/p/CODE1/">link</a>`
    expect(postCodeFromContainer(el, 'a[href]', IG_PATTERN)).toBe('CODE1')
  })

  it('returns null when container has links but none match the pattern', () => {
    const el = document.createElement('article')
    el.innerHTML = `<a href="/explore/">link</a>`
    expect(postCodeFromContainer(el, 'a[href]', IG_PATTERN)).toBeNull()
  })

  it('skips a link missing href', () => {
    const el = document.createElement('article')
    el.innerHTML = `<a>no href</a><a href="/p/CODE2/">real</a>`
    // Use a broad selector ('a') so the hrefless <a> is actually visited —
    // 'a[href]' would exclude it at the selector level, never exercising the
    // `!href` guard at all.
    expect(postCodeFromContainer(el, 'a', IG_PATTERN)).toBe('CODE2')
  })

  it('matches IG /p/{code}/ pattern including trailing content after', () => {
    const el = document.createElement('article')
    el.innerHTML = `<a href="/p/CODE3/?img_index=2">link</a>`
    expect(postCodeFromContainer(el, 'a[href]', IG_PATTERN)).toBe('CODE3')
  })

  it('matches Threads /@{user}/post/{code} including /media suffix and trailing dash', () => {
    const el = document.createElement('div')
    el.innerHTML = `<a href="/@zuck/post/DaXWrlBEyf-/media">link</a>`
    expect(postCodeFromContainer(el, 'a[href]', THREADS_PATTERN)).toBe('DaXWrlBEyf-')
  })

  it('resolves fresh on every call — never caches a container-to-code mapping', () => {
    // Guards the module doc's "MUST be called fresh, never cached" contract:
    // Threads' virtualization recycles a pressable-container's CONTENTS to a
    // different post between reads without removing/replacing the node
    // itself (live-confirmed 2026-07-05). Simulate that by mutating the SAME
    // container element in place and re-reading — the second read must
    // reflect the new post, not the first.
    const el = document.createElement('div')
    el.innerHTML = `<a href="/@alice/post/FIRSTCODE">link</a>`
    expect(postCodeFromContainer(el, 'a[href]', THREADS_PATTERN)).toBe('FIRSTCODE')

    // Same node reference, contents swapped to a different post — no new
    // element created, exactly the virtualization-reuse scenario.
    el.innerHTML = `<a href="/@bob/post/SECONDCODE">link</a>`
    expect(postCodeFromContainer(el, 'a[href]', THREADS_PATTERN)).toBe('SECONDCODE')
  })

  it('returns the FIRST matching link in document order when a container holds more than one', () => {
    // Documents current, tested behavior for a container with multiple
    // shortcode-shaped links (e.g. an embedded quote/repost carrying its OWN
    // permalink nested inside the outer post's container) — a known v1 scope
    // limit, not a bug fix: `postCodeFromContainer` has no way to distinguish
    // "the outer post's own link" from "a nested embed's link" other than DOM
    // order, so if a platform ever renders the embed's link before the outer
    // post's own link, hover would resolve to the WRONG post. No live
    // Instagram/Threads markup has been found where this ordering is
    // violated, but it is untested/unverified, and this test exists so a
    // future markup change that reorders links is caught rather than
    // silently changing which post gets resolved.
    const el = document.createElement('article')
    el.innerHTML = `
      <a href="/p/OUTERCODE/">outer post link</a>
      <div class="quoted-post">
        <a href="/p/NESTEDCODE/">nested embed's own link</a>
      </div>
    `
    expect(postCodeFromContainer(el, 'a[href]', IG_PATTERN)).toBe('OUTERCODE')
  })
})

describe('permalinkAnchorFromContainer', () => {
  const IG_PATTERN = /^\/p\/([A-Za-z0-9_-]+)\//

  it('returns the first pattern-matching anchor element itself', () => {
    const el = document.createElement('article')
    el.innerHTML = `<a href="/explore/">no</a><a href="/p/CODE1/">yes</a>`
    const anchor = permalinkAnchorFromContainer(el, 'a[href]', IG_PATTERN)
    expect(anchor?.getAttribute('href')).toBe('/p/CODE1/')
  })

  it('skips anchors that carry no href attribute at all', () => {
    const el = document.createElement('article')
    el.innerHTML = `<a>bare</a><a href="/p/CODE2/">yes</a>`
    const anchor = permalinkAnchorFromContainer(el, 'a', IG_PATTERN)
    expect(anchor?.getAttribute('href')).toBe('/p/CODE2/')
  })

  it('returns null when no link matches', () => {
    const el = document.createElement('article')
    el.innerHTML = `<a href="/explore/">no</a>`
    expect(permalinkAnchorFromContainer(el, 'a[href]', IG_PATTERN)).toBeNull()
  })
})
