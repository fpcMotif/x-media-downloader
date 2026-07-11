import { CURRENT_DEFAULT_TEMPLATE } from '../schema'

/**
 * Every `filenameTemplate` default this project has ever shipped, in
 * chronological order, EXCLUDING the current default (migrating the current
 * default to itself would be a no-op, so it doesn't belong on the "legacy"
 * list). Each entry is doc-commented with the commit that shipped it so a
 * future default change has an obvious place to append the outgoing value.
 *
 * - `{handle}/{tweetId}_{index}.{ext}` — shipped in `1fe8076`
 *   (2026-06-07, "feat(schema): Effect v4 MediaItem, Settings"), the
 *   project's very first schema default. Superseded by the `{platform}`
 *   default below.
 *
 * (The current default, `{platform}/{tweetId}_{index}.{ext}`, shipped in
 * `db90a35` (2026-07-05, PR #32) — see `CURRENT_DEFAULT_TEMPLATE` in
 * `core/schema/index.ts`.)
 */
export const LEGACY_DEFAULT_TEMPLATES: readonly string[] = ['{handle}/{tweetId}_{index}.{ext}']

/**
 * Pure normalization for a persisted `filenameTemplate`: if the stored string
 * EXACTLY equals a historical default (see {@link LEGACY_DEFAULT_TEMPLATES}),
 * heal it to {@link CURRENT_DEFAULT_TEMPLATE}. Anything else — including the
 * current default itself, an empty string, garbage, or a template that only
 * partially resembles a legacy default — is a deliberate user value (or the
 * schema's own fallback) and passes through untouched.
 *
 * No version counter: this runs on every load, so it's idempotent by
 * construction — once migrated, the value equals the current default, which
 * is not in the legacy list, so a second pass is a no-op.
 */
export function normalizeFilenameTemplate(stored: string): string {
  return LEGACY_DEFAULT_TEMPLATES.includes(stored) ? CURRENT_DEFAULT_TEMPLATE : stored
}
