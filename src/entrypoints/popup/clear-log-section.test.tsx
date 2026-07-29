import { h, render } from 'preact'
import { afterEach, describe, expect, it } from 'vitest'
import { ClearLogSection } from './clear-log-section'

let host: HTMLDivElement | undefined

const show = (log: Parameters<typeof ClearLogSection>[0]['log']): HTMLDivElement => {
  host = document.createElement('div')
  document.body.append(host)
  render(h(ClearLogSection, { log }), host)
  return host
}

afterEach(() => {
  if (host !== undefined) {
    render(null, host)
    host.remove()
  }
  host = undefined
})

describe('ClearLogSection', () => {
  it('keeps loading, unavailable, and empty states distinct', () => {
    expect(show(null).textContent).toContain('Loading verified clears…')
    render(h(ClearLogSection, { log: { status: 'unavailable' } }), host!)
    expect(host!.textContent).toContain('Clear log unavailable.')
    render(h(ClearLogSection, { log: { status: 'available', records: [] } }), host!)
    expect(host!.textContent).toContain('No verified clears yet.')
  })

  it('renders newest verified records with scope, time, and canonical permalink', () => {
    const panel = show({
      status: 'available',
      records: [
        {
          tweetId: '12345678901234567890',
          scope: 'bookmark',
          at: 0,
          mechanism: 'dom-click',
          permalink: 'https://x.com/i/status/12345678901234567890',
        },
      ],
    })

    expect(panel.textContent).toContain('Bookmark')
    expect(panel.textContent).toMatch(/Jan.*\d{1,2}:\d{2}/u)
    expect(panel.querySelector('a')?.getAttribute('href')).toBe(
      'https://x.com/i/status/12345678901234567890',
    )
  })
})
