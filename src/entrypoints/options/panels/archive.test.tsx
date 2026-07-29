import { render } from 'preact'
import type { VNode } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CaptureSummary, CaptureSummaryResult } from '@/components/capture-export'

const captureApi = vi.hoisted(() => ({
  erase: vi.fn<() => Promise<unknown>>(),
  fetch: vi.fn<() => Promise<unknown>>(),
  export: vi.fn<() => Promise<unknown>>(),
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

vi.mock('@/components/capture-export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/capture-export')>()
  return {
    ...actual,
    fetchCaptureSummary: captureApi.fetch,
    runCaptureExport: captureApi.export,
  }
})

vi.mock('@/core/capture/client', () => ({ requestCaptureErase: captureApi.erase }))

import { ArchivePanel } from './archive'

const summary: CaptureSummary = {
  tweets: 70,
  conversations: 70,
  recent: Array.from({ length: 70 }, (_, index) => ({
    conversationId: `conversation-${index}`,
    rootHandle: `user${index}`,
    rootText: `needle ${index}`,
    count: 1,
    lastAt: index,
  })),
}

const deferred = <A,>() => {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const erase = (panel: HTMLDivElement): HTMLButtonElement => {
  const trigger = [...panel.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Erase archive'),
  )
  expect(trigger).toBeInstanceOf(HTMLButtonElement)
  return trigger as HTMLButtonElement
}

const search = (panel: HTMLDivElement): HTMLInputElement => {
  const input = panel.querySelector('input[type="search"]')
  expect(input).toBeInstanceOf(HTMLInputElement)
  return input as HTMLInputElement
}

describe('ArchivePanel erase', () => {
  let host: HTMLDivElement | undefined

  afterEach(() => {
    if (host !== undefined) {
      render(null, host)
      host.remove()
    }
    host = undefined
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  const mount = async (
    result: CaptureSummaryResult = { status: 'available', summary },
  ): Promise<HTMLDivElement> => {
    captureApi.fetch.mockResolvedValue(result)
    const panel = document.createElement('div')
    host = panel
    document.body.append(panel)
    await act(async () => {
      render(<ArchivePanel />, panel)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    return panel
  }

  const filterAndPage = async (panel: HTMLDivElement): Promise<void> => {
    const input = search(panel)
    await act(async () => {
      input.value = 'needle'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      ;[...panel.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Show 50 more'))
        ?.click()
    })
    expect(panel.textContent).toContain('@user69')
  }

  it('preserves search, pager, and rows when erase is rejected', async () => {
    captureApi.erase.mockResolvedValue({ ok: false })
    const panel = await mount()
    await filterAndPage(panel)

    await act(async () => {
      erase(panel).click()
    })

    expect(captureApi.erase).toHaveBeenCalledOnce()
    expect(search(panel).value).toBe('needle')
    expect(panel.textContent).toContain('@user69')
    expect(panel.textContent).toContain('Could not erase the archive. Try again.')
  })

  it('clears archive state only after an acknowledged erase and uses its count', async () => {
    captureApi.erase.mockResolvedValue({ ok: true, cleared: 2 })
    const panel = await mount()
    await filterAndPage(panel)

    await act(async () => {
      erase(panel).click()
    })

    expect(search(panel).value).toBe('')
    expect(panel.textContent).toContain('Nothing captured yet.')
    expect(panel.textContent).toContain(
      'Erased 2 tweets and pending mirror work. Copies already sent to Convex remain.',
    )
  })

  it('applies an acknowledged erase after a newer export claims the notice', async () => {
    const eraseReply = deferred<{ ok: true; cleared: number }>()
    const exportReply = deferred<{ detail: string }>()
    captureApi.erase.mockReturnValue(eraseReply.promise)
    captureApi.export.mockReturnValue(exportReply.promise)
    const panel = await mount()
    const exportAll = [...panel.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Export all'),
    )

    await act(async () => erase(panel).click())
    await act(async () => exportAll?.click())
    await act(async () => {
      eraseReply.resolve({ ok: true, cleared: 2 })
      await Promise.resolve()
    })
    await act(async () => {
      exportReply.resolve({ detail: 'Export remains current.' })
      await Promise.resolve()
    })

    expect(search(panel).value).toBe('')
    expect(panel.textContent).toContain('Nothing captured yet.')
    expect(panel.textContent).toContain('Export remains current.')
    expect(panel.textContent).not.toContain('Erased 2 tweets and pending mirror work.')
  })

  it('allows only one pending erase and disables its trigger', async () => {
    let finish: ((outcome: { ok: true; cleared: number }) => void) | undefined
    captureApi.erase.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const panel = await mount()
    const trigger = erase(panel)

    await act(async () => {
      trigger.click()
    })
    expect(trigger.disabled).toBe(true)
    trigger.click()
    expect(captureApi.erase).toHaveBeenCalledOnce()

    await act(async () => {
      finish?.({ ok: true, cleared: 0 })
    })
  })

  it('keeps the latest export flash until its own timer expires', async () => {
    captureApi.export
      .mockResolvedValueOnce({ detail: 'First export.' })
      .mockResolvedValueOnce({ detail: 'Second export.' })
    const panel = await mount()
    const exportAll = [...panel.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Export all'),
    )

    vi.useFakeTimers()
    await act(async () => {
      exportAll?.click()
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
      exportAll?.click()
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(panel.textContent).toContain('Second export.')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(panel.textContent).not.toContain('Second export.')
  })

  it('publishes only the newest archive action when exports settle out of order', async () => {
    const first = deferred<{ detail: string }>()
    const second = deferred<{ detail: string }>()
    captureApi.export.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const panel = await mount()
    const exportAll = [...panel.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Export all'),
    )

    await act(async () => {
      exportAll?.click()
      exportAll?.click()
    })
    await act(async () => {
      second.resolve({ detail: 'Second export.' })
      await Promise.resolve()
    })
    await act(async () => {
      first.resolve({ detail: 'First export.' })
      await Promise.resolve()
    })

    expect(panel.textContent).toContain('Second export.')
    expect(panel.textContent).not.toContain('First export.')
  })

  it('does not let a late export overwrite an acknowledged erase', async () => {
    const exportReply = deferred<{ detail: string }>()
    captureApi.export.mockReturnValue(exportReply.promise)
    captureApi.erase.mockResolvedValue({ ok: true, cleared: 2 })
    const panel = await mount()
    const exportAll = [...panel.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Export all'),
    )

    await act(async () => exportAll?.click())
    await act(async () => erase(panel).click())
    await act(async () => {
      exportReply.resolve({ detail: 'Exported before erase.' })
      await Promise.resolve()
    })

    expect(panel.textContent).toContain('Erased 2 tweets and pending mirror work.')
    expect(panel.textContent).not.toContain('Exported before erase.')
  })

  it('clears a pending flash timer on unmount', async () => {
    captureApi.export.mockResolvedValue({ detail: 'Exported.' })
    const panel = await mount()
    const exportAll = [...panel.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Export all'),
    )

    vi.useFakeTimers()
    await act(async () => {
      exportAll?.click()
      await Promise.resolve()
    })
    expect(vi.getTimerCount()).toBe(1)

    render(null, panel)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not create an export flash timer after unmount', async () => {
    const exportReply = deferred<{ detail: string }>()
    captureApi.export.mockReturnValue(exportReply.promise)
    const panel = await mount()
    const exportAll = [...panel.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Export all'),
    )

    vi.useFakeTimers()
    await act(async () => exportAll?.click())
    render(null, panel)
    await act(async () => {
      exportReply.resolve({ detail: 'Exported after close.' })
      await Promise.resolve()
    })

    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not restore a pre-erase refresh after a successful erase', async () => {
    const staleRefresh = deferred<CaptureSummaryResult>()
    const eraseReply = deferred<{ ok: true; cleared: number }>()
    captureApi.fetch
      .mockResolvedValueOnce({ status: 'available', summary })
      .mockReturnValueOnce(staleRefresh.promise)
    captureApi.erase.mockReturnValue(eraseReply.promise)
    const panel = await mount()

    await act(async () => {
      erase(panel).click()
    })
    await act(async () => {
      ;[...panel.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Refresh'))
        ?.click()
    })
    await act(async () => {
      eraseReply.resolve({ ok: true, cleared: 70 })
      await Promise.resolve()
    })
    await act(async () => {
      staleRefresh.resolve({ status: 'available', summary })
      await Promise.resolve()
    })

    expect(panel.textContent).toContain('Nothing captured yet.')
    expect(panel.textContent).not.toContain('@user0')
  })

  it('keeps Refresh available but gates archive controls when the summary is unavailable', async () => {
    const panel = await mount({ status: 'unavailable' })

    expect(panel.textContent).toContain('Archive unavailable. Refresh to try again.')
    expect(search(panel).disabled).toBe(true)
    expect(
      [...panel.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Export all'),
      )?.disabled,
    ).toBe(true)
    expect(erase(panel).disabled).toBe(true)
    expect(
      [...panel.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Refresh'),
      )?.disabled,
    ).toBe(false)
  })
})
