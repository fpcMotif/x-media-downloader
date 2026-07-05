import type { JSX } from 'preact'

// Inline Lucide-style icons as Preact components. Authored locally (not
// lucide-react) so they typecheck cleanly under preact/compat +
// exactOptionalPropertyTypes outside the vendored, @ts-nocheck'd ui/ files.
// Size via a `className` (e.g. `size-[18px]`); the 18px attribute is a fallback.
//
// R4 ("instrument, not dashboard") drops icon tiles from the popup and
// settings sidebar/section headers entirely — structure comes from hairlines
// and type, not iconography. Only glyphs still doing functional work on a
// button or badge belong here; keep this list to that set.
type IconProps = JSX.SVGAttributes<SVGSVGElement>

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

export function DownloadIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  )
}

export function EraserIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l9.6-9.6a2 2 0 0 1 2.8 0l4.6 4.6a2 2 0 0 1 0 2.8L13 21" />
      <path d="M22 21H7" />
      <path d="m5 11 9 9" />
    </svg>
  )
}

export function LayersIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 2 2 7l10 5 10-5-10-5Z" />
      <path d="m2 17 10 5 10-5" />
      <path d="m2 12 10 5 10-5" />
    </svg>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}
