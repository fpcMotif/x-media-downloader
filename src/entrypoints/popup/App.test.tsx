import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import { setSettings } from '../../core/settings'
import { App } from './App'

let root: HTMLDivElement

const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const flush = async (): Promise<void> => {
  await settle()
  await settle()
  await settle()
  await settle()
  await settle()
}

const renderApp = async (): Promise<void> => {
  await act(async () => {
    render(<App />, root)
  })
  await flush()
}

beforeEach(() => {
  fakeBrowser.reset()
  vi.restoreAllMocks()
  vi.spyOn(globalThis, 'setInterval').mockImplementation((() => 0) as unknown as typeof setInterval)
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
  root = document.createElement('div')
  document.body.appendChild(root)
})

afterEach(async () => {
  await act(async () => {
    render(null, root)
  })
  root.remove()
})

describe('popup App', () => {
  it('renders settings, metrics, and X-tab actions from browser state', async () => {
    vi.spyOn(browser.tabs, 'query').mockImplementation(
      (async () =>
        [
          { id: 7, url: 'https://x.com/alice/status/123' },
        ] as Browser.tabs.Tab[]) as unknown as typeof browser.tabs.query,
    )
    vi.spyOn(browser.tabs, 'sendMessage').mockImplementation((async () => ({
      _tag: 'ClearDetectedMediaResponse',
      cleared: 1,
      rescanned: 1,
    })) as unknown as typeof browser.tabs.sendMessage)
    vi.spyOn(browser.runtime, 'sendMessage').mockImplementation((async (message: unknown) => {
      const tag = (message as { _tag?: string })._tag
      if (tag === 'MetricsRequest') {
        return {
          total: 3,
          completed: 1,
          failed: 1,
          active: 0,
          retries: 2,
          concurrencyCap: 3,
          bytesReceived: 1_000,
          bytesTotal: 2_000,
          throughputBps: 1_500_000,
          etaSeconds: 1.2,
          elapsedMs: 1000,
        }
      }
      if (tag === 'ClearDownloadMonitorRequest') return { ok: true }
      return null
    }) as unknown as typeof browser.runtime.sendMessage)

    await act(async () => {
      render(<App />, root)
    })
    expect(root.textContent).toContain('Loading...')
    await flush()

    expect(root.textContent).toContain('Ready on this X tab')
    expect(root.textContent).toContain('2/3 done')
    expect(root.textContent).toContain('67%')
    expect(root.textContent).toContain('1.5 MB/s')
    expect(root.textContent).toContain('Failed')
    expect(root.textContent).toContain('Retries')

    await act(async () => {
      root.querySelector<HTMLButtonElement>('.xmd-primary-button')!.click()
      await Promise.resolve()
    })
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(7, {
      _tag: 'ClearDetectedMediaRequest',
      rescanVisible: true,
    })

    await act(async () => {
      root.querySelectorAll<HTMLButtonElement>('button')[1]!.click()
      await Promise.resolve()
    })
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      _tag: 'ClearDownloadMonitorRequest',
    })
  })

  it('disables tab actions when active-tab lookup fails', async () => {
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => {
      throw new Error('no tab permission')
    }) as unknown as typeof browser.tabs.query)
    vi.spyOn(browser.runtime, 'sendMessage').mockImplementation((async () => {
      throw new Error('no background')
    }) as unknown as typeof browser.runtime.sendMessage)

    await renderApp()

    expect(root.textContent).toContain('Open X or Twitter to scan media')
    expect(root.querySelector<HTMLButtonElement>('.xmd-primary-button')!.disabled).toBe(true)
  })

  it('requests aria2 origin access from the rendered aria2 settings', async () => {
    await setSettings({ downloadStrategy: 'aria2', aria2RpcUrl: 'http://localhost:6800/jsonrpc' })
    vi.spyOn(browser.tabs, 'query').mockImplementation(
      (async () =>
        [
          { id: 8, url: 'https://example.com/' },
        ] as Browser.tabs.Tab[]) as unknown as typeof browser.tabs.query,
    )
    vi.spyOn(browser.runtime, 'sendMessage').mockImplementation((async () => {
      throw new Error('no metrics')
    }) as unknown as typeof browser.runtime.sendMessage)
    vi.spyOn(browser.permissions, 'contains').mockImplementation(
      (async () => false) as unknown as typeof browser.permissions.contains,
    )
    vi.spyOn(browser.permissions, 'request').mockImplementation(
      (async () => true) as unknown as typeof browser.permissions.request,
    )

    await renderApp()

    const grant = Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Grant localhost access'),
    )
    expect(grant).toBeDefined()

    await act(async () => {
      grant!.click()
      await Promise.resolve()
    })

    expect(browser.permissions.request).toHaveBeenCalledWith({
      origins: ['http://localhost/*'],
    })
    expect(root.textContent).toContain('localhost access granted')
  })
})
