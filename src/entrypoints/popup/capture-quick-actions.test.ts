import { readFileSync } from 'node:fs'
import { h, render } from 'preact'
import type { VNode } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

const captureApi = vi.hoisted(() => ({
  erase: vi.fn<() => Promise<unknown>>(),
  export: vi.fn<() => Promise<unknown>>(),
}))

const deferred = <A>() => {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

vi.mock('@/components/confirm-strip', () => ({
  ConfirmStrip: ({
    children,
    onConfirm,
  }: {
    children: (arm: () => void) => VNode
    onConfirm: () => void
  }) => h('div', null, children(onConfirm)),
}))

vi.mock('@/core/capture/client', () => ({ requestCaptureErase: captureApi.erase }))

vi.mock('@/components/capture-export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/capture-export')>()
  return { ...actual, runCaptureExport: captureApi.export }
})

import { CaptureQuickActions } from './capture-quick-actions'

// Static pins cover render-branch shape. Async behavior uses the DOM tests above.
const source = readFileSync('src/entrypoints/popup/capture-quick-actions.tsx', 'utf8')

const summary = {
  status: 'available' as const,
  summary: { tweets: 7, conversations: 1, recent: [] },
}

describe('CaptureQuickActions erase', () => {
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

  const openArchive = async (onCleared: () => void): Promise<HTMLDivElement> => {
    const panel = document.createElement('div')
    host = panel
    document.body.append(panel)
    await act(async () => {
      render(h(CaptureQuickActions, { summary, onCleared }), panel)
    })
    await act(async () => {
      ;[...panel.querySelectorAll('button')]
        .find((button) => button.textContent?.startsWith('Recent'))
        ?.click()
    })
    return panel
  }

  it('clears only after acknowledgement and uses the returned count', async () => {
    captureApi.erase.mockResolvedValue({ ok: true, cleared: 2 })
    const onCleared = vi.fn<() => void>()
    const panel = await openArchive(onCleared)

    await act(async () => {
      ;[...panel.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Erase archive'))
        ?.click()
    })

    expect(onCleared).toHaveBeenCalledOnce()
    expect(panel.textContent).toContain(
      'Erased 2 tweets and pending mirror work. Copies already sent to Convex remain.',
    )
  })

  it('calls onCleared after an acknowledged erase even when a newer export owns the notice', async () => {
    const eraseReply = deferred<{ ok: true; cleared: number }>()
    const exportReply = deferred<{ detail: string }>()
    captureApi.erase.mockReturnValue(eraseReply.promise)
    captureApi.export.mockReturnValue(exportReply.promise)
    const onCleared = vi.fn<() => void>()
    const panel = await openArchive(onCleared)
    const exportAll = [...panel.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Export all'),
    )

    await act(async () => {
      ;[...panel.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Erase archive'))
        ?.click()
    })
    await act(async () => exportAll?.click())
    await act(async () => {
      eraseReply.resolve({ ok: true, cleared: 2 })
      await Promise.resolve()
    })
    await act(async () => {
      exportReply.resolve({ detail: 'Export remains current.' })
      await Promise.resolve()
    })

    expect(onCleared).toHaveBeenCalledOnce()
    expect(panel.textContent).toContain('Export remains current.')
    expect(panel.textContent).not.toContain('Erased 2 tweets and pending mirror work.')
  })

  it('keeps the archive view on a rejected erase', async () => {
    captureApi.erase.mockResolvedValue({ ok: false })
    const onCleared = vi.fn<() => void>()
    const panel = await openArchive(onCleared)

    await act(async () => {
      ;[...panel.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Erase archive'))
        ?.click()
    })

    expect(onCleared).not.toHaveBeenCalled()
    expect(panel.textContent).toContain('Nothing captured yet.')
    expect(panel.textContent).toContain('Could not erase the archive. Try again.')
  })

  it('keeps the latest flash until its own timer expires', async () => {
    captureApi.export
      .mockResolvedValueOnce({ detail: 'First export.' })
      .mockResolvedValueOnce({ detail: 'Second export.' })
    const panel = await openArchive(vi.fn())
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

  it('publishes only the newest quick action when exports settle out of order', async () => {
    const first = deferred<{ detail: string }>()
    const second = deferred<{ detail: string }>()
    captureApi.export.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const panel = await openArchive(vi.fn())
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
    const onCleared = vi.fn<() => void>()
    const panel = await openArchive(onCleared)
    const exportAll = [...panel.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Export all'),
    )

    await act(async () => exportAll?.click())
    await act(async () => {
      ;[...panel.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Erase archive'))
        ?.click()
    })
    await act(async () => {
      exportReply.resolve({ detail: 'Exported before erase.' })
      await Promise.resolve()
    })

    expect(onCleared).toHaveBeenCalledOnce()
    expect(panel.textContent).toContain('Erased 2 tweets and pending mirror work.')
    expect(panel.textContent).not.toContain('Exported before erase.')
  })

  it('clears a pending flash timer on unmount', async () => {
    captureApi.export.mockResolvedValue({ detail: 'Exported.' })
    const panel = await openArchive(vi.fn())
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

  it('does not create a flash timer after the popup closes', async () => {
    const exportReply = deferred<{ detail: string }>()
    captureApi.export.mockReturnValue(exportReply.promise)
    const panel = await openArchive(vi.fn())
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
})

describe('CaptureQuickActions stays mounted while an erase flash is pending (Batch B adversarial review)', () => {
  it('early-returns only when tweets is 0 AND no flash is pending, not on tweets===0 alone', () => {
    // A bare `if (tweets === 0) return null` unmounts the block in the same
    // batched render that eraseArchive sets statusMsg — the "Erased {n}
    // tweets…" flash could never paint. The fix keeps the block mounted
    // until its own flashStatus timeout clears statusMsg.
    expect(source).toContain('if (tweets === 0 && statusMsg === null) return null')
    expect(source).not.toMatch(/if \(tweets === 0\) return null/u)
  })

  it('clears only after an acknowledged erase and uses its count', () => {
    expect(source).toContain('if (outcome.ok)')
    expect(source).toContain('onCleared()')
    expect(source).toContain('erasedArchiveCopy(outcome.cleared)')
    expect(source).toContain('eraseArchiveFailedCopy()')
  })

  it('blocks a second erase while the first request is pending', () => {
    expect(source).toContain('if (erasePending.current) return')
    expect(source).toContain('disabled={erasing}')
  })

  it('shows unavailable truth without a zero-count or empty-archive claim', () => {
    expect(source).toContain("if (summary.status === 'unavailable')")
    expect(source).toContain('Archive unavailable.')
  })
})
