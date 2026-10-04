// @ts-nocheck — vendored shadcn/ui, authored for React. This repo runs Preact
// via preact/compat with exactOptionalPropertyTypes; the {...props} spreads onto
// Base UI primitives do not satisfy it. Checked at call sites instead.
'use client'

import * as React from 'react'
import * as stylex from '@stylexjs/stylex'
import type { StyleXStyles } from '@stylexjs/stylex'
import { Toggle as TogglePrimitive } from '@base-ui/react/toggle'
import { tokens } from '@/theme/tokens.stylex'
import { svgHost, svgSize35, svgSize4 } from '@/theme/markers.stylex'

const HOVER = '@media (hover: hover)'
const DARK = '@media (prefers-color-scheme: dark)'

// Base UI marks the on-state with `data-pressed` (plus `aria-pressed`), replacing
// Radix's `data-[state=on]`. Both attributes always co-occur, so every rule that
// distinguished aria-pressed: from data-pressed: in the Tailwind source (same
// color, same on/off timing) collapses to a single `[data-pressed]` key here
// with no computed-style difference; `data-pressed:font-semibold` (no
// aria-pressed equivalent existed) folds into the same key.
const base = stylex.create({
  root: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.25rem',
    borderRadius: tokens['--radius'],
    fontSize: '0.875rem',
    lineHeight: tokens['--text-sm--line-height'],
    fontWeight: { default: 500, '[data-pressed]': 600 },
    whiteSpace: 'nowrap',
    transitionProperty: 'color, background-color, border-color, box-shadow, transform',
    transitionDuration: '0.15s',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    outlineStyle: 'none',
    backgroundColor: {
      default: null,
      [HOVER]: { ':hover': tokens['--muted'] },
      '[data-pressed]': 'color-mix(in oklab, var(--primary) 10%, transparent)',
    },
    color: {
      default: null,
      [HOVER]: { ':hover': tokens['--foreground'] },
      '[data-pressed]': tokens['--primary'],
    },
    borderColor: {
      default: null,
      ':focus-visible': tokens['--ring'],
      '[aria-invalid="true"]': tokens['--destructive'],
    },
    // aria-invalid:ring-destructive/20 only sets the ring's color, not its
    // width — Tailwind's own cascade only shows this ring while focus-visible
    // also matches (focus-visible:ring-[3px] is the only rule that sets a
    // non-zero ring width here), hence the compound key rather than a plain
    // '[aria-invalid="true"]' one (that would show a ring while unfocused).
    boxShadow: {
      default: null,
      ':focus-visible':
        '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent), 0 0 #0000',
      ':focus-visible[aria-invalid="true"]':
        '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--destructive) 20%, transparent), 0 0 #0000',
      [DARK]: {
        default: null,
        ':focus-visible[aria-invalid="true"]':
          '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--destructive) 40%, transparent), 0 0 #0000',
      },
    },
    pointerEvents: { default: null, ':disabled': 'none' },
    opacity: { default: null, ':disabled': 0.5 },
    scale: { default: null, ':active': 0.97 },
  },
})

const variant = stylex.create({
  default: {},
  outline: {
    borderStyle: 'solid',
    borderWidth: '1px',
    borderColor: {
      default: tokens['--input'],
      ':focus-visible': tokens['--ring'],
      '[aria-invalid="true"]': tokens['--destructive'],
    },
  },
})

const size = stylex.create({
  default: {
    height: '2rem',
    minWidth: '2rem',
    paddingInline: '0.625rem',
    paddingRight: { default: null, ':has([data-icon="inline-end"])': '0.5rem' },
    paddingLeft: { default: null, ':has([data-icon="inline-start"])': '0.5rem' },
  },
  sm: {
    height: '1.75rem',
    minWidth: '1.75rem',
    borderRadius: 'min(var(--radius-md), 12px)',
    paddingInline: '0.625rem',
    fontSize: '0.8rem',
    lineHeight: null,
    paddingRight: { default: null, ':has([data-icon="inline-end"])': '0.375rem' },
    paddingLeft: { default: null, ':has([data-icon="inline-start"])': '0.375rem' },
  },
  lg: {
    height: '2.25rem',
    minWidth: '2.25rem',
    paddingInline: '0.625rem',
    paddingRight: { default: null, ':has([data-icon="inline-end"])': '0.5rem' },
    paddingLeft: { default: null, ':has([data-icon="inline-start"])': '0.5rem' },
  },
})

type ToggleSize = 'default' | 'sm' | 'lg'
type ToggleVariant = 'default' | 'outline'

// [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-N
const svgMarkerBySize: Record<ToggleSize, StyleXStyles> = {
  default: svgSize4,
  lg: svgSize4,
  sm: svgSize35,
}

/** Exported so toggle-group.tsx (owns the same variant/size shape) doesn't redeclare these. */
export const toggleStyles = { base, variant, size, svgHost, svgMarkerBySize }

function Toggle({
  variant: variantProp = 'default',
  size: sizeProp = 'default',
  sx,
  ...props
}: React.ComponentProps<typeof TogglePrimitive> & {
  variant?: ToggleVariant
  size?: ToggleSize
  sx?: StyleXStyles | ReadonlyArray<StyleXStyles | false | null | undefined>
}) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      {...stylex.props(
        base.root,
        variant[variantProp],
        size[sizeProp],
        svgHost,
        svgMarkerBySize[sizeProp],
        sx,
      )}
      {...props}
    />
  )
}

export { Toggle }
