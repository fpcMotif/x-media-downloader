// @ts-nocheck — vendored shadcn/ui, authored for React. This repo runs Preact
// via preact/compat with exactOptionalPropertyTypes; the {...props} spreads do
// not satisfy it. Checked at call sites instead.
import * as React from 'react'
import * as stylex from '@stylexjs/stylex'
import type { StyleXStyles } from '@stylexjs/stylex'

import { tokens } from '@/theme/tokens.stylex'

const MD = '@media (width >= 48rem)'

const styles = stylex.create({
  input: {
    height: '2rem',
    width: '100%',
    minWidth: 0,
    borderRadius: tokens['--radius'],
    borderStyle: 'solid',
    borderWidth: '1px',
    borderColor: {
      default: tokens['--input'],
      ':focus-visible': tokens['--ring'],
      '[aria-invalid="true"]':
        'light-dark(var(--destructive), color-mix(in oklab, var(--destructive) 50%, transparent))',
    },
    backgroundColor: {
      default:
        'light-dark(transparent, color-mix(in oklab, var(--xmd-line-strong) 30%, transparent))',
      ':disabled':
        'light-dark(color-mix(in oklab, var(--xmd-line-strong) 50%, transparent), color-mix(in oklab, var(--xmd-line-strong) 80%, transparent))',
    },
    paddingInline: '0.625rem',
    paddingBlock: '0.25rem',
    fontSize: { default: '1rem', [MD]: '0.875rem' },
    lineHeight: {
      default: tokens['--text-base--line-height'],
      [MD]: tokens['--text-sm--line-height'],
    },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    // data-slot is "input", not "button"/"switch", so the app.css data-slot
    // transition override does not apply — this keeps transition-colors' own
    // 0.15s duration.
    transitionDuration: '0.15s',
    outlineStyle: 'none',
    boxShadow: {
      default: null,
      ':focus-visible': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px var(--ring), 0 0 #0000',
      '[aria-invalid="true"]':
        '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px light-dark(color-mix(in oklab, var(--destructive) 20%, transparent), color-mix(in oklab, var(--destructive) 40%, transparent)), 0 0 #0000',
    },
    pointerEvents: { default: null, ':disabled': 'none' },
    cursor: { default: null, ':disabled': 'not-allowed' },
    opacity: { default: null, ':disabled': 0.5 },
    '::file-selector-button': {
      display: 'inline-flex',
      height: '1.5rem',
      borderStyle: 'solid',
      borderWidth: 0,
      backgroundColor: 'transparent',
      fontSize: '0.875rem',
      lineHeight: tokens['--text-sm--line-height'],
      fontWeight: 500,
      color: tokens['--foreground'],
    },
    '::placeholder': {
      color: tokens['--muted-foreground'],
    },
  },
})

function Input({ type, sx, ...props }: React.ComponentProps<'input'> & { sx?: StyleXStyles }) {
  return <input type={type} data-slot="input" {...stylex.props(styles.input, sx)} {...props} />
}

export { Input }
