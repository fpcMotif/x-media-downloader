import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { MetricsSnapshot } from '@/core/schema/download'
import { didClearMonitor, monitorSnapshotFromReply } from './monitor-client'

const POLL_ACTIVE_MS = 1000
const POLL_IDLE_MS = 3000

const readMonitor = (): Promise<unknown> => browser.runtime.sendMessage({ _tag: 'MetricsRequest' })
const clearMonitor = (): Promise<unknown> =>
  browser.runtime.sendMessage({ _tag: 'ClearDownloadMonitorRequest' })

export interface DownloadMonitorState {
  readonly metrics: MetricsSnapshot | null
  readonly reset: () => Promise<boolean>
}

/** One owner for poll cadence, stale-reply rejection, and confirmed reset. */
export function useDownloadMonitor(
  read: () => Promise<unknown> = readMonitor,
  clear: () => Promise<unknown> = clearMonitor,
): DownloadMonitorState {
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null)
  const mounted = useRef(true)
  const epoch = useRef(0)

  const reset = useCallback(async (): Promise<boolean> => {
    try {
      const reply = await clear()
      if (!mounted.current || !didClearMonitor(reply)) return false
      epoch.current += 1
      setMetrics(null)
      return true
    } catch {
      return false
    }
  }, [clear])

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async (): Promise<void> => {
      const pollEpoch = epoch.current
      let delay = POLL_IDLE_MS
      try {
        const reply = await read()
        if (!cancelled && epoch.current === pollEpoch) {
          const snapshot = monitorSnapshotFromReply(reply)
          setMetrics(snapshot)
          if (snapshot !== null && snapshot.total > 0) delay = POLL_ACTIVE_MS
        }
      } catch {
        // The next idle poll is the retry.
      }
      if (!cancelled) timer = setTimeout(() => void poll(), delay)
    }

    void poll()
    return () => {
      cancelled = true
      mounted.current = false
      epoch.current += 1
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [read])

  return { metrics, reset }
}
