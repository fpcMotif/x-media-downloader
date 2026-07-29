import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'preact/hooks'
import { useFetchedStrategySelection } from './use-fetched-strategy-selection'

const fetchedApi = vi.hoisted(() => ({ request: vi.fn<() => Promise<boolean>>() }))

vi.mock('@/core/download/fetched-strategy', () => ({ requestFetchedAccess: fetchedApi.request }))

const deferred = <A,>() => {
  let resolve!: (value: A) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<A>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function Harness({
  update,
}: {
  readonly update: (patch: unknown, current?: () => boolean) => Promise<void>
}) {
  const [notice, setNotice] = useState<string | null>(null)
  const select = useFetchedStrategySelection(update, setNotice)
  return (
    <>
      <button type="button" onClick={() => select('fetched')}>
        Fetched
      </button>
      <button type="button" onClick={() => select('direct')}>
        Direct
      </button>
      <p>{notice}</p>
    </>
  )
}

describe('Fetched strategy lifetime (Saving and Popup)', () => {
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

  const mount = async () => {
    const update = vi
      .fn<(patch: unknown, current?: () => boolean) => Promise<void>>()
      .mockResolvedValue(undefined)
    const panel = document.createElement('div')
    host = panel
    document.body.append(panel)
    await act(async () => render(<Harness update={update} />, panel))
    const button = (name: string): HTMLButtonElement => {
      const node = [...panel.querySelectorAll('button')].find((item) => item.textContent === name)
      expect(node).toBeInstanceOf(HTMLButtonElement)
      return node as HTMLButtonElement
    }
    return { panel, update, button }
  }

  it('does not persist, publish, or arm a timer after unmount before a grant', async () => {
    const permission = deferred<boolean>()
    fetchedApi.request.mockReturnValue(permission.promise)
    const { panel, update, button } = await mount()

    await act(async () => button('Fetched').click())
    vi.useFakeTimers()
    render(null, panel)
    await act(async () => {
      permission.resolve(true)
      await Promise.resolve()
    })

    expect(update).not.toHaveBeenCalled()
    expect(panel.textContent).not.toContain('Fetched access')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not publish a rejected permission after unmount', async () => {
    const permission = deferred<boolean>()
    fetchedApi.request.mockReturnValue(permission.promise)
    const { panel, update, button } = await mount()

    await act(async () => button('Fetched').click())
    render(null, panel)
    await act(async () => {
      permission.reject(new Error('closed'))
      await Promise.resolve()
    })

    expect(update).not.toHaveBeenCalled()
    expect(panel.textContent).not.toContain('Could not request Fetched access.')
  })

  it('drops a late Fetched grant after Direct supersedes it', async () => {
    const permission = deferred<boolean>()
    fetchedApi.request.mockReturnValue(permission.promise)
    const { panel, update, button } = await mount()

    await act(async () => {
      button('Fetched').click()
      button('Direct').click()
    })
    await act(async () => {
      permission.resolve(true)
      await Promise.resolve()
    })

    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ downloadStrategy: 'direct' }, expect.any(Function))
    expect(panel.textContent).not.toContain('Fetched access')
  })
})
