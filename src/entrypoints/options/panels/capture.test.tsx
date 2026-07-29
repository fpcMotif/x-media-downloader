import { render } from 'preact'
import { act } from 'preact/test-utils'
import { Schema } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Settings } from '@/core/schema'

const captureApi = vi.hoisted(() => ({ fetch: vi.fn<() => Promise<unknown>>() }))

vi.mock('@/components/capture-export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/capture-export')>()
  return { ...actual, fetchCaptureSummary: captureApi.fetch }
})

import { CapturePanel } from './capture'

const settings = Schema.decodeUnknownSync(Settings)({})

describe('CapturePanel archive truth', () => {
  let host: HTMLDivElement | undefined

  afterEach(() => {
    if (host !== undefined) {
      render(null, host)
      host.remove()
    }
    host = undefined
    vi.clearAllMocks()
  })

  const mount = async (): Promise<HTMLDivElement> => {
    const panel = document.createElement('div')
    host = panel
    document.body.append(panel)
    await act(async () => {
      render(
        <CapturePanel settings={settings} update={async () => {}} reload={async () => {}} />,
        panel,
      )
    })
    return panel
  }

  it('shows loading, unavailable, and a valid empty archive distinctly', async () => {
    let settle: ((value: { readonly status: 'unavailable' }) => void) | undefined
    captureApi.fetch.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve
      }),
    )
    const panel = await mount()
    expect(panel.textContent).toContain('Loading archive…')

    await act(async () => {
      settle?.({ status: 'unavailable' })
    })
    expect(panel.textContent).toContain('Archive unavailable')
    expect(panel.textContent).not.toContain('0 tweets')

    captureApi.fetch.mockResolvedValue({
      status: 'available',
      summary: { tweets: 0, conversations: 0, recent: [] },
    })
    render(null, panel)
    await act(async () => {
      render(
        <CapturePanel settings={settings} update={async () => {}} reload={async () => {}} />,
        panel,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(panel.textContent).toContain('0 tweets · 0 conversations')
  })

  it('states that local erase does not delete copies already sent to Convex', async () => {
    captureApi.fetch.mockResolvedValue({
      status: 'available',
      summary: { tweets: 0, conversations: 0, recent: [] },
    })
    const configured = Schema.decodeUnknownSync(Settings)({
      captureEnabled: true,
      captureMirrorEnabled: true,
      convexUrl: 'https://x.convex.cloud',
      convexSyncSecret: 'secret',
    })
    const panel = document.createElement('div')
    host = panel
    document.body.append(panel)
    await act(async () => {
      render(
        <CapturePanel settings={configured} update={async () => {}} reload={async () => {}} />,
        panel,
      )
    })

    expect(panel.textContent).toContain(
      'Erasing this device’s archive removes pending mirror work, not copies already sent.',
    )
  })
})
