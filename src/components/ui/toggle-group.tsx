// @ts-nocheck — vendored shadcn/ui, authored for React. This repo runs Preact
// via preact/compat with exactOptionalPropertyTypes; the {...props} spreads onto
// Base UI primitives do not satisfy it. Checked at call sites instead.
'use client'

import * as React from 'react'
import * as stylex from '@stylexjs/stylex'
import type { StyleXStyles } from '@stylexjs/stylex'
import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group'
import { Toggle as TogglePrimitive } from '@base-ui/react/toggle'
import { tokens } from '@/theme/tokens.stylex'
import { toggleStyles } from '@/components/ui/toggle'

type ToggleVariant = 'default' | 'outline'
type ToggleSize = 'default' | 'sm' | 'lg'

const ToggleGroupContext = React.createContext<{
  variant?: ToggleVariant
  size?: ToggleSize
  spacing?: number
  orientation?: 'horizontal' | 'vertical'
}>({
  size: 'default',
  variant: 'default',
  spacing: 2,
  orientation: 'horizontal',
})

const groupStyles = stylex.create({
  root: {
    display: 'flex',
    width: 'fit-content',
    flexDirection: { default: 'row', '[data-vertical]': 'column' },
    alignItems: { default: 'center', '[data-vertical]': 'stretch' },
    gap: 'calc(0.25rem * var(--gap))',
    borderRadius: {
      default: tokens['--radius'],
      '[data-size="sm"]': 'min(var(--radius-md), 10px)',
    },
  },
})

// The group-data-[spacing=0]/toggle-group:*, group-data-horizontal/*, and
// group-data-vertical/* rules relied on a `.group/toggle-group` ancestor class
// that no longer exists once Tailwind utilities are gone (spec §5) — resolved
// here from ToggleGroupContext instead of a CSS ancestor selector.
const itemStyles = stylex.create({
  base: {
    flexShrink: 0,
    zIndex: { default: null, ':focus': 10, ':focus-visible': 10 },
  },
  zeroSpacing: {
    flexShrink: null,
    flex: 1,
    paddingInline: '0.5rem',
    paddingRight: { default: null, ':has([data-icon="inline-end"])': '0.375rem' },
    paddingLeft: { default: null, ':has([data-icon="inline-start"])': '0.375rem' },
  },
  // `rounded-none` plus the first/last corner restores. Each corner is ONE
  // property object (default 0 + its pseudo-class), because a later
  // `{ default: null, ':first-child': … }` would replace an earlier plain `0`
  // for the same property wholesale — StyleX merges per property, not per key.
  zeroSpacingCornersHorizontal: {
    borderTopLeftRadius: { default: 0, ':first-child': tokens['--radius'] },
    borderBottomLeftRadius: { default: 0, ':first-child': tokens['--radius'] },
    borderTopRightRadius: { default: 0, ':last-child': tokens['--radius'] },
    borderBottomRightRadius: { default: 0, ':last-child': tokens['--radius'] },
  },
  zeroSpacingCornersVertical: {
    borderTopLeftRadius: { default: 0, ':first-child': tokens['--radius'] },
    borderTopRightRadius: { default: 0, ':first-child': tokens['--radius'] },
    borderBottomLeftRadius: { default: 0, ':last-child': tokens['--radius'] },
    borderBottomRightRadius: { default: 0, ':last-child': tokens['--radius'] },
  },
  zeroSpacingOutlineHorizontal: {
    borderLeftStyle: 'solid',
    borderLeftWidth: { default: 0, ':first-child': '1px' },
  },
  zeroSpacingOutlineVertical: {
    borderTopStyle: 'solid',
    borderTopWidth: { default: 0, ':first-child': '1px' },
  },
})

// Base UI's ToggleGroup is always array-valued (`multiple` picks 1-vs-many),
// whereas the call sites use Radix's `type="single"` with a scalar value. This
// wrapper bridges the two: scalar <-> single-element array on the way in/out.
function ToggleGroup({
  variant,
  size,
  spacing = 2,
  orientation = 'horizontal',
  type = 'single',
  value,
  defaultValue,
  onValueChange,
  children,
  sx,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive> & {
  variant?: ToggleVariant
  size?: ToggleSize
  spacing?: number
  orientation?: 'horizontal' | 'vertical'
  type?: 'single' | 'multiple'
  sx?: StyleXStyles | ReadonlyArray<StyleXStyles | false | null | undefined>
}) {
  const multiple = type === 'multiple'
  const toArray = (v: unknown) => (v == null ? undefined : Array.isArray(v) ? v : [v])
  const handleValueChange = (groupValue: string[]) => {
    if (!onValueChange) return
    if (multiple) onValueChange(groupValue)
    else onValueChange(groupValue[0] ?? '')
  }

  const { className, style: sxStyle } = stylex.props(groupStyles.root, sx)

  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      data-spacing={spacing}
      data-horizontal={orientation === 'horizontal' || undefined}
      data-vertical={orientation === 'vertical' || undefined}
      orientation={orientation}
      multiple={multiple}
      value={toArray(value)}
      defaultValue={toArray(defaultValue)}
      onValueChange={handleValueChange}
      className={className}
      style={{ '--gap': spacing, ...sxStyle } as React.CSSProperties}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ variant, size, spacing, orientation }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive>
  )
}

function ToggleGroupItem({
  children,
  variant = 'default',
  size = 'default',
  sx,
  ...props
}: React.ComponentProps<typeof TogglePrimitive> & {
  variant?: ToggleVariant
  size?: ToggleSize
  sx?: StyleXStyles | ReadonlyArray<StyleXStyles | false | null | undefined>
}) {
  const context = React.useContext(ToggleGroupContext)
  const resolvedVariant = context.variant || variant
  const resolvedSize = context.size || size
  const spacingZero = context.spacing === 0
  const vertical = context.orientation === 'vertical'
  const isOutline = resolvedVariant === 'outline'

  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      data-variant={resolvedVariant}
      data-size={resolvedSize}
      data-spacing={context.spacing}
      {...stylex.props(
        itemStyles.base,
        toggleStyles.base.root,
        toggleStyles.variant[resolvedVariant],
        toggleStyles.size[resolvedSize],
        toggleStyles.svgHost,
        toggleStyles.svgMarkerBySize[resolvedSize],
        spacingZero && itemStyles.zeroSpacing,
        spacingZero &&
          (vertical
            ? itemStyles.zeroSpacingCornersVertical
            : itemStyles.zeroSpacingCornersHorizontal),
        spacingZero &&
          isOutline &&
          (vertical
            ? itemStyles.zeroSpacingOutlineVertical
            : itemStyles.zeroSpacingOutlineHorizontal),
        sx,
      )}
      {...props}
    >
      {children}
    </TogglePrimitive>
  )
}

export { ToggleGroup, ToggleGroupItem }
