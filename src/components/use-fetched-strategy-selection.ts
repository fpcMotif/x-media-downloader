import { useCallback, useRef } from 'preact/hooks'
import type { Settings, SettingsUiPatch } from '@/core/schema'
import { requestFetchedAccess } from '@/core/download/fetched-strategy'
import { useAsyncAuthority } from './use-async-authority'

type SettingsUpdate = (patch: SettingsUiPatch, isCurrent?: () => boolean) => Promise<void>

/** One UI policy for gesture-bound Fetched access: latest intent, live view only. */
export function useFetchedStrategySelection(
  update: SettingsUpdate,
  setNotice: (notice: string | null) => void,
): (value: Settings['downloadStrategy']) => void {
  const intent = useRef(0)
  const authority = useAsyncAuthority()

  return useCallback(
    (value: Settings['downloadStrategy']): void => {
      const currentIntent = ++intent.current
      const epoch = authority.begin()
      const isCurrent = (): boolean =>
        currentIntent === intent.current && authority.isCurrent(epoch)

      if (value !== 'fetched') {
        setNotice(null)
        void update({ downloadStrategy: value }, isCurrent)
        return
      }

      void (async () => {
        try {
          if (!(await requestFetchedAccess(browser.permissions))) {
            if (isCurrent()) setNotice('Fetched access was denied.')
            return
          }
        } catch {
          if (isCurrent()) setNotice('Could not request Fetched access.')
          return
        }
        if (!isCurrent()) return
        setNotice(null)
        await update({ downloadStrategy: 'fetched' }, isCurrent)
      })()
    },
    [authority, setNotice, update],
  )
}
