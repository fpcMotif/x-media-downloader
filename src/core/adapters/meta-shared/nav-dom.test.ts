import { describe, it, expect, beforeEach } from 'vitest'
import {
  actionControlByAria,
  buildNavSnapshot,
  carouselControlsByAria,
  enumerateNavColumns,
} from './nav-dom'

const THREADS_POST = "div[data-pressable-container='true']"
const threadsPost = `<div data-pressable-container="true"></div>`

let root: HTMLElement
beforeEach(() => {
  document.body.innerHTML = ''
  root = document.createElement('div')
  document.body.appendChild(root)
})

describe('enumerateNavColumns', () => {
  it('returns [] when no posts exist', () => {
    root.innerHTML = '<main><p>no posts</p></main>'
    expect(enumerateNavColumns(root, THREADS_POST)).toEqual([])
  })

  it('treats a flat single feed as one implicit column in document order', () => {
    root.innerHTML = `<main>${threadsPost}${threadsPost}${threadsPost}</main>`
    const columns = enumerateNavColumns(root, THREADS_POST)
    expect(columns).toHaveLength(1)
    expect(columns[0]?.container).toBeNull()
    expect(columns[0]?.posts).toHaveLength(3)
    expect(columns[0]?.posts.map((p) => p.tagName)).toEqual(['DIV', 'DIV', 'DIV'])
  })

  it('treats a feed wrapping every post in its own div as ONE column, not n', () => {
    root.innerHTML = `<main><div>${threadsPost}</div><div>${threadsPost}</div><div>${threadsPost}</div></main>`
    const columns = enumerateNavColumns(root, THREADS_POST)
    expect(columns).toHaveLength(1)
    expect(columns[0]?.container).toBeNull()
    expect(columns[0]?.posts).toHaveLength(3)
  })

  it('groups posts by their column subtree in a real multi-column layout', () => {
    root.innerHTML = `<main>
      <section id="colA">${threadsPost}${threadsPost}${threadsPost}</section>
      <section id="colB">${threadsPost}${threadsPost}</section>
    </main>`
    const columns = enumerateNavColumns(root, THREADS_POST)
    expect(columns).toHaveLength(2)
    expect(columns[0]?.container).toBe(root.querySelector('#colA'))
    expect(columns[0]?.posts).toHaveLength(3)
    expect(columns[1]?.container).toBe(root.querySelector('#colB'))
    expect(columns[1]?.posts).toHaveLength(2)
  })

  it('still finds columns when each column wraps its posts individually', () => {
    root.innerHTML = `<main>
      <section id="colA"><div>${threadsPost}</div><div>${threadsPost}</div></section>
      <section id="colB"><div>${threadsPost}</div><div>${threadsPost}</div></section>
    </main>`
    const columns = enumerateNavColumns(root, THREADS_POST)
    expect(columns).toHaveLength(2)
    expect(columns[0]?.container).toBe(root.querySelector('#colA'))
    expect(columns[1]?.container).toBe(root.querySelector('#colB'))
  })

  it('degrades to one column when every "column" holds a single post', () => {
    root.innerHTML = `<main>
      <section>${threadsPost}</section>
      <section>${threadsPost}</section>
    </main>`
    const columns = enumerateNavColumns(root, THREADS_POST)
    expect(columns).toHaveLength(1)
    expect(columns[0]?.container).toBeNull()
    expect(columns[0]?.posts).toHaveLength(2)
  })

  it('orders columns by first appearance in document order', () => {
    root.innerHTML = `<main>
      <section id="later">${threadsPost}${threadsPost}</section>
      <section id="earlier">${threadsPost}${threadsPost}</section>
    </main>`
    const columns = enumerateNavColumns(root, THREADS_POST)
    expect(columns[0]?.container).toBe(root.querySelector('#later'))
    expect(columns[1]?.container).toBe(root.querySelector('#earlier'))
  })

  it('treats a large flat feed as one implicit column (no grouping ancestor)', () => {
    root.innerHTML = `<main>${threadsPost.repeat(20)}</main>`
    const columns = enumerateNavColumns(root, THREADS_POST)
    expect(columns).toHaveLength(1)
    expect(columns[0]?.container).toBeNull()
    expect(columns[0]?.posts).toHaveLength(20)
  })

  it('resolves nested column groups to the innermost qualifying ancestor', () => {
    root.innerHTML = `<main>
      <div id="outerA">
        <section id="innerA1">${threadsPost}${threadsPost}</section>
        <section id="innerA2">${threadsPost}${threadsPost}</section>
      </div>
      <div id="outerB">
        <section id="innerB1">${threadsPost}${threadsPost}</section>
        <section id="innerB2">${threadsPost}${threadsPost}</section>
      </div>
    </main>`
    const columns = enumerateNavColumns(root, THREADS_POST)
    // The innermost <section>s each hold >1 post and have a sibling section
    // that also holds posts, so grouping resolves at the inner level, not
    // the outer <div>s (which would also technically qualify).
    expect(columns).toHaveLength(4)
    expect(columns.map((c) => c.container)).toEqual([
      root.querySelector('#innerA1'),
      root.querySelector('#innerA2'),
      root.querySelector('#innerB1'),
      root.querySelector('#innerB2'),
    ])
  })

  it('finds a post inside a non-post wrapper inside a column', () => {
    root.innerHTML = `<main>
      <section id="colA">
        <div class="wrapper"><span class="inner">${threadsPost}</span></div>
        <div class="wrapper"><span class="inner">${threadsPost}</span></div>
      </section>
      <section id="colB">${threadsPost}${threadsPost}</section>
    </main>`
    const columns = enumerateNavColumns(root, THREADS_POST)
    expect(columns).toHaveLength(2)
    expect(columns[0]?.container).toBe(root.querySelector('#colA'))
    expect(columns[0]?.posts).toHaveLength(2)
    expect(columns[1]?.container).toBe(root.querySelector('#colB'))
    expect(columns[1]?.posts).toHaveLength(2)
  })
})

