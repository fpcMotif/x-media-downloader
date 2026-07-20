// @ts-nocheck — vendored shadcn/ui, authored for React. This repo runs Preact
// via preact/compat with exactOptionalPropertyTypes; the {...props} spreads onto
// Base UI primitives do not satisfy it. Checked at call sites instead.
'use client'

import * as React from 'react'
import { Progress as ProgressPrimitive } from '@base-ui/react/progress'

import { cn } from '@/lib/utils'

// Base UI's Progress.Indicator sizes itself from Root's `value` (width: N%), so
// the manual translateX transform is gone — Root holds the rail, Track clips, and
// Indicator is the fill.
function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value ?? null}
      className={cn('relative h-1 w-full overflow-hidden rounded-full bg-muted', className)}
      {...props}
    >
      <ProgressPrimitive.Track className="block h-full w-full overflow-hidden rounded-full">
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className="h-full bg-primary transition-all"
        />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  )
}

export { Progress }
