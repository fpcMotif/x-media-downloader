import type { ComponentChildren, VNode } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import * as stylex from '@stylexjs/stylex'

const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)'
const COLLAPSE_SECONDS = 0.26
const LINGER_MS = COLLAPSE_SECONDS * 1000 + 40

const styles = stylex.create({
  root: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    minWidth: 0,
    flexShrink: 0,
    transitionProperty: 'grid-template-rows, opacity, visibility',
    transitionDuration: { default: `${COLLAPSE_SECONDS}s`, [REDUCED_MOTION]: '0s' },
    transitionTimingFunction: 'var(--xmd-ease)',
  },
  open: { gridTemplateRows: '1fr', opacity: 1, visibility: 'visible' },
  closed: { gridTemplateRows: '0fr', opacity: 0, visibility: 'hidden' },
  inner: { minWidth: 0, minHeight: 0, overflowY: 'clip' },
})

export function Collapse({
  open,
  children,
}: {
  readonly open: boolean
  readonly children: ComponentChildren
}): VNode {
  return (
    <div {...stylex.props(styles.root, open ? styles.open : styles.closed)}>
      <div {...stylex.props(styles.inner)}>{children}</div>
    </div>
  )
}

export function useLingeringValue<T>(value: T | null): T | null {
  const [held, setHeld] = useState<T | null>(value)
  useEffect(() => {
    if (value !== null) {
      setHeld(value)
      return undefined
    }
    const timer = setTimeout(() => setHeld(null), LINGER_MS)
    return () => clearTimeout(timer)
  }, [value])
  return value ?? held
}
