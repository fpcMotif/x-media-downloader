import { beforeEach, describe, expect, it, vi } from 'vitest'

async function loadMain(): Promise<void> {
  vi.resetModules()
  vi.doMock('./App', () => ({ App: () => 'Popup shell' }))
  await import('./main')
}

beforeEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('popup main bootstrap', () => {
  it('clears the host root and renders the popup app', async () => {
    document.body.innerHTML = '<div id="app"><span>stale</span></div>'

    await loadMain()

    const root = document.getElementById('app')!
    expect(root.textContent).not.toContain('stale')
    expect(root.textContent).toContain('Popup shell')
  })

  it('does nothing when the popup root is absent', async () => {
    await expect(loadMain()).resolves.toBeUndefined()
    expect(document.body.innerHTML).toBe('')
  })
})
