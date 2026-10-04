import * as stylex from '@stylexjs/stylex'

// Popup + options design tokens (the flat R4 "instrument" surface). Every key
// keeps its historical custom-property name (`--xmd-*` brand ramp, shadcn
// semantic bridges) so the emitted `:root` declarations are byte-for-byte the
// ones the Tailwind build produced; StyleX writes them once and the
// prefers-color-scheme block below swaps the brand ramp for dark mode. The
// cross-surface constants shared with the on-page overlay (`--xmd-ease`, the
// hue anchors) stay in src/theme/tokens.css, imported by both stylesheets.
const DARK = '@media (prefers-color-scheme: dark)'

export const tokens = stylex.defineVars({
  // Brand ramp. "Instrument, not dashboard": structure comes from hairlines,
  // not cards — the lines sit at 7-8% so a divider reads as a seam.
  '--xmd-bg': {
    default: 'oklch(0.982 0.004 var(--xmd-hue-neutral))',
    [DARK]: 'oklch(0.145 0.006 var(--xmd-hue-neutral))',
  },
  '--xmd-surface': {
    default: 'oklch(1 0 0)',
    [DARK]: 'oklch(0.19 0.008 var(--xmd-hue-neutral))',
  },
  '--xmd-surface-raised': {
    default: 'oklch(0.962 0.006 var(--xmd-hue-neutral))',
    [DARK]: 'oklch(0.24 0.01 var(--xmd-hue-neutral))',
  },
  '--xmd-ink': {
    default: 'oklch(0.205 0.012 var(--xmd-hue-neutral))',
    [DARK]: 'oklch(0.965 0.004 var(--xmd-hue-neutral))',
  },
  '--xmd-muted': {
    default: 'oklch(0.47 0.018 var(--xmd-hue-neutral))',
    [DARK]: 'oklch(0.75 0.012 var(--xmd-hue-neutral))',
  },
  '--xmd-faint': {
    default: 'oklch(0.62 0.014 var(--xmd-hue-neutral))',
    [DARK]: 'oklch(0.62 0.012 var(--xmd-hue-neutral))',
  },
  '--xmd-line': {
    default: 'oklch(0.205 0.012 var(--xmd-hue-neutral) / 0.08)',
    [DARK]: 'oklch(0.965 0.004 var(--xmd-hue-neutral) / 0.08)',
  },
  '--xmd-line-strong': {
    default: 'oklch(0.205 0.012 var(--xmd-hue-neutral) / 0.14)',
    [DARK]: 'oklch(0.965 0.004 var(--xmd-hue-neutral) / 0.14)',
  },
  '--xmd-accent': { default: 'oklch(0.5 0.176 250)', [DARK]: 'oklch(0.72 0.15 240)' },
  '--xmd-accent-hover': { default: 'oklch(0.44 0.19 250)', [DARK]: 'oklch(0.78 0.13 230)' },
  '--xmd-accent-soft': {
    default: 'oklch(0.58 0.176 250 / 0.12)',
    [DARK]: 'oklch(0.72 0.15 240 / 0.18)',
  },
  '--xmd-success': {
    default: 'oklch(0.58 0.145 var(--xmd-hue-success))',
    [DARK]: 'oklch(0.78 0.14 var(--xmd-hue-success))',
  },
  // Used bare as destructive TEXT (never a filled slab), so it clears AA on its
  // own; the dark value goes lighter for the same reason accent/success do.
  '--xmd-danger': { default: 'oklch(0.48 0.19 25)', [DARK]: 'oklch(0.7 0.17 22)' },
  '--xmd-shadow-1': {
    default: '0 1px 2px oklch(0.205 0.012 var(--xmd-hue-neutral) / 0.08)',
    [DARK]: '0 1px 2px oklch(0 0 0 / 0.24)',
  },
  '--xmd-shadow-2': {
    default: '0 8px 14px -12px oklch(0.205 0.012 var(--xmd-hue-neutral) / 0.42)',
    [DARK]: '0 8px 14px -12px oklch(0 0 0 / 0.9)',
  },
  // Concentric radii (R4 Foundations): 12 outer → 10 → 8 → 6 innermost.
  '--xmd-radius-1': '12px',
  '--xmd-radius-2': '10px',
  '--xmd-radius-3': '8px',
  '--xmd-radius-4': '6px',

  // shadcn/ui semantic tokens, bridged onto the brand ramp. Each resolves an
  // --xmd-* variable, so the dark values flow through automatically; the few
  // that differ per theme are set explicitly.
  '--radius': '0.75rem',
  // shadcn's radius-md step, referenced by the compact button/toggle/select
  // sizes as `min(var(--radius-md), Npx)`.
  '--radius-md': 'calc(var(--radius) - 2px)',
  '--background': 'var(--xmd-bg)',
  '--foreground': 'var(--xmd-ink)',
  '--card': 'var(--xmd-surface)',
  '--card-foreground': 'var(--xmd-ink)',
  '--popover': { default: 'var(--xmd-surface)', [DARK]: 'var(--xmd-surface-raised)' },
  '--popover-foreground': 'var(--xmd-ink)',
  '--primary': 'var(--xmd-accent)',
  '--primary-foreground': 'oklch(1 0 0)',
  '--secondary': 'var(--xmd-surface-raised)',
  '--secondary-foreground': 'var(--xmd-ink)',
  '--muted': 'var(--xmd-surface-raised)',
  '--muted-foreground': 'var(--xmd-muted)',
  '--accent': 'var(--xmd-surface-raised)',
  '--accent-foreground': 'var(--xmd-ink)',
  '--destructive': 'var(--xmd-danger)',
  '--destructive-foreground': 'oklch(1 0 0)',
  '--success': {
    default: 'oklch(0.46 0.14 var(--xmd-hue-success))',
    [DARK]: 'oklch(0.82 0.14 var(--xmd-hue-success))',
  },
  '--success-foreground': 'oklch(0.99 0 0)',
  '--border': 'var(--xmd-line)',
  '--input': 'var(--xmd-line-strong)',
  '--ring': 'var(--xmd-accent)',
  '--chart-1': 'var(--xmd-accent)',
  '--chart-2': 'var(--xmd-success)',
  '--chart-3': 'oklch(0.65 0.16 205)',
  '--chart-4': 'var(--xmd-danger)',
  '--chart-5': 'var(--xmd-faint)',
  '--sidebar': 'var(--xmd-surface)',
  '--sidebar-foreground': 'var(--xmd-ink)',
  '--sidebar-primary': 'var(--xmd-accent)',
  '--sidebar-primary-foreground': 'oklch(1 0 0)',
  '--sidebar-accent': 'var(--xmd-surface-raised)',
  '--sidebar-accent-foreground': 'var(--xmd-ink)',
  '--sidebar-border': 'var(--xmd-line)',
  '--sidebar-ring': 'var(--xmd-accent)',

  // Tailwind's theme layer: the font stacks the preflight reset resolves.
  '--font-sans':
    'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"',
  '--font-mono':
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  '--default-font-family': 'var(--font-sans)',
  '--default-mono-font-family': 'var(--font-mono)',
  // Tailwind's text-size line-heights, kept as the same `calc()` fractions
  // behind custom properties: written straight into a `line-height`
  // declaration, lightningcss folds `calc(1.25 / 0.875)` to `1.42857`, which
  // lays out a hair shorter than the browser's own exact division.
  '--text-xs--line-height': 'calc(1 / 0.75)',
  '--text-sm--line-height': 'calc(1.25 / 0.875)',
  '--text-base--line-height': 'calc(1.5 / 1)',
  '--text-xl--line-height': 'calc(1.75 / 1.25)',
  '--text-2xl--line-height': 'calc(2 / 1.5)',
})
