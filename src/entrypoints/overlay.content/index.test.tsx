import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '../../core/schema'

const item: MediaItem = {
  id: 'media-1',
  tweetId: '123',
  handle: 'alice',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/AAA.jpg?name=orig',
  ext: 'jpg',
  index: 0,
}

async function loadOverlay() {
  vi.resetModules()
  vi.stubGlobal('defineContentScript', (config: unknown) => config)
  vi.stubGlobal('createShadowRootUi', vi.fn<() => unknown>())
  return import('./index')
}

function mockElementsFromPoint(elements: Element[]): void {
  Object.defineProperty(document, 'elementsFromPoint', {
    configurable: true,
    value: vi.fn<() => Element[]>(() => elements),
  })
}

beforeEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('overlay helper behavior', () => {
  it('reports stable rects and dwell timing for the grab ring', async () => {
    const { DWELL_MS, rectOf } = await loadOverlay()
    const el = document.createElement('div')
    el.getBoundingClientRect = vi.fn<() => DOMRect>(
      () =>
        ({
          top: 10,
          left: 20,
          width: 30,
          height: 40,
        }) as DOMRect,
    )

    expect(DWELL_MS).toBe(1000)
    expect(rectOf(el)).toEqual({ top: 10, left: 20, width: 30, height: 40 })
  })

  it('parses transparent, opaque, rgb, and rgba backgrounds', async () => {
    const { bgAlpha } = await loadOverlay()
    expect(bgAlpha('transparent')).toBe(0)
    expect(bgAlpha('red')).toBe(1)
    expect(bgAlpha('rgb(1, 2, 3)')).toBe(1)
    expect(bgAlpha('rgba(1, 2, 3, 0.25)')).toBe(0.25)
  })

  it('returns the image at a point when only transparent or containing overlays precede it', async () => {
    const { imgAtPoint } = await loadOverlay()
    const wrapper = document.createElement('div')
    const transparent = document.createElement('div')
    const img = document.createElement('img')
    wrapper.appendChild(img)
    mockElementsFromPoint([transparent, wrapper, img])
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      backgroundColor: 'rgba(0, 0, 0, 0)',
    } as CSSStyleDeclaration)

    expect(imgAtPoint(1, 2)).toBe(img)
  })

  it('rejects missing, self-overlay, modal, and opaque occlusion hit-tests', async () => {
    const { imgAtPoint } = await loadOverlay()
    const img = document.createElement('img')
    mockElementsFromPoint([])
    expect(imgAtPoint(1, 2)).toBeNull()

    const ownOverlay = document.createElement('xmd-overlay')
    mockElementsFromPoint([ownOverlay, img])
    expect(imgAtPoint(1, 2)).toBeNull()

    const modal = document.createElement('div')
    modal.setAttribute('role', 'dialog')
    mockElementsFromPoint([modal, img])
    expect(imgAtPoint(1, 2)).toBeNull()

    const blocker = document.createElement('div')
    mockElementsFromPoint([blocker, img])
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      backgroundColor: 'rgba(0, 0, 0, 0.75)',
    } as CSSStyleDeclaration)
    expect(imgAtPoint(1, 2)).toBeNull()
  })

  it('sends bulk requests only when media exists', async () => {
    const { send } = await loadOverlay()
    const sendMessage = vi
      .spyOn(browser.runtime, 'sendMessage')
      .mockImplementation((async () => undefined) as unknown as typeof browser.runtime.sendMessage)

    send([])
    send([item])

    expect(sendMessage).toHaveBeenCalledOnce()
    expect(sendMessage).toHaveBeenCalledWith({ _tag: 'DownloadRequest', items: [item] })
  })

  it('tracks background replies and treats mismatches or errors as failed starts', async () => {
    const { sendTracked } = await loadOverlay()
    vi.spyOn(browser.runtime, 'sendMessage')
      .mockImplementationOnce((async () => ({
        completed: 1,
        total: 1,
      })) as unknown as typeof browser.runtime.sendMessage)
      .mockImplementationOnce((async () => ({
        completed: 0,
        total: 1,
      })) as unknown as typeof browser.runtime.sendMessage)
      .mockImplementationOnce(
        (async () => undefined) as unknown as typeof browser.runtime.sendMessage,
      )
      .mockImplementationOnce((async () => {
        throw new Error('closed')
      }) as unknown as typeof browser.runtime.sendMessage)

    await expect(sendTracked([item])).resolves.toBe(true)
    await expect(sendTracked([item])).resolves.toBe(false)
    await expect(sendTracked([item])).resolves.toBe(false)
    await expect(sendTracked([item])).resolves.toBe(false)
  })
})
