import { useCallback, useEffect, useMemo, useRef } from 'preact/hooks'

/** A UI-owned lifetime plus epoch. Only the latest issued operation may publish. */
export interface AsyncAuthority {
  readonly begin: () => number
  readonly invalidate: () => void
  readonly isCurrent: (epoch: number) => boolean
  readonly isMounted: () => boolean
}

export function useAsyncAuthority(): AsyncAuthority {
  const mounted = useRef(true)
  const epoch = useRef(0)

  useEffect(
    () => () => {
      mounted.current = false
      epoch.current += 1
    },
    [],
  )

  const begin = useCallback((): number => ++epoch.current, [])
  const invalidate = useCallback((): void => {
    epoch.current += 1
  }, [])
  const isCurrent = useCallback(
    (candidate: number): boolean => mounted.current && epoch.current === candidate,
    [],
  )
  const isMounted = useCallback((): boolean => mounted.current, [])

  return useMemo(
    () => ({ begin, invalidate, isCurrent, isMounted }),
    [begin, invalidate, isCurrent, isMounted],
  )
}
