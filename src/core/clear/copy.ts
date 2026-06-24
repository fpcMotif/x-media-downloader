/**
 * Shared user-facing copy for the "Clear after download" toggle. The popup
 * (action surface) and the options Worklist panel (config surface) both render
 * this same setting; keeping the label + description here is the single source of
 * truth so the two surfaces describe the irreversible clear identically.
 */
export const CLEAR_AFTER_DOWNLOAD = {
  label: 'Clear after download',
  description: 'Remove each saved post from its list once its media truly lands.',
} as const