describe('buildNavSnapshot', () => {
  it('maps columns to the machine snapshot using idOf, falling back to positional ids', () => {
    root.innerHTML = `<main>
      <section>${threadsPost}${threadsPost}</section>
      <section>${threadsPost}</section>
    </main>`
    const columns = enumerateNavColumns(root, THREADS_POST)
    const ids = new Map<Element, string>([
      [columns[0]!.posts[0]!, 'aaa'],
      [columns[1]!.posts[0]!, 'ccc'],
    ])
    const snap = buildNavSnapshot(columns, (el) => ids.get(el) ?? null)
    expect(snap.columns).toHaveLength(2)
    expect(snap.columns[0]?.posts.map((p) => p.id)).toEqual(['aaa', 'anon-0-1'])
    expect(snap.columns[1]?.posts.map((p) => p.id)).toEqual(['ccc'])
  })
})

describe('carouselControlsByAria', () => {
  it('finds prev/next buttons inside a carousel post', () => {
    root.innerHTML = threadsPost.replace(
      '></div>',
      `><button aria-label="Go back"></button><button aria-label="Next"></button></div>`,
    )
    const post = root.querySelector(THREADS_POST)!
    const controls = carouselControlsByAria(post)
    expect(controls.prev?.getAttribute('aria-label')).toBe('Go back')
    expect(controls.next?.getAttribute('aria-label')).toBe('Next')
  })

  it('returns null controls for a single-media post', () => {
    root.innerHTML = threadsPost
    const post = root.querySelector(THREADS_POST)!
    expect(carouselControlsByAria(post)).toEqual({ prev: null, next: null })
  })
})

describe('actionControlByAria', () => {
  it('returns the first control matching any of the labels', () => {
    root.innerHTML = threadsPost.replace(
      '></div>',
      `><span aria-label="Reply"></span><span aria-label="Like"></span></div>`,
    )
    const post = root.querySelector(THREADS_POST)!
    expect(actionControlByAria(post, ['Like'])?.getAttribute('aria-label')).toBe('Like')
    expect(actionControlByAria(post, ['Reply'])?.getAttribute('aria-label')).toBe('Reply')
  })

  it('returns null when no labeled control exists', () => {
    root.innerHTML = threadsPost
    const post = root.querySelector(THREADS_POST)!
    expect(actionControlByAria(post, ['Like'])).toBeNull()
  })
})
