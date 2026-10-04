// @ts-nocheck — vendored shadcn/ui, authored for React. This repo runs Preact
// via preact/compat with exactOptionalPropertyTypes; the {...props} spreads onto
// Base UI primitives do not satisfy it. Checked at call sites instead.
import * as React from 'react'
import * as stylex from '@stylexjs/stylex'
import type { StyleXStyles } from '@stylexjs/stylex'
import { useRender } from '@base-ui/react/use-render'
import { tokens } from '@/theme/tokens.stylex'
import { svgHost, svgSize3, svgSize35, svgSize4 } from '@/theme/markers.stylex'

const HOVER = '@media (hover: hover)'
const DARK = '@media (prefers-color-scheme: dark)'

// data-slot="button" carries an unlayered app.css rule that beats every
// transition-* utility: transition-duration 160ms / var(--xmd-ease) (spec §3).
const styles = stylex.create({
  base: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens['--radius'],
    borderStyle: 'solid',
    borderWidth: '1px',
    borderColor: {
      default: 'transparent',
      ':focus-visible': tokens['--ring'],
      '[aria-invalid="true"]': tokens['--destructive'],
      [DARK]: {
        default: null,
        '[aria-invalid="true"]': 'color-mix(in oklab, var(--destructive) 50%, transparent)',
      },
    },
    backgroundClip: 'padding-box',
    fontSize: '0.875rem',
    lineHeight: tokens['--text-sm--line-height'],
    fontWeight: 500,
    whiteSpace: 'nowrap',
    transitionProperty: 'color, background-color, border-color, box-shadow, transform',
    transitionDuration: '0.16s',
    transitionTimingFunction: 'var(--xmd-ease)',
    outlineStyle: 'none',
    userSelect: 'none',
    boxShadow: {
      default: null,
      ':focus-visible':
        '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent), 0 0 #0000',
      '[aria-invalid="true"]':
        '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--destructive) 20%, transparent), 0 0 #0000',
      [DARK]: {
        default: null,
        '[aria-invalid="true"]':
          '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--destructive) 40%, transparent), 0 0 #0000',
      },
    },
    pointerEvents: { default: null, ':disabled': 'none' },
    opacity: { default: null, ':disabled': 0.5 },
    scale: { default: null, ':active:not([aria-haspopup])': 0.97 },
  },
})

const variantStyles = stylex.create({
  default: {
    backgroundColor: {
      default: tokens['--primary'],
      [HOVER]: { ':hover': 'color-mix(in oklab, var(--primary) 80%, transparent)' },
    },
    color: tokens['--primary-foreground'],
  },
  outline: {
    borderColor: {
      default: tokens['--border'],
      ':focus-visible': tokens['--ring'],
      '[aria-invalid="true"]': tokens['--destructive'],
      // A dark-mode default outranks the light pseudo-class keys in StyleX,
      // whereas Tailwind's `focus-visible:border-ring` (0,2,0) beat
      // `dark:border-input` (0,1,0) — so the focus ring is restated in here.
      [DARK]: {
        default: tokens['--input'],
        ':focus-visible': tokens['--ring'],
        '[aria-invalid="true"]': 'color-mix(in oklab, var(--destructive) 50%, transparent)',
      },
    },
    backgroundColor: {
      default: tokens['--background'],
      [HOVER]: { ':hover': tokens['--muted'] },
      '[aria-expanded="true"]': tokens['--muted'],
      [DARK]: {
        default: 'color-mix(in oklab, var(--input) 30%, transparent)',
        [HOVER]: { ':hover': 'color-mix(in oklab, var(--input) 50%, transparent)' },
        // `aria-expanded:bg-muted` (0,2,0) beat `dark:bg-input/30` (0,1,0) too.
        '[aria-expanded="true"]': tokens['--muted'],
      },
    },
    color: {
      default: null,
      [HOVER]: { ':hover': tokens['--foreground'] },
      '[aria-expanded="true"]': tokens['--foreground'],
    },
  },
  secondary: {
    // aria-expanded:bg-secondary / aria-expanded:text-secondary-foreground are
    // no-ops here (same value as the unconditioned default) — omitted, no
    // computed-style difference.
    backgroundColor: {
      default: tokens['--secondary'],
      [HOVER]: { ':hover': 'color-mix(in oklch, var(--secondary), var(--foreground) 5%)' },
    },
    color: tokens['--secondary-foreground'],
  },
  ghost: {
    backgroundColor: {
      default: null,
      [HOVER]: { ':hover': tokens['--muted'] },
      '[aria-expanded="true"]': tokens['--muted'],
      [DARK]: {
        default: null,
        [HOVER]: { ':hover': 'color-mix(in oklab, var(--muted) 50%, transparent)' },
      },
    },
    color: {
      default: null,
      [HOVER]: { ':hover': tokens['--foreground'] },
      '[aria-expanded="true"]': tokens['--foreground'],
    },
  },
  destructive: {
    backgroundColor: {
      default: 'color-mix(in oklab, var(--destructive) 10%, transparent)',
      [HOVER]: { ':hover': 'color-mix(in oklab, var(--destructive) 20%, transparent)' },
      [DARK]: {
        default: 'color-mix(in oklab, var(--destructive) 20%, transparent)',
        [HOVER]: { ':hover': 'color-mix(in oklab, var(--destructive) 30%, transparent)' },
      },
    },
    color: tokens['--destructive'],
    borderColor: {
      default: 'transparent',
      ':focus-visible': 'color-mix(in oklab, var(--destructive) 40%, transparent)',
      '[aria-invalid="true"]': tokens['--destructive'],
      [DARK]: {
        default: null,
        '[aria-invalid="true"]': 'color-mix(in oklab, var(--destructive) 50%, transparent)',
      },
    },
    boxShadow: {
      default: null,
      ':focus-visible':
        '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--destructive) 20%, transparent), 0 0 #0000',
      '[aria-invalid="true"]':
        '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--destructive) 20%, transparent), 0 0 #0000',
      [DARK]: {
        default: null,
        ':focus-visible':
          '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--destructive) 40%, transparent), 0 0 #0000',
        '[aria-invalid="true"]':
          '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--destructive) 40%, transparent), 0 0 #0000',
      },
    },
  },
  link: {
    color: tokens['--primary'],
    textUnderlineOffset: '4px',
    textDecorationLine: { default: null, [HOVER]: { ':hover': 'underline' } },
  },
})

