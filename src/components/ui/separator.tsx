// @ts-nocheck — vendored shadcn/ui, authored for React. This repo runs Preact
// via preact/compat with exactOptionalPropertyTypes; the {...props} spreads onto
// Base UI primitives do not satisfy it. Checked at call sites instead.
import * as React from 'react'
import { Separator as SeparatorPrimitive } from '@base-ui/react/separator'

import { cn } from '@/lib/utils'

// Base UI's Separator is always decorative (no `decorative` prop) and exposes its
// axis as `data-orientation`, so the sizing classes key off that instead of the
// Radix-era bare `data-horizontal` / `data-vertical` attributes.
function Separator({
  className,
  orientation = 'horizontal',
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive>) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        'shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch',
        className,
      )}
      {...props}
    />
  )
}

export { Separator }
