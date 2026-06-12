import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import type { MediaItem } from '../core/schema'

const item: MediaItem = {
  id: 'media-1',
  tweetId: '123',
  handle: 'alice',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/AAA.jpg?name=orig',
  ext: 'jpg',
  index: 0,
}

async function loadBackground() {
  vi.resetModules()
  vi.stubGlobal('defineBackground', (setup: () => void) => {
    setup()
    return setup
  })
  vi.spyOn(browser.downloads.onChanged, 'addListener').mockImplementation(() => {})
  vi.spyOn(browser.runtime.onMessage, 'addListener').mockImplementation(() => {})
  const mod = await import('../entrypoints/background')
  mod.registerBackgroundListeners()
  mod.resetBackgroundStateForTest()
  return mod
}

beforeEach(() => {
  fakeBrowser.reset()
  vi.restoreAllMocks()
})

describe('background download handling', () => {
  it('persists nothing when no live metrics accumulator exists', async () => {
    const mod = await loadBackground()
    await expect(mod.persistSnapshotForTest(Date.now())).resolves.toBeUndefined()
  })

  it('starts direct downloads once and drops duplicate in-flight requests', async () => {
    vi.spyOn(browser.downloads, 'download').mockImplementation(
      (async () => 101) as unknown as typeof browser.downloads.download,
    )
    const mod = await loadBackground()
    const { setSettings } = await import('../core/settings')
    await setSettings({
      downloadStrategy: 'direct',
      sidecarMetadata: false,
      filenameTemplate: '{tweetId}_{index}.{ext}',
      downloadConcurrency: 1,
    })

    const first = await Effect.runPromise(mod.handleDownload([item]))
    const duplicate = await Effect.runPromise(mod.handleDownload([item]))

    expect(first).toEqual({ _tag: 'QueueUpdate', completed: 1, total: 1 })
    expect(duplicate).toEqual({ _tag: 'QueueUpdate', completed: 0, total: 0 })
    expect(browser.downloads.download).toHaveBeenCalledTimes(1)
    expect(browser.downloads.download).toHaveBeenCalledWith({
      url: item.url,
      filename: '123_0.jpg',
      conflictAction: 'uniquify',
    })
  })

  it('routes aria2 media through JSON-RPC and sidecars through browser downloads', async () => {
    vi.spyOn(browser.downloads, 'download').mockImplementation(
      (async () => 202) as unknown as typeof browser.downloads.download,
    )
    const fetchImpl = vi.fn<typeof fetch>(
      async () => ({ json: async () => ({ result: 'gid-1' }) }) as Response,
    )
    vi.stubGlobal('fetch', fetchImpl)
    const mod = await loadBackground()
    const { setSettings } = await import('../core/settings')
    await setSettings({
      downloadStrategy: 'aria2',
      sidecarMetadata: true,
      filenameTemplate: '{handle}/{tweetId}_{index}.{ext}',
      downloadConcurrency: 2,
      aria2RpcUrl: 'http://localhost:6800/jsonrpc',
      aria2Secret: 'secret',
      aria2Dir: 'D:/x-media',
      aria2Split: 4,
    })

    const res = await Effect.runPromise(mod.handleDownload([item]))

    expect(res).toEqual({ _tag: 'QueueUpdate', completed: 2, total: 2 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [, init] = fetchImpl.mock.calls[0]!
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.params).toEqual([
      'token:secret',
      [item.url],
      {
        out: 'alice/123_0.jpg',
        split: '4',
        'max-connection-per-server': '4',
        dir: 'D:/x-media',
      },
    ])
    expect(browser.downloads.download).toHaveBeenCalledTimes(1)
    expect(vi.mocked(browser.downloads.download).mock.calls[0]![0].url).toMatch(
      /^data:application\/json/,
    )
  })
})
