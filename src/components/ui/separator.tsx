// @ts-nocheck — vendored shadcn/ui, authored for React. This repo runs Preact
// via preact/compat with exactOptionalPropertyTypes; the {...props} spreads onto
// Base UI primitives do not satisfy it. Checked at call sites instead.
import * as React from 'react'
import { Separator as SeparatorPrimitive } from '@base-ui/react/separator'
import * as stylex from '@stylexjs/stylex'
import type { StyleXStyles } from '@stylexjs/stylex'

import { tokens } from '@/theme/tokens.stylex'

const styles = stylex.create({
  separator: {
    flexShrink: 0,
    backgroundColor: tokens['--border'],
    height: { default: null, '[data-orientation="horizontal"]': '1px' },
    width: {
      default: null,
      '[data-orientation="horizontal"]': '100%',
      '[data-orientation="vertical"]': '1px',
    },
    alignSelf: { default: null, '[data-orientation="vertical"]': 'stretch' },
  },
})

// Base UI's Separator is always decorative (no `decorative` prop) and exposes its
// axis as `data-orientation`, so the sizing styles key off that instead of the
// Radix-era bare `data-horizontal` / `data-vertical` attributes.
function Separator({
  orientation = 'horizontal',
  sx,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive> & { sx?: StyleXStyles }) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      {...stylex.props(styles.separator, sx)}
      {...props}
    />
  )
}

export { Separator }
