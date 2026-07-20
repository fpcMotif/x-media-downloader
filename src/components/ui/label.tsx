// @ts-nocheck — vendored shadcn/ui, authored for React. This repo runs Preact
// via preact/compat with exactOptionalPropertyTypes; the {...props} spreads onto
// Base UI primitives do not satisfy it. Checked at call sites instead.
import * as React from 'react'

import { cn } from '@/lib/utils'

// Base UI has no standalone Label primitive (labeling lives on Field.Label), so
// the shadcn Label renders a plain <label>. The peer/group selectors below drive
// its disabled styling exactly as before.
function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
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
