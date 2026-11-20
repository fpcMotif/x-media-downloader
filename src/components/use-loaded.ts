import { useEffect, useState } from 'preact/hooks'

export type Loaded<T> =
  | { readonly _tag: 'Loading' }
  | { readonly _tag: 'Ready'; readonly value: T }
  | { readonly _tag: 'Failed' }

export interface LoadedHandle<T> {
  readonly state: Loaded<T>
  readonly reload: () => void
  readonly setValue: (value: T) => void
}

export const runLoad = async <T>(
  load: () => Promise<T>,
  isActive: () => boolean,
  report: (state: Loaded<T>) => void,
): Promise<void> => {
  try {
    const value = await load()
    if (isActive()) report({ _tag: 'Ready', value })
  } catch {
    if (isActive()) report({ _tag: 'Failed' })
  }
}

export const readyOr = <T>(state: Loaded<T>, fallback: T): T =>
  state._tag === 'Ready' ? state.value : fallback

export function useLoaded<T>(stableLoad: () => Promise<T>): LoadedHandle<T> {
  const [state, setState] = useState<Loaded<T>>({ _tag: 'Loading' })
  const [reloadCount, setReloadCount] = useState(0)
  useEffect(() => {
    let active = true
    void runLoad(stableLoad, () => active, setState)
    return () => {
      active = false
    }
  }, [stableLoad, reloadCount])
  return {
    state,
    reload: () => setReloadCount((n) => n + 1),
    setValue: (value) => setState({ _tag: 'Ready', value }),
  }
}
