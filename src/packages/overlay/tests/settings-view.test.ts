import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { Settings } from '@/packages/schema'
import {
  OVERLAY_SETTINGS_FIELDS,
  sameOverlaySettings,
  type OverlaySettings,
} from '../settings-view'

const base = {
  quickGrabEnabled: true,
  quickGrabModifier: 'alt',
  downloadBadgeEnabled: true,
  downloadDockEnabled: true,
  dockGlassEnabled: true,
  autoRevealSensitiveEnabled: false,
  clearOnSave: false,
  autoNotInterestedOnSave: true,
  showSavedStatus: true,
  releaseMutationDiagnosticsEnabled: false,
  captureEnabled: false,
  captureAllScrolled: false,
  autoUnbookmarkOnSave: true,
  autoUnlikeOnSave: true,
  downloadStrategy: 'direct',
} satisfies OverlaySettings

const flipOverlayField = (
  target: OverlaySettings,
  field: (typeof OVERLAY_SETTINGS_FIELDS)[number],
): OverlaySettings => {
  switch (field) {
    case 'quickGrabModifier':
      return { ...target, quickGrabModifier: 'shift' }
    case 'downloadStrategy':
      return { ...target, downloadStrategy: 'aria2' }
    default:
      return { ...target, [field]: !target[field] }
  }
}

describe('sameOverlaySettings', () => {
  it('returns true when all 15 overlay fields match', () => {
    expect(sameOverlaySettings(base, { ...base })).toBe(true)
  })

  it('returns false when any single overlay field changes', () => {
    expect(OVERLAY_SETTINGS_FIELDS).toHaveLength(15)
    for (const field of OVERLAY_SETTINGS_FIELDS) {
      expect(sameOverlaySettings(base, flipOverlayField(base, field))).toBe(false)
    }
  })

  it('ignores non-overlay fields on full Settings objects', () => {
    const first = Schema.decodeUnknownSync(Settings)({})
    const second = {
      ...Schema.decodeUnknownSync(Settings)({}),
      gdriveAccessToken: 'test-token',
      gdriveTokenExpiry: 1_700_000_000_000,
    } satisfies Settings
    expect(sameOverlaySettings(first, second)).toBe(true)
  })
})
