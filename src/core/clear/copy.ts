/**
 * Shared user-facing copy for the "Release after download" toggle (Tier-2
 * verb — the only account-mutating action). The popup (action surface) and
 * the options Release panel (config surface) both render this same setting;
 * keeping the label + description here is the single source of truth so the
 * two surfaces describe the irreversible release identically. Const name +
 * module path are unchanged across the verb-system rename (2026-07-11 Stage
 * redesign) — only the string values moved from "Clear" to "Release".
 */
export const CLEAR_AFTER_DOWNLOAD = {
  label: 'Release after download',
  description: 'Remove each saved post from its list once its media truly lands.',
} as const
