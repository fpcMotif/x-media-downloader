// @ts-nocheck — vendored shadcn/ui (radix-nova), authored for React. This repo
// runs Preact via preact/compat with exactOptionalPropertyTypes; the {...props}
// spreads onto Radix primitives do not satisfy it. Checked at call sites instead.
// Re-add this header after `shadcn add --overwrite`.
import * as React from 'react'
import { Label as LabelPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        'flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export { Label }
