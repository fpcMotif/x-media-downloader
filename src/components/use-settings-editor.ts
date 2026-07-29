import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { getSettings, watchSettings } from '@/core/settings'
import { updateSettings } from '@/core/settings/client'
import type { Settings, SettingsUiPatch } from '@/core/schema'

export type SettingsLoad =
  | { readonly status: 'loading'; readonly settings: null }
  | { readonly status: 'ready'; readonly settings: Settings }
  | { readonly status: 'unavailable'; readonly settings: null }

export type SettingsNotice = 'idle' | 'saved' | 'failed'

export interface SettingsEditorDeps {
  readonly read?: () => Promise<Settings>
  readonly write?: (patch: SettingsUiPatch) => Promise<Settings>
  /** Storage changes are wakes, not ordered snapshots. The editor re-reads the
   * sole Settings authority before publishing UI state. */
  readonly subscribe?: (onChange: () => void) => () => void
  readonly successMs: number
}

export interface SettingsEditor {
  readonly load: SettingsLoad
  readonly notice: SettingsNotice
  readonly update: (patch: SettingsUiPatch, isCurrent?: () => boolean) => Promise<void>
  readonly reload: () => Promise<void>
}

/** One UI-owned settings state machine: bootstrap, retry, writes, and notice expiry. */
export function useSettingsEditor({
  read = getSettings,
  write = updateSettings,
  subscribe = watchSettings,
  successMs,
}: SettingsEditorDeps): SettingsEditor {
  const [load, setLoad] = useState<SettingsLoad>({ status: 'loading', settings: null })
  const [notice, setNotice] = useState<SettingsNotice>('idle')
  const mounted = useRef(true)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Every canonical publication invalidates pending writes and reloads. Storage
  // callbacks are unordered, so one authority epoch guards all UI publishers.
  const authorityEpoch = useRef(0)

  const clearNoticeTimer = (): void => {
    if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current)
    noticeTimer.current = undefined
  }

  const reload = useCallback(async (): Promise<void> => {
    if (!mounted.current) return
    const epoch = ++authorityEpoch.current
    clearNoticeTimer()
    setNotice('idle')
    setLoad({ status: 'loading', settings: null })
    try {
      const settings = await read()
      if (mounted.current && authorityEpoch.current === epoch) {
        setLoad({ status: 'ready', settings })
      }
    } catch {
      if (mounted.current && authorityEpoch.current === epoch) {
        setLoad({ status: 'unavailable', settings: null })
      }
    }
  }, [read])

  const update = async (
    patch: SettingsUiPatch,
    isCurrent: () => boolean = () => true,
  ): Promise<void> => {
    if (!isCurrent()) return
    const epoch = ++authorityEpoch.current
    clearNoticeTimer()
    setNotice('idle')
    try {
      const settings = await write(patch)
      if (!mounted.current || authorityEpoch.current !== epoch || !isCurrent()) return
      setLoad({ status: 'ready', settings })
      setNotice('saved')
      noticeTimer.current = setTimeout(() => {
        if (mounted.current && authorityEpoch.current === epoch) setNotice('idle')
      }, successMs)
    } catch {
      if (!mounted.current || authorityEpoch.current !== epoch || !isCurrent()) return
      setNotice('failed')
      try {
        const settings = await read()
        if (mounted.current && authorityEpoch.current === epoch && isCurrent())
          setLoad({ status: 'ready', settings })
      } catch {
        if (mounted.current && authorityEpoch.current === epoch && isCurrent())
          setLoad({ status: 'unavailable', settings: null })
      }
    }
  }

  useEffect(() => {
    mounted.current = true
    const publishCanonical = async (): Promise<void> => {
      if (!mounted.current) return
      const epoch = ++authorityEpoch.current
      clearNoticeTimer()
      setNotice('idle')
      try {
        const settings = await read()
        if (mounted.current && authorityEpoch.current === epoch)
          setLoad({ status: 'ready', settings })
      } catch {
        if (mounted.current && authorityEpoch.current === epoch)
          setLoad({ status: 'unavailable', settings: null })
      }
    }
    const unwatch = subscribe(() => {
      void publishCanonical()
    })
    void reload()
    return () => {
      mounted.current = false
      unwatch()
      clearNoticeTimer()
    }
  }, [read, reload, subscribe])

  return { load, notice, update, reload }
}
