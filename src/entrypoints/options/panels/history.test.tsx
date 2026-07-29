import { render } from 'preact'
import type { VNode } from 'preact'
import { act } from 'preact/test-utils'
import { Schema } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Settings, type MediaItem } from '@/core/schema'
import { recordFromMediaItem } from '@/core/history/record'

const historyApi = vi.hoisted(() => ({
  fetch: vi.fn<() => Promise<unknown>>(),
  erase: vi.fn<() => Promise<unknown>>(),
}))

vi.mock('@/components/confirm-strip', () => ({
  ConfirmStrip: ({
    children,
    onConfirm,
  }: {
    children: (arm: () => void) => VNode
    onConfirm: () => void
  }) => <div>{children(onConfirm)}</div>,
}))

vi.mock('@/entrypoints/popup/history-section', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/entrypoints/popup/history-section')>()
  return {
    ...actual,
    fetchHistory: historyApi.fetch,
    requestHistoryErase: historyApi.erase,
  }
})

import { HistoryPanel } from './history'

const record = recordFromMediaItem(
  {
    id: '123-0',
    platform: 'x',
    postId: '123',
    author: 'alice',
    type: 'photo',
    url: 'https://pbs.twimg.com/media/123-0?format=jpg&name=orig',
    ext: 'jpg',
    index: 0,
  } satisfies MediaItem,
  'alice/123-0.jpg',
  1,
)

describe('HistoryPanel', () => {
  let host: HTMLDivElement | undefined

  afterEach(() => {
    if (host !== undefined) {
      render(null, host)
      host.remove()
    }
    host = undefined
    vi.clearAllMocks()
  })

  it('keeps rendered records when the background rejects an erase request', async () => {
    historyApi.fetch.mockResolvedValue({ status: 'available', records: [record] })
    historyApi.erase.mockResolvedValue(false)
    const panel = document.createElement('div')
    host = panel
    document.body.append(panel)

    await act(async () => {
      render(
        <HistoryPanel
          settings={Schema.decodeUnknownSync(Settings)({ downloadHistoryEnabled: true })}
          update={async () => {}}
          reload={async () => {}}
        />,
        panel,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(historyApi.fetch).toHaveBeenCalledOnce()
    expect(panel.textContent).toContain('alice/123-0.jpg')
    const erase = [...panel.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Erase history'),
    )
    expect(erase).toBeDefined()

    await act(async () => {
      erase?.click()
    })

    expect(historyApi.erase).toHaveBeenCalledOnce()
    expect(panel.textContent).toContain('alice/123-0.jpg')
  })

  it('shows unavailable history as unavailable, not as an empty history', async () => {
    historyApi.fetch.mockResolvedValue({ status: 'unavailable' })
    const panel = document.createElement('div')
    host = panel
    document.body.append(panel)

    await act(async () => {
      render(
        <HistoryPanel
          settings={Schema.decodeUnknownSync(Settings)({ downloadHistoryEnabled: true })}
          update={async () => {}}
          reload={async () => {}}
        />,
        panel,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(panel.textContent).toContain('Download history is unavailable.')
    expect(panel.textContent).not.toContain('No downloads yet')
  })

  it('shows a loading state before history resolves', async () => {
    historyApi.fetch.mockReturnValue(new Promise(() => {}))
    const panel = document.createElement('div')
    host = panel
    document.body.append(panel)

    await act(async () => {
      render(
        <HistoryPanel
          settings={Schema.decodeUnknownSync(Settings)({ downloadHistoryEnabled: true })}
          update={async () => {}}
          reload={async () => {}}
        />,
        panel,
      )
    })

    expect(panel.textContent).toContain('Loading download history…')
  })

  it('shows the valid empty state after an acknowledged erase', async () => {
    historyApi.fetch.mockResolvedValue({ status: 'available', records: [record] })
    historyApi.erase.mockResolvedValue(true)
    const panel = document.createElement('div')
    host = panel
    document.body.append(panel)

    await act(async () => {
      render(
        <HistoryPanel
          settings={Schema.decodeUnknownSync(Settings)({ downloadHistoryEnabled: true })}
          update={async () => {}}
          reload={async () => {}}
        />,
        panel,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const erase = [...panel.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Erase history'),
    )

    await act(async () => {
      erase?.click()
    })

    expect(panel.textContent).toContain('No downloads yet — files you save will appear here.')
    expect(panel.textContent).not.toContain('Download history is unavailable.')
  })
})
