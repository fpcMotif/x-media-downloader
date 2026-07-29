import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { MetricsSnapshot } from '@/core/schema/download'
import { useDownloadMonitor, type DownloadMonitorState } from './use-download-monitor'

const deferred = <A,>() => {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const snapshot: MetricsSnapshot = {
  total: 2,
  completed: 2,
  failed: 0,
  active: 0,
  retries: 0,
  concurrencyCap: 1,
  bytesReceived: 100,
  bytesTotal: 100,
  throughputBps: 0,
  elapsedMs: 1,
}

function MonitorProbe({
  read,
  clear,
  inspect,
}: {
  readonly read: () => Promise<unknown>
  readonly clear: () => Promise<unknown>
  readonly inspect: (state: DownloadMonitorState) => void
}) {
  const state = useDownloadMonitor(read, clear)
  inspect(state)
  return <output>{state.metrics?.total ?? 0}</output>
}

describe('useDownloadMonitor', () => {
  let host: HTMLDivElement | undefined

  afterEach(() => {
    if (host !== undefined) {
      render(null, host)
      host.remove()
    }
    host = undefined
  })

  it('rejects a poll reply older than a confirmed reset', async () => {
    const pending = deferred<unknown>()
    let state: DownloadMonitorState | undefined
    const panel = document.createElement('div')
    host = panel
    document.body.append(panel)

    await act(async () => {
      render(
        <MonitorProbe
          read={() => pending.promise}
          clear={async () => ({
            _tag: 'ClearDownloadMonitorResponse',
            ok: true,
            clearedMetrics: true,
            active: 0,
            clearedLocks: 0,
          })}
          inspect={(next) => {
            state = next
          }}
        />,
        panel,
      )
    })
    await act(async () => {
      expect(await state?.reset()).toBe(true)
    })

    await act(async () => {
      pending.resolve(snapshot)
      await pending.promise
    })

    expect(panel.textContent).toBe('0')
  })
})
