// @ts-nocheck — vendored shadcn/ui, authored for React. This repo runs Preact
// via preact/compat with exactOptionalPropertyTypes; the {...props} spreads onto
// Base UI primitives do not satisfy it. Checked at call sites instead.
import * as React from 'react'
import * as stylex from '@stylexjs/stylex'
import type { StyleXStyles } from '@stylexjs/stylex'

const styles = stylex.create({
  label: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontSize: '0.875rem',
    lineHeight: 1,
    fontWeight: 500,
    userSelect: 'none',
    // dropped: group-data-[disabled=true]:pointer-events-none / opacity-50,
    // peer-disabled:cursor-not-allowed / opacity-50 — no `.group`/`.peer`
    // ancestor or preceding sibling exists at any call site.
  },
})

// Base UI has no standalone Label primitive (labeling lives on Field.Label), so
// the shadcn Label renders a plain <label>.
function Label({ sx, ...props }: React.ComponentProps<'label'> & { sx?: StyleXStyles }) {
  return <label data-slot="label" {...stylex.props(styles.label, sx)} {...props} />
}

export { Label }
