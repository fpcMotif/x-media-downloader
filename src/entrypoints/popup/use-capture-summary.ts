import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { fetchCaptureSummary, type CaptureSummaryResult } from '@/components/capture-export'

const EMPTY_CAPTURE_SUMMARY: CaptureSummaryResult = {
  status: 'available',
  summary: { tweets: 0, conversations: 0, recent: [] },
}

const readPopupSummary = (): Promise<CaptureSummaryResult> => fetchCaptureSummary(3)

export interface CaptureSummaryState {
  readonly result: CaptureSummaryResult | null
  /** Invalidates any older load before publishing the confirmed empty state. */
  readonly clear: () => void
}

/** Owns the popup summary's load/erase epoch so stale replies cannot repaint it. */
export function useCaptureSummary(
  read: () => Promise<CaptureSummaryResult> = readPopupSummary,
): CaptureSummaryState {
  const [result, setResult] = useState<CaptureSummaryResult | null>(null)
  const mounted = useRef(true)
  const epoch = useRef(0)

  const clear = useCallback((): void => {
    epoch.current += 1
    if (mounted.current) setResult(EMPTY_CAPTURE_SUMMARY)
  }, [])

  useEffect(() => {
    mounted.current = true
    const loadEpoch = ++epoch.current
    void (async () => {
      try {
        const next = await read()
        if (mounted.current && epoch.current === loadEpoch) setResult(next)
      } catch {
        if (mounted.current && epoch.current === loadEpoch) setResult({ status: 'unavailable' })
      }
    })()
    return () => {
      mounted.current = false
      epoch.current += 1
    }
  }, [read])

  return { result, clear }
}
