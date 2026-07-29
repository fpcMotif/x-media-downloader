import { describe, it, expect } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import { LEGACY_DEFAULT_TEMPLATES, normalizeFilenameTemplate } from './template-migration'
import { CURRENT_DEFAULT_TEMPLATE } from '../schema'
import { getSettings } from './index'

describe('LEGACY_DEFAULT_TEMPLATES', () => {
  it('lists exactly the two historical defaults, oldest first', () => {
    // 1fe8076 (2026-06-07): initial Effect v4 schema — {handle} token.
    // db90a35 (2026-07-05, PR #32): switched to {platform} token (the CURRENT default).
    expect(LEGACY_DEFAULT_TEMPLATES).toEqual(['{handle}/{tweetId}_{index}.{ext}'])
  })

  it('does not include the current default (that would be a no-op migration, not legacy)', () => {
    expect(LEGACY_DEFAULT_TEMPLATES).not.toContain(CURRENT_DEFAULT_TEMPLATE)
  })
})

describe('normalizeFilenameTemplate', () => {
  it.each(LEGACY_DEFAULT_TEMPLATES)(
    'migrates legacy default %s to the current default',
    (legacy) => {
      expect(normalizeFilenameTemplate(legacy)).toBe(CURRENT_DEFAULT_TEMPLATE)
    },
  )

  it('leaves the current default unchanged', () => {
    expect(normalizeFilenameTemplate(CURRENT_DEFAULT_TEMPLATE)).toBe(CURRENT_DEFAULT_TEMPLATE)
  })

  it('leaves a user-customized template untouched, verbatim', () => {
    const custom = 'mystuff/{handle}/{date}-{id}'
    expect(normalizeFilenameTemplate(custom)).toBe(custom)
  })

  it('leaves a template that is a near-miss of a legacy default untouched (exact match only)', () => {
    const nearMiss = '{handle}/{tweetId}_{index}.{ext} '
    expect(normalizeFilenameTemplate(nearMiss)).toBe(nearMiss)
  })

  it('is idempotent — migrating twice is the same as migrating once', () => {
    for (const legacy of LEGACY_DEFAULT_TEMPLATES) {
      const once = normalizeFilenameTemplate(legacy)
      expect(normalizeFilenameTemplate(once)).toBe(once)
    }
  })

  it('passes empty string through unchanged (schema default-key only fires on undefined, not on an empty string already present)', () => {
    expect(normalizeFilenameTemplate('')).toBe('')
  })

  it('passes garbage strings through unchanged', () => {
    expect(normalizeFilenameTemplate('!!not a template!!')).toBe('!!not a template!!')
  })
})

describe('Settings persistence projection migration', () => {
  it('migrates a stored legacy {handle} template to {platform} on load', async () => {
    await fakeBrowser.storage.local.set({
      settings: { filenameTemplate: '{handle}/{tweetId}_{index}.{ext}' },
    })
    const s = await getSettings()
    expect(s.filenameTemplate).toBe(CURRENT_DEFAULT_TEMPLATE)
  })

  it('leaves a stored custom template untouched through the service', async () => {
    const custom = 'archive/{author}/{postId}-{index}.{ext}'
    await fakeBrowser.storage.local.set({ settings: { filenameTemplate: custom } })
    const s = await getSettings()
    expect(s.filenameTemplate).toBe(custom)
  })

  it('does not mutate the stored legacy value while reading', async () => {
    await fakeBrowser.storage.local.set({
      settings: { filenameTemplate: '{handle}/{tweetId}_{index}.{ext}' },
    })
    await getSettings()
    const raw = (await fakeBrowser.storage.local.get('settings')) as {
      settings?: { filenameTemplate?: string }
    }
    expect(raw.settings?.filenameTemplate).toBe('{handle}/{tweetId}_{index}.{ext}')
  })
})
