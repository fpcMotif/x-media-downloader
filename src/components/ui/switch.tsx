// @ts-nocheck — vendored shadcn/ui, authored for React. This repo runs Preact
// via preact/compat with exactOptionalPropertyTypes; the {...props} spreads onto
// Base UI primitives do not satisfy it. Checked at call sites instead.
'use client'

import * as React from 'react'
import { Switch as SwitchPrimitive } from '@base-ui/react/switch'
import * as stylex from '@stylexjs/stylex'
import type { StyleXStyles } from '@stylexjs/stylex'
import { tokens } from '@/theme/tokens.stylex'

const DARK = '@media (prefers-color-scheme: dark)'

// Base UI drives switch state through bare `data-checked` / `data-unchecked`
// attributes (on both Root and Thumb) rather than Radix's `data-[state=…]`.
// The old `peer`/`group/switch` classes only existed so Tailwind could reach
// across to the Thumb (`group-data-[size=…]/switch:…`); here the Thumb reads
// `size` from the same closure instead, so those markers are dropped.
const styles = stylex.create({
  root: {
    position: 'relative',
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    borderRadius: '3.40282e38px',
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
    // data-slot="switch" override (spec §3): the unlayered app.css rule beats
    // every `transition-colors`/`duration-*` utility on this element.
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: '0.15s',
    transitionTimingFunction: 'var(--xmd-ease)',
    outlineStyle: 'none',
    '::after': {
      content: '""',
      position: 'absolute',
      insetInline: '-0.75rem',
      insetBlock: '-0.75rem',
    },
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
    backgroundColor: {
      default: null,
      '[data-checked]': tokens['--primary'],
      '[data-unchecked]': tokens['--input'],
      [DARK]: {
        default: null,
        '[data-unchecked]': 'color-mix(in oklab, var(--input) 80%, transparent)',
      },
    },
    cursor: { default: null, '[data-disabled]': 'not-allowed' },
    opacity: { default: null, '[data-disabled]': 0.5 },
  },
  rootSizeDefault: {
    height: '18.4px',
    width: '32px',
  },
  rootSizeSm: {
    height: '14px',
    width: '24px',
  },
  thumb: {
    pointerEvents: 'none',
    display: 'block',
    borderRadius: '3.40282e38px',
    backgroundColor: {
      default: tokens['--background'],
      [DARK]: {
        default: null,
        '[data-checked]': tokens['--primary-foreground'],
        '[data-unchecked]': tokens['--foreground'],
      },
    },
    boxShadow: '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 0px currentcolor, 0 0 #0000',
    // data-slot="switch-thumb" override (spec §3), same as the root.
    transitionProperty: 'transform, translate, scale, rotate',
    transitionDuration: '0.15s',
    transitionTimingFunction: 'var(--xmd-ease)',
    translate: {
      default: null,
      '[data-checked]': 'calc(100% - 2px) 0',
      '[data-unchecked]': '0 0',
    },
  },
  thumbSizeDefault: {
    width: '1rem',
    height: '1rem',
  },
  thumbSizeSm: {
    width: '0.75rem',
    height: '0.75rem',
  },
})

function Switch({
  sx,
  size = 'default',
  ...props
}: Omit<React.ComponentProps<typeof SwitchPrimitive.Root>, 'className'> & {
  size?: 'sm' | 'default'
  sx?: StyleXStyles | ReadonlyArray<StyleXStyles | false | null | undefined>
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      {...stylex.props(styles.root, size === 'sm' ? styles.rootSizeSm : styles.rootSizeDefault, sx)}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        {...stylex.props(
          styles.thumb,
          size === 'sm' ? styles.thumbSizeSm : styles.thumbSizeDefault,
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
