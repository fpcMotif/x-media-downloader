import type { JSX } from 'preact'
import * as stylex from '@stylexjs/stylex'
import type { StyleXStyles } from '@stylexjs/stylex'
import { badgeSvg, svgHost, svgSize3, svgSize35, svgSize4 } from '@/theme/markers.stylex'

// Inline Lucide-style icons as Preact components. Authored locally (not
// lucide-react) so they typecheck cleanly under preact/compat +
// exactOptionalPropertyTypes outside the vendored, @ts-nocheck'd ui/ files.
// Size via `sx` (e.g. `sx={iconSize.s35}`); the 18px attribute is a fallback.
//
// R4 ("instrument, not dashboard") drops icon tiles from the popup and
// settings sidebar/section headers entirely — structure comes from hairlines
// and type, not iconography. Only glyphs still doing functional work on a
// button or badge belong here; keep this list to that set.
type IconProps = Omit<JSX.SVGAttributes<SVGSVGElement>, 'className' | 'class'> & {
  readonly sx?: StyleXStyles
}

const ANY = ':is(*)'

const styles = stylex.create({
  // The vendored shadcn descendant rules, read back from the ancestor markers
  // (src/theme/markers.stylex.ts): an svg inside a Button/Toggle/Select part is
  // inert, never shrinks, and takes the part's size unless the call site sizes
  // it explicitly (`sx` comes last, so it replaces these width/height rules
  // wholesale — the `svg:not([class*='size-'])` opt-out).
  base: {
    pointerEvents: {
      default: null,
      [stylex.when.ancestor(ANY, svgHost)]: 'none',
      [stylex.when.ancestor(ANY, badgeSvg)]: 'none',
    },
    flexShrink: { default: null, [stylex.when.ancestor(ANY, svgHost)]: 0 },
    width: {
      default: null,
      [stylex.when.ancestor(ANY, svgSize4)]: '1rem',
      [stylex.when.ancestor(ANY, svgSize35)]: '0.875rem',
      [stylex.when.ancestor(ANY, svgSize3)]: '0.75rem',
      [stylex.when.ancestor(ANY, badgeSvg)]: '0.75rem',
    },
    height: {
      default: null,
      [stylex.when.ancestor(ANY, svgSize4)]: '1rem',
      [stylex.when.ancestor(ANY, svgSize35)]: '0.875rem',
      [stylex.when.ancestor(ANY, svgSize3)]: '0.75rem',
      [stylex.when.ancestor(ANY, badgeSvg)]: '0.75rem',
    },
  },
})

/** Explicit icon sizes (Tailwind's `size-3` / `size-3.5` / `size-4`). */
export const iconSize = stylex.create({
  s3: { width: '0.75rem', height: '0.75rem' },
  s35: { width: '0.875rem', height: '0.875rem' },
  s4: { width: '1rem', height: '1rem' },
})

/** `pointer-events-none` for an icon placed outside a marked host. */
export const iconInert = stylex.create({
  pointerEventsNone: { pointerEvents: 'none' },
})

const base = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 2,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
} as const

export function EraserIcon({ sx, ...props }: IconProps) {
  return (
    <svg {...base} {...stylex.props(styles.base, sx)} {...props}>
      <path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l9.6-9.6a2 2 0 0 1 2.8 0l4.6 4.6a2 2 0 0 1 0 2.8L13 21" />
      <path d="M22 21H7" />
      <path d="m5 11 9 9" />
    </svg>
  )
}

export function LayersIcon({ sx, ...props }: IconProps) {
  return (
    <svg {...base} {...stylex.props(styles.base, sx)} {...props}>
      <path d="M12 2 2 7l10 5 10-5-10-5Z" />
      <path d="m2 17 10 5 10-5" />
      <path d="m2 12 10 5 10-5" />
    </svg>
  )
}

export function CheckIcon({ sx, ...props }: IconProps) {
  return (
    <svg {...base} {...stylex.props(styles.base, sx)} {...props}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

export function ChevronDownIcon({ sx, ...props }: IconProps) {
  return (
    <svg {...base} {...stylex.props(styles.base, sx)} {...props}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

export function ChevronUpIcon({ sx, ...props }: IconProps) {
  return (
    <svg {...base} {...stylex.props(styles.base, sx)} {...props}>
      <path d="m18 15-6-6-6 6" />
    </svg>
  )
}
