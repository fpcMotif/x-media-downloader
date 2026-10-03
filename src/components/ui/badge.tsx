// @ts-nocheck — vendored shadcn/ui, authored for React. This repo runs Preact
// via preact/compat with exactOptionalPropertyTypes; the {...props} spreads onto
// Base UI primitives do not satisfy it. Checked at call sites instead.
import * as React from 'react'
import * as stylex from '@stylexjs/stylex'
import type { StyleXStyles } from '@stylexjs/stylex'
import { useRender } from '@base-ui/react/use-render'
import { tokens } from '@/theme/tokens.stylex'
import { badgeSvg } from '@/theme/markers.stylex'

const HOVER = '@media (hover: hover)'
const DARK = '@media (prefers-color-scheme: dark)'

const styles = stylex.create({
  base: {
    display: 'inline-flex',
    height: '1.25rem',
    width: 'fit-content',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.25rem',
    overflow: 'hidden',
    borderRadius: '2rem',
    borderStyle: 'solid',
    borderWidth: '1px',
    borderColor: {
      default: 'transparent',
      ':focus-visible': tokens['--ring'],
      '[aria-invalid="true"]': tokens['--destructive'],
    },
    paddingInline: '0.5rem',
    paddingBlock: '0.125rem',
    fontSize: '0.75rem',
    lineHeight: tokens['--text-xs--line-height'],
    fontWeight: 500,
    whiteSpace: 'nowrap',
    transitionProperty: 'all',
    transitionDuration: '0.15s',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    paddingRight: { default: null, ':has([data-icon="inline-end"])': '0.375rem' },
    paddingLeft: { default: null, ':has([data-icon="inline-start"])': '0.375rem' },
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
  },
})

const variantStyles = stylex.create({
  default: {
    backgroundColor: {
      default: tokens['--primary'],
      [HOVER]: { ':is(a):hover': 'color-mix(in oklab, var(--primary) 80%, transparent)' },
    },
    color: tokens['--primary-foreground'],
  },
  secondary: {
    backgroundColor: {
      default: tokens['--secondary'],
      [HOVER]: { ':is(a):hover': 'color-mix(in oklab, var(--secondary) 80%, transparent)' },
    },
    color: tokens['--secondary-foreground'],
  },
  destructive: {
    backgroundColor: {
      default: 'color-mix(in oklab, var(--destructive) 10%, transparent)',
      [HOVER]: { ':is(a):hover': 'color-mix(in oklab, var(--destructive) 20%, transparent)' },
      [DARK]: { default: 'color-mix(in oklab, var(--destructive) 20%, transparent)' },
    },
    color: tokens['--destructive'],
    // destructive replaces the base ring color at :focus-visible (own
    // focus-visible:ring-destructive/20, dark:focus-visible:ring-destructive/40).
    // The aria-invalid compound key is omitted here — it resolves to the same
    // color as the plain :focus-visible key for this variant, so dropping it
    // changes no computed value.
    boxShadow: {
      default: null,
      ':focus-visible':
        '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--destructive) 20%, transparent), 0 0 #0000',
      [DARK]: {
        default: null,
        ':focus-visible':
          '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--destructive) 40%, transparent), 0 0 #0000',
      },
    },
  },
  outline: {
    borderColor: {
      default: tokens['--border'],
      ':focus-visible': tokens['--ring'],
      '[aria-invalid="true"]': tokens['--destructive'],
    },
    backgroundColor: { default: null, [HOVER]: { ':is(a):hover': tokens['--muted'] } },
    color: {
      default: tokens['--foreground'],
      [HOVER]: { ':is(a):hover': tokens['--muted-foreground'] },
    },
  },
  success: {
    backgroundColor: {
      default: 'color-mix(in oklab, var(--success) 12%, transparent)',
      [HOVER]: { ':is(a):hover': 'color-mix(in oklab, var(--success) 20%, transparent)' },
    },
    color: tokens['--success'],
  },
  ghost: {
    backgroundColor: {
      default: null,
      [HOVER]: { ':hover': tokens['--muted'] },
      [DARK]: {
        default: null,
        [HOVER]: { ':hover': 'color-mix(in oklab, var(--muted) 50%, transparent)' },
      },
    },
    color: { default: null, [HOVER]: { ':hover': tokens['--muted-foreground'] } },
  },
  link: {
    color: tokens['--primary'],
    textUnderlineOffset: '4px',
    textDecorationLine: { default: null, [HOVER]: { ':hover': 'underline' } },
  },
})

type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'success'
  | 'ghost'
  | 'link'

function Badge({
  variant = 'default',
  render,
  sx,
  ...props
}: React.ComponentProps<'span'> & {
  variant?: BadgeVariant
  render?: React.ReactElement
  sx?: StyleXStyles | ReadonlyArray<StyleXStyles | false | null | undefined>
}) {
  const { className, style } = stylex.props(styles.base, variantStyles[variant], badgeSvg, sx)
  return useRender({
    defaultTagName: 'span',
    render,
    props: {
      'data-slot': 'badge',
      'data-variant': variant,
      className,
      style,
      ...props,
    },
  })
}

export { Badge }
