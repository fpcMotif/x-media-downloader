import type { Settings } from '../schema'

/** Settings delta when the dedup toggle changes. Enabling also enables history
 *  (its data source); disabling leaves history untouched. */
export function dedupeToggleDelta(enabled: boolean): Partial<Settings> {
  return enabled
    ? { preventDuplicateDownloads: true, downloadHistoryEnabled: true }
    : { preventDuplicateDownloads: false }
}
