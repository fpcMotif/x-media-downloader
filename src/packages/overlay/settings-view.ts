import type { Settings } from '@/packages/schema'

export const OVERLAY_SETTINGS_FIELDS = [
  'quickGrabEnabled',
  'quickGrabModifier',
  'downloadBadgeEnabled',
  'downloadDockEnabled',
  'dockGlassEnabled',
  'autoRevealSensitiveEnabled',
  'clearOnSave',
  'autoNotInterestedOnSave',
  'showSavedStatus',
  'releaseMutationDiagnosticsEnabled',
  'captureEnabled',
  'captureAllScrolled',
  'autoUnbookmarkOnSave',
  'autoUnlikeOnSave',
  'downloadStrategy',
] as const satisfies ReadonlyArray<keyof Settings>

export type OverlaySettings = Pick<Settings, (typeof OVERLAY_SETTINGS_FIELDS)[number]>

export const sameOverlaySettings = (a: OverlaySettings, b: OverlaySettings): boolean =>
  OVERLAY_SETTINGS_FIELDS.every((field) => a[field] === b[field])
