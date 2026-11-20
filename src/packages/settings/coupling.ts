import type { Settings } from '@/packages/schema'

/** Settings delta when the dedup toggle changes. Enabling also enables history
 *  (its data source); disabling leaves history untouched. */
export function dedupeToggleDelta(enabled: boolean): Partial<Settings> {
  return enabled
    ? { preventDuplicateDownloads: true, downloadHistoryEnabled: true }
    : { preventDuplicateDownloads: false }
}

/** Returns true when the Convex-relayed Drive upload can receive bytes: the
 *  relay is on and connected, Drive upload is on, and the deployment URL and
 *  sync secret are both set. */
export function hasLiveConvexDrive(settings: Settings): boolean {
  return (
    settings.convexDriveEnabled &&
    settings.convexDriveConnected &&
    settings.gdriveUploadEnabled &&
    settings.convexUrl !== '' &&
    settings.convexSyncSecret !== ''
  )
}

/** True when Cloud upload can actually receive bytes: master on, and at least
 *  one Cloud Provider both connected (client id + refresh token) and not paused. */
export function hasLiveCloudDestination(settings: Settings): boolean {
  if (!settings.cloudUploadEnabled) return false
  const hasConvex = hasLiveConvexDrive(settings)
  const gdrive =
    settings.gdriveClientId !== '' &&
    settings.gdriveRefreshToken !== '' &&
    settings.gdriveUploadEnabled
  const dropbox =
    settings.dropboxClientId !== '' &&
    settings.dropboxRefreshToken !== '' &&
    settings.dropboxUploadEnabled
  return hasConvex || gdrive || dropbox
}

/** Settings delta when Save to this computer changes. Cloud-only (`false`) is
 *  refused unless Cloud upload has a live destination; otherwise the switch
 *  stays on so a grab always has somewhere to put bytes. */
export function saveToDiskToggleDelta(enabled: boolean, settings: Settings): Partial<Settings> {
  if (enabled) return { saveToDisk: true }
  if (settings.convexDriveEnabled || hasLiveCloudDestination(settings)) return { saveToDisk: false }
  return { saveToDisk: true }
}

/** Settings delta after Cloud upload, Connect, or a per-provider pause changes.
 *  Cloud-only without a live destination is forced back to local save. */
export function destinationLostDelta(settings: Settings): Partial<Settings> {
  if (settings.convexDriveEnabled || settings.saveToDisk || hasLiveCloudDestination(settings))
    return {}
  return { saveToDisk: true }
}
