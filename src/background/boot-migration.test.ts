import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const backgroundSource = readFileSync(
  fileURLToPath(import.meta.resolve('../entrypoints/background.ts')),
  'utf8',
)

describe('background boot migration order', () => {
  it('runs migrateSettingsSecrets once via bootMigration before settingsCache.get() in boot log and cloud sync', () => {
    const defineIdx = backgroundSource.indexOf('export default defineBackground(() => {')
    const bootSection = backgroundSource.slice(defineIdx)
    const migrationIdx = bootSection.indexOf(
      'const bootMigration = migrateSettingsSecrets().then((migrated) => {',
    )
    const invalidateIdx = bootSection.indexOf(
      'if (migrated) settingsCache.invalidate()',
      migrationIdx,
    )
    const bootLogIdx = bootSection.indexOf(
      'void bootMigration\n    .then(() => settingsCache.get())',
      invalidateIdx,
    )
    const awaitBootIdx = bootSection.indexOf('await bootMigration', bootLogIdx)
    const syncGetIdx = bootSection.indexOf('let s = await settingsCache.get()', awaitBootIdx)
    const watchIdx = bootSection.indexOf('watchSettings((s) => {', syncGetIdx)

    expect(defineIdx).toBeGreaterThan(-1)
    expect(migrationIdx).toBeGreaterThan(-1)
    expect(invalidateIdx).toBeGreaterThan(migrationIdx)
    expect(bootLogIdx).toBeGreaterThan(invalidateIdx)
    expect(awaitBootIdx).toBeGreaterThan(bootLogIdx)
    expect(syncGetIdx).toBeGreaterThan(awaitBootIdx)
    expect(watchIdx).toBeGreaterThan(syncGetIdx)
    expect(backgroundSource.match(/migrateSettingsSecrets/g)).toHaveLength(2)
  })
})
