import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { CaptureSummaryResult } from '@/components/capture-export'
import { useCaptureSummary, type CaptureSummaryState } from './use-capture-summary'

const deferred = <A,>() => {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function SummaryProbe({
  read,
  inspect,
}: {
  readonly read: () => Promise<CaptureSummaryResult>
  readonly inspect: (state: CaptureSummaryState) => void
}) {
  const state = useCaptureSummary(read)
  inspect(state)
  return (
    <output>
      {state.result?.status === 'available' ? state.result.summary.tweets : 'pending'}
    </output>
  )
}

describe('useCaptureSummary', () => {
  let host: HTMLDivElement | undefined

  afterEach(() => {
    if (host !== undefined) {
      render(null, host)
      host.remove()
    }
    host = undefined
  })

  it('does not let a pre-erase load repaint the confirmed empty state', async () => {
    const pending = deferred<CaptureSummaryResult>()
    let state: CaptureSummaryState | undefined
    const panel = document.createElement('div')
    host = panel
    document.body.append(panel)

    await act(async () => {
      render(
        <SummaryProbe
          read={() => pending.promise}
          inspect={(next) => {
            state = next
          }}
        />,
        panel,
      )
    })
    await act(async () => state?.clear())
    expect(panel.textContent).toBe('0')

    await act(async () => {
      pending.resolve({
        status: 'available',
        summary: { tweets: 8, conversations: 3, recent: [] },
      })
      await pending.promise
    })

    expect(panel.textContent).toBe('0')
  })
})
