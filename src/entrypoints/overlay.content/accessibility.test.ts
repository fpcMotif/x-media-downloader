import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const overlaySource = readFileSync('src/entrypoints/overlay.content/index.tsx', 'utf8')
const overlayCss = readFileSync('src/entrypoints/overlay.content/style.css', 'utf8')

describe('overlay save-status announcements (a11y)', () => {
  it('wires the badge name and status to the pure helpers', () => {
    expect(overlaySource).toContain('aria-label={badgeAriaLabel(badge.phase, mediaType)}')
    expect(overlaySource).toContain('{badgeStatusMessage(badge.phase, mediaType)}')
  })

  it('wires the launcher name and status to the pure helpers', () => {
    expect(overlaySource).toContain('aria-label={launcherAriaLabel(launcher, store.count)}')
    expect(overlaySource).toContain('{launcherStatusMessage(launcher, store.count)}')
  })

  it('keeps one always-mounted polite live region per control', () => {
    // <output> carries the implicit ARIA `status` role (lint: prefer-tag-over-role).
    const regions = overlaySource.match(
      /<output class="xmd-sr-only" aria-live="polite" aria-atomic="true">/g,
    )
    expect(regions).toHaveLength(2)
  })

  it('keeps aria-busy on the queued state of both controls', () => {
    expect(overlaySource).toContain("aria-busy={badge.phase === 'queued'}")
    expect(overlaySource).toContain("aria-busy={launcher === 'queued'}")
  })

  it('ships the clipped visually-hidden class', () => {
    expect(overlayCss).toContain('.xmd-sr-only')
    expect(overlayCss).toContain('clip: rect(0, 0, 0, 0);')
  })
})
