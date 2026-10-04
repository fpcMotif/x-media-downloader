// @ts-nocheck — vendored shadcn/ui, authored for React. This repo runs Preact
// via preact/compat with exactOptionalPropertyTypes; the {...props} spreads onto
// Base UI primitives do not satisfy it. Checked at call sites instead.
'use client'

import * as React from 'react'
import { Progress as ProgressPrimitive } from '@base-ui/react/progress'
import * as stylex from '@stylexjs/stylex'
import type { StyleXStyles } from '@stylexjs/stylex'

import { tokens } from '@/theme/tokens.stylex'

const styles = stylex.create({
  root: {
    position: 'relative',
    height: '0.25rem',
    width: '100%',
    overflow: 'hidden',
    borderRadius: '3.40282e38px',
    backgroundColor: tokens['--muted'],
  },
  track: {
    display: 'block',
    height: '100%',
    width: '100%',
    overflow: 'hidden',
    borderRadius: '3.40282e38px',
  },
  indicator: {
    height: '100%',
    backgroundColor: tokens['--primary'],
    transitionProperty: 'all',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    transitionDuration: '0.15s',
  },
})

// Base UI's Progress.Indicator sizes itself from Root's `value` (width: N%), so
// the manual translateX transform is gone — Root holds the rail, Track clips, and
// Indicator is the fill.
function Progress({
  value,
  sx,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & { sx?: StyleXStyles }) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value ?? null}
      {...stylex.props(styles.root, sx)}
      {...props}
    >
      <ProgressPrimitive.Track {...stylex.props(styles.track)}>
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          {...stylex.props(styles.indicator)}
        />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  )
}

export { Progress }
