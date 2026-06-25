import { describe, it, expect, beforeEach } from 'vitest'
import { findSensitiveRevealControls, clickSensitiveReveals, REVEAL_LABELS } from './reveal'

/** Build a detached subtree from an HTML string and return its root element. */
const frag = (html: string): HTMLElement => {
  const host = document.createElement('div')
  host.innerHTML = html.trim()
  return host
}

const labelsOf = (els: HTMLElement[]): string[] => els.map((el) => (el.textContent ?? '').trim())

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('findSensitiveRevealControls', () => {
  it('finds the reveal button inside a covered photo container', () => {
    const root = frag(`
      <article data-testid="tweet">
        <div data-testid="tweetPhoto">
          <div>Content warning: Sensitive content</div>
          <div role="button" tabindex="0"><span>Show</span></div>
        </div>
      </article>
    `)
    expect(labelsOf(findSensitiveRevealControls(root))).toEqual(['Show'])
  })

  it('ignores a shown photo container (a link, no button)', () => {
    const root = frag(`
      <article data-testid="tweet">
        <div data-testid="tweetPhoto">
          <a href="/u/status/1/photo/1"><img src="https://pbs.twimg.com/media/AAA.jpg" /></a>
        </div>
      </article>
    `)
    expect(findSensitiveRevealControls(root)).toEqual([])
  })

  it('never returns the ALT badge or media controls over a shown photo', () => {
    const root = frag(`
      <article data-testid="tweet">
        <div data-testid="tweetPhoto">
          <img src="https://pbs.twimg.com/media/AAA.jpg" />
          <div role="button" aria-label="Image">ALT</div>
          <div role="button" aria-label="Play">▶</div>
        </div>
      </article>
    `)
    expect(findSensitiveRevealControls(root)).toEqual([])
  })

  // ── Auto-fullscreen guard: never click a playback/expand control ─────────────
  it('never clicks a textless icon control (play/fullscreen), even localized', () => {
    const root = frag(`
      <article data-testid="tweet">
        <div data-testid="tweetPhoto">
          <div role="button" aria-label="Reproducir"><svg></svg></div>
          <div role="button"><svg></svg></div>
        </div>
      </article>
    `)
    expect(findSensitiveRevealControls(root)).toEqual([])
  })

  it('never clicks a control that wraps the <video> element', () => {
    const root = frag(`
      <article data-testid="tweet">
        <div data-testid="tweetPhoto">
          <div role="button"><video src="blob:x"></video></div>
        </div>
      </article>
    `)
    expect(findSensitiveRevealControls(root)).toEqual([])
  })

  it('never clicks a labelled fullscreen/expand control', () => {
    const root = frag(`
      <article data-testid="tweet">
        <div data-testid="tweetPhoto">
          <div role="button" aria-label="Fullscreen">FS</div>
          <div role="button" aria-label="Expand">EX</div>
        </div>
      </article>
    `)
    expect(findSensitiveRevealControls(root)).toEqual([])
  })

  it('never clicks a reveal-labelled button that wraps the video player', () => {
    const root = frag(`
      <article data-testid="tweet">
        <div data-testid="videoPlayer">
          <div role="button"><video src="blob:x"></video><span>View</span></div>
        </div>
      </article>
    `)
    expect(findSensitiveRevealControls(root)).toEqual([])
  })

  it('still reveals a covered photo whose worded label is localized', () => {
    const root = frag(`
      <article data-testid="tweet">
        <div data-testid="tweetPhoto">
          <div>Contenido sensible</div>
          <div role="button"><span>Mostrar</span></div>
        </div>
      </article>
    `)
    expect(labelsOf(findSensitiveRevealControls(root))).toEqual(['Mostrar'])
  })

  it('finds a post-level cover button that lives outside tweetPhoto (label match)', () => {
    const root = frag(`
      <article data-testid="tweet">
        <div>
          <div>Content warning: Sensitive content</div>
          <div>The post author flagged this post as showing sensitive content.</div>
          <div role="button" tabindex="0"><span>Show</span></div>
        </div>
      </article>
    `)
    expect(labelsOf(findSensitiveRevealControls(root))).toEqual(['Show'])
  })

  it('never auto-reveals a video cover (clicking one can fullscreen the video)', () => {
    const root = frag(`
      <article data-testid="tweet">
        <div data-testid="videoPlayer">
          <div role="button" tabindex="0"><span>View</span></div>
        </div>
      </article>
    `)
    expect(findSensitiveRevealControls(root)).toEqual([])
  })

  it('does not click a reveal-labelled button outside any tweet/lightbox scope', () => {
    const root = frag(`<div><div role="button">Show</div></div>`)
    expect(findSensitiveRevealControls(root)).toEqual([])
  })

  it('matches reveal labels exactly, sparing "Show more" / "Show this thread"', () => {
    const root = frag(`
      <article data-testid="tweet">
        <div role="button">Show more</div>
        <div role="button">Show this thread</div>
      </article>
    `)
    expect(findSensitiveRevealControls(root)).toEqual([])
  })

  it('de-duplicates a button matched by both the container and label passes', () => {
    const root = frag(`
      <article data-testid="tweet">
        <div data-testid="tweetPhoto">
          <div role="button"><span>Show</span></div>
        </div>
      </article>
    `)
    expect(findSensitiveRevealControls(root)).toHaveLength(1)
  })

  it('reveals covered photos but skips video covers across multiple tweets', () => {
    const root = frag(`
      <div>
        <article data-testid="tweet"><div data-testid="tweetPhoto"><div role="button">Show</div></div></article>
        <article data-testid="tweet"><div data-testid="videoPlayer"><div role="button">View</div></div></article>
      </div>
    `)
    expect(labelsOf(findSensitiveRevealControls(root))).toEqual(['Show'])
  })
})

describe('clickSensitiveReveals', () => {
  it('clicks each control once and records it so a re-scan does not re-fire', () => {
    const root = frag(`
      <article data-testid="tweet">
        <div data-testid="tweetPhoto"><div role="button">Show</div></div>
      </article>
    `)
    const button = root.querySelector<HTMLElement>('[role="button"]')!
    let clicks = 0
    button.addEventListener('click', () => clicks++)

    const clicked = new WeakSet<Element>()
    expect(clickSensitiveReveals(root, clicked)).toBe(1)
    expect(clicks).toBe(1)
    // Same DOM, second pass: already-clicked control is skipped.
    expect(clickSensitiveReveals(root, clicked)).toBe(0)
    expect(clicks).toBe(1)
  })

  it('clicks a freshly streamed-in cover on a later pass', () => {
    const root = frag(`<div></div>`)
    const clicked = new WeakSet<Element>()
    expect(clickSensitiveReveals(root, clicked)).toBe(0)

    root.firstElementChild!.innerHTML = `
      <article data-testid="tweet"><div data-testid="tweetPhoto"><div role="button">Show</div></div></article>
    `
    expect(clickSensitiveReveals(root, clicked)).toBe(1)
  })
})

describe('REVEAL_LABELS', () => {
  it('is the exact set of English reveal labels', () => {
    expect([...REVEAL_LABELS].toSorted()).toEqual(['Show', 'View'])
  })
})
