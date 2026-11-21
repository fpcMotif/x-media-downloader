import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Settings } from '@/packages/schema'
import { useColorScheme } from './use-color-scheme'

function Probe({ theme }: { readonly theme: Settings['theme'] | 'pending' }) {
  useColorScheme(theme)
  return null
}

const meta = (): HTMLMetaElement => {
  const found = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')
  if (!found) throw new Error('missing color-scheme meta')
  return found
}

describe('useColorScheme', () => {
  let root: HTMLDivElement

  beforeEach(() => {
    document.head.innerHTML = '<meta name="color-scheme" content="light dark">'
    localStorage.clear()
    root = document.createElement('div')
    document.body.append(root)
  })

  afterEach(() => {
    render(null, root)
    root.remove()
  })

  it('pins the meta and stores an explicit light or dark choice', async () => {
    await act(() => render(<Probe theme="dark" />, root))
    expect(meta().content).toBe('dark')
    expect(localStorage.getItem('xmd-color-scheme')).toBe('dark')

    await act(() => render(<Probe theme="light" />, root))
    expect(meta().content).toBe('light')
    expect(localStorage.getItem('xmd-color-scheme')).toBe('light')
  })

  it('returns to the system preference and clears storage for system', async () => {
    localStorage.setItem('xmd-color-scheme', 'dark')
    meta().content = 'dark'
    await act(() => render(<Probe theme="system" />, root))
    expect(meta().content).toBe('light dark')
    expect(localStorage.getItem('xmd-color-scheme')).toBeNull()
  })

  it('leaves the early-applied scheme alone while settings are still loading', async () => {
    localStorage.setItem('xmd-color-scheme', 'dark')
    meta().content = 'dark'
    await act(() => render(<Probe theme="pending" />, root))
    expect(meta().content).toBe('dark')
    expect(localStorage.getItem('xmd-color-scheme')).toBe('dark')
  })

  it('follows a change made in another extension page', async () => {
    await act(() => render(<Probe theme="system" />, root))
    await act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'xmd-color-scheme', newValue: 'dark' }),
      )
    })
    expect(meta().content).toBe('dark')
  })
})