// dropped: in-data-[slot=button-group]:rounded-lg (xs, sm, icon-xs, icon-sm) — no
// [data-slot="button-group"] ancestor exists anywhere in this codebase.
const sizeStyles = stylex.create({
  default: {
    height: '2rem',
    gap: '0.375rem',
    paddingInline: '0.625rem',
    paddingRight: { default: null, ':has([data-icon="inline-end"])': '0.5rem' },
    paddingLeft: { default: null, ':has([data-icon="inline-start"])': '0.5rem' },
  },
  xs: {
    height: '1.5rem',
    gap: '0.25rem',
    borderRadius: 'min(var(--radius-md), 10px)',
    paddingInline: '0.5rem',
    fontSize: '0.75rem',
    lineHeight: tokens['--text-xs--line-height'],
    paddingRight: { default: null, ':has([data-icon="inline-end"])': '0.375rem' },
    paddingLeft: { default: null, ':has([data-icon="inline-start"])': '0.375rem' },
  },
  sm: {
    height: '1.75rem',
    gap: '0.25rem',
    borderRadius: 'min(var(--radius-md), 12px)',
    paddingInline: '0.625rem',
    fontSize: '0.8rem',
    lineHeight: null,
    paddingRight: { default: null, ':has([data-icon="inline-end"])': '0.375rem' },
    paddingLeft: { default: null, ':has([data-icon="inline-start"])': '0.375rem' },
  },
  lg: {
    height: '2.25rem',
    gap: '0.375rem',
    paddingInline: '0.625rem',
    paddingRight: { default: null, ':has([data-icon="inline-end"])': '0.5rem' },
    paddingLeft: { default: null, ':has([data-icon="inline-start"])': '0.5rem' },
  },
  icon: { width: '2rem', height: '2rem' },
  'icon-xs': { width: '1.5rem', height: '1.5rem', borderRadius: 'min(var(--radius-md), 10px)' },
  'icon-sm': { width: '1.75rem', height: '1.75rem', borderRadius: 'min(var(--radius-md), 12px)' },
  'icon-lg': { width: '2.25rem', height: '2.25rem' },
})

type ButtonSize = 'default' | 'xs' | 'sm' | 'lg' | 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg'
type ButtonVariant = 'default' | 'outline' | 'secondary' | 'ghost' | 'destructive' | 'link'

// [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-N —
// read back by icons.tsx via stylex.when.ancestor (spec §5).
const svgMarkerBySize: Record<ButtonSize, StyleXStyles> = {
  default: svgSize4,
  lg: svgSize4,
  icon: svgSize4,
  'icon-lg': svgSize4,
  sm: svgSize35,
  'icon-sm': svgSize35,
  xs: svgSize3,
  'icon-xs': svgSize3,
}

function Button({
  variant = 'default',
  size = 'default',
  render,
  sx,
  ...props
}: React.ComponentProps<'button'> & {
  variant?: ButtonVariant
  size?: ButtonSize
  render?: React.ReactElement
  sx?: StyleXStyles | ReadonlyArray<StyleXStyles | false | null | undefined>
}) {
  const { className, style } = stylex.props(
    styles.base,
    variantStyles[variant],
    sizeStyles[size],
    svgHost,
    svgMarkerBySize[size],
    sx,
  )
  return useRender({
    defaultTagName: 'button',
    render,
    props: {
      'data-slot': 'button',
      'data-variant': variant,
      'data-size': size,
      className,
      style,
      ...props,
    },
  })
}

export { Button }
