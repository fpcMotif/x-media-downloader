// @ts-nocheck — vendored shadcn/ui, authored for React. This repo runs Preact
// via preact/compat with exactOptionalPropertyTypes; the {...props} spreads onto
// Base UI primitives do not satisfy it. Checked at call sites instead.
import * as React from 'react'
import { Select as SelectPrimitive } from '@base-ui/react/select'
import * as stylex from '@stylexjs/stylex'
import type { StyleXStyles } from '@stylexjs/stylex'

import { tokens } from '@/theme/tokens.stylex'
import { svgHost, svgSize4 } from '@/theme/markers.stylex'
import { ChevronDownIcon, CheckIcon, ChevronUpIcon, iconSize, iconInert } from '@/components/icons'

type Sx = StyleXStyles | ReadonlyArray<StyleXStyles | false | null | undefined>

const HOVER = '@media (hover: hover)'
const DARK = '@media (prefers-color-scheme: dark)'
const FORCED_COLORS = '@media (forced-colors: active)'

// SelectContent's open/close animation (tw-animate-css `animate-in`/`animate-out`).
// Tailwind keys the six longhands off `data-open`/`data-closed` via the
// `animation` shorthand, so a settled-closed popup (neither attribute present)
// has no animation declared at all — every longhand below stays conditional
// for that reason, `default: null` included.
const enterNone = stylex.keyframes({
  '0%': {
    opacity: 0,
    transform: 'translate3d(0, 0, 0) scale3d(0.95, 0.95, 0.95) rotate(0)',
    filter: 'blur(0)',
  },
})
const enterFromTop2 = stylex.keyframes({
  '0%': {
    opacity: 0,
    transform: 'translate3d(0, calc(2 * 0.25rem * -1), 0) scale3d(0.95, 0.95, 0.95) rotate(0)',
    filter: 'blur(0)',
  },
})
const enterFromRight2 = stylex.keyframes({
  '0%': {
    opacity: 0,
    transform: 'translate3d(calc(2 * 0.25rem), 0, 0) scale3d(0.95, 0.95, 0.95) rotate(0)',
    filter: 'blur(0)',
  },
})
const enterFromLeft2 = stylex.keyframes({
  '0%': {
    opacity: 0,
    transform: 'translate3d(calc(2 * 0.25rem * -1), 0, 0) scale3d(0.95, 0.95, 0.95) rotate(0)',
    filter: 'blur(0)',
  },
})
const enterFromBottom2 = stylex.keyframes({
  '0%': {
    opacity: 0,
    transform: 'translate3d(0, calc(2 * 0.25rem), 0) scale3d(0.95, 0.95, 0.95) rotate(0)',
    filter: 'blur(0)',
  },
})
const exit = stylex.keyframes({
  to: {
    opacity: 0,
    transform: 'translate3d(0, 0, 0) scale3d(0.95, 0.95, 0.95) rotate(0)',
    filter: 'blur(0)',
  },
})

const styles = stylex.create({
  group: {
    scrollMarginBlock: '0.25rem',
    padding: '0.25rem',
  },
  // `*:data-[slot=select-value]:…` on the trigger styled the value directly —
  // Tailwind emits both `display: -webkit-box` (line-clamp-1) and, later,
  // `display: flex`; the later rule wins, so the resolved display is `flex`.
  value: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.375rem',
    WebkitLineClamp: 1,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  trigger: {
    display: 'flex',
    width: 'fit-content',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.375rem',
    borderRadius: {
      default: tokens['--radius'],
      '[data-size="sm"]': 'min(var(--radius-md), 10px)',
    },
    borderStyle: 'solid',
    borderWidth: '1px',
    borderColor: {
      default: tokens['--input'],
      ':focus-visible': tokens['--ring'],
      '[aria-invalid="true"]': tokens['--destructive'],
      [DARK]: {
        default: null,
        '[aria-invalid="true"]': 'color-mix(in oklab, var(--destructive) 50%, transparent)',
      },
    },
    backgroundColor: {
      default: 'transparent',
      [HOVER]: { ':hover': tokens['--muted'] },
      [DARK]: {
        default: 'color-mix(in oklab, var(--input) 30%, transparent)',
        [HOVER]: { ':hover': 'color-mix(in oklab, var(--input) 50%, transparent)' },
      },
    },
    paddingBlock: '0.5rem',
    paddingRight: '0.5rem',
    paddingLeft: '0.625rem',
    fontSize: '0.875rem',
    lineHeight: tokens['--text-sm--line-height'],
    whiteSpace: 'nowrap',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: '0.15s',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    outlineStyle: 'none',
    userSelect: 'none',
    cursor: { default: null, ':disabled': 'not-allowed' },
    opacity: { default: null, ':disabled': 0.5 },
    boxShadow: {
      default: null,
      ':focus-visible':
        '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent), 0 0 #0000',
      '[aria-invalid="true"]':
        '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--destructive) 20%, transparent), 0 0 #0000',
      [DARK]: {
        default: null,
        '[aria-invalid="true"]':
          '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--destructive) 40%, transparent), 0 0 #0000',
      },
    },
    color: { default: null, '[data-placeholder]': tokens['--muted-foreground'] },
    height: { default: null, '[data-size="default"]': '2rem', '[data-size="sm"]': '1.75rem' },
  },
  triggerIcon: {
    display: 'flex',
    color: tokens['--muted-foreground'],
  },
  positioner: {
    zIndex: 50,
  },
  content: {
    position: 'relative',
    zIndex: 50,
    maxHeight: 'var(--available-height)',
    minWidth: 'max(8rem, var(--anchor-width))',
    transformOrigin: 'var(--transform-origin)',
    overflowX: 'hidden',
    overflowY: 'auto',
    borderRadius: tokens['--radius'],
    backgroundColor: tokens['--popover'],
    color: tokens['--popover-foreground'],
    boxShadow:
      '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 1px color-mix(in oklab, var(--foreground) 10%, transparent), 0 4px 6px -1px #0000001a, 0 2px 4px -2px #0000001a',
    transitionDuration: '0.1s',
    animationName: {
      default: null,
      '[data-open]': enterNone,
      '[data-open][data-side="bottom"]': enterFromTop2,
      '[data-open][data-side="left"]': enterFromRight2,
      '[data-open][data-side="right"]': enterFromLeft2,
      '[data-open][data-side="top"]': enterFromBottom2,
      '[data-closed]': exit,
    },
    animationDuration: { default: null, '[data-open]': '0.1s', '[data-closed]': '0.1s' },
    animationTimingFunction: { default: null, '[data-open]': 'ease', '[data-closed]': 'ease' },
    animationDelay: { default: null, '[data-open]': '0s', '[data-closed]': '0s' },
    animationIterationCount: { default: null, '[data-open]': 1, '[data-closed]': 1 },
    animationDirection: { default: null, '[data-open]': 'normal', '[data-closed]': 'normal' },
    animationFillMode: { default: null, '[data-open]': 'none', '[data-closed]': 'none' },
  },
  label: {
    paddingInline: '0.375rem',
    paddingBlock: '0.25rem',
    fontSize: '0.75rem',
    lineHeight: tokens['--text-xs--line-height'],
    color: tokens['--muted-foreground'],
  },
  item: {
    position: 'relative',
    display: 'flex',
    width: '100%',
    cursor: 'default',
    alignItems: 'center',
    gap: '0.375rem',
    borderRadius: 'calc(var(--radius) - 2px)',
    paddingBlock: '0.25rem',
    paddingRight: '2rem',
    paddingLeft: '0.375rem',
    fontSize: '0.875rem',
    lineHeight: tokens['--text-sm--line-height'],
    outlineStyle: { default: 'none', [FORCED_COLORS]: 'solid' },
    outlineWidth: { default: null, [FORCED_COLORS]: '2px' },
    outlineColor: { default: null, [FORCED_COLORS]: '#0000' },
    outlineOffset: { default: null, [FORCED_COLORS]: '2px' },
    userSelect: 'none',
    backgroundColor: { default: null, '[data-highlighted]': tokens['--accent'] },
    color: { default: null, '[data-highlighted]': tokens['--accent-foreground'] },
    pointerEvents: { default: null, '[data-disabled]': 'none' },
    opacity: { default: null, '[data-disabled]': 0.5 },
  },
  itemIndicator: {
    pointerEvents: 'none',
    position: 'absolute',
    right: '0.5rem',
    display: 'flex',
    width: '1rem',
    height: '1rem',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // dropped: `*:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2`
  // — Base UI's Select.ItemText renders a <div>, so the span-only child rule
  // never matched it; ItemText stays unstyled exactly as before.
  separator: {
    pointerEvents: 'none',
    marginInline: '-0.25rem',
    marginBlock: '0.25rem',
    height: '1px',
    backgroundColor: tokens['--border'],
  },
  scrollButton: {
    zIndex: 10,
    display: 'flex',
    cursor: 'default',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens['--popover'],
    paddingBlock: '0.25rem',
  },
})

// Radix's <Select.Value/> mirrors the selected <Select.ItemText>. Base UI instead
// resolves the label from the Root's `items` / `itemToStringLabel`, so a bare
// <SelectValue/> would render the raw value ("alt") rather than its label
// ("Alt / Option"). Walk the SelectItem children once to recover the value->label
// map and feed it to Base UI as `itemToStringLabel`, keeping call sites unchanged.
function collectItemLabels(
  children: React.ReactNode,
  acc: Record<string, React.ReactNode>,
): Record<string, React.ReactNode> {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return
    if (child.type === SelectItem && child.props?.value != null) {
      acc[String(child.props.value)] = child.props.children
    }
    if (child.props?.children != null) collectItemLabels(child.props.children, acc)
  })
  return acc
}

function Select({
  children,
  items,
  itemToStringLabel,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Root>) {
  const derived = React.useMemo(() => collectItemLabels(children, {}), [children])

  let labelResolver = itemToStringLabel
  if (!labelResolver && !items) {
    labelResolver = (value: unknown) => {
      const label = derived[String(value)]
      return typeof label === 'string' ? label : String(value ?? '')
    }
  }

  return (
    <SelectPrimitive.Root
      data-slot="select"
      items={items}
      itemToStringLabel={labelResolver}
      {...props}
    >
      {children}
    </SelectPrimitive.Root>
  )
}

function SelectGroup({
  sx,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.Group>, 'className'> & { sx?: Sx }) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      {...stylex.props(styles.group, sx)}
      {...props}
    />
  )
}

function SelectValue({
  sx,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.Value>, 'className'> & { sx?: Sx }) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      {...stylex.props(styles.value, sx)}
      {...props}
    />
  )
}

function SelectTrigger({
  sx,
  size = 'default',
  children,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.Trigger>, 'className'> & {
  size?: 'sm' | 'default'
  sx?: Sx
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      {...stylex.props(styles.trigger, svgHost, svgSize4, sx)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon {...stylex.props(styles.triggerIcon)}>
        <ChevronDownIcon sx={[iconInert.pointerEventsNone, iconSize.s4]} />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  sx,
  children,
  position = 'item-aligned',
  align = 'center',
  sideOffset = 4,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.Popup>, 'className'> & {
  position?: 'item-aligned' | 'popper'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  sx?: Sx
}) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        data-slot="select-positioner"
        {...stylex.props(styles.positioner)}
        align={align}
        sideOffset={sideOffset}
        alignItemWithTrigger={position === 'item-aligned'}
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          {...stylex.props(styles.content, sx)}
          {...props}
        >
          <SelectScrollUpButton />
          {children}
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({
  sx,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.GroupLabel>, 'className'> & { sx?: Sx }) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      {...stylex.props(styles.label, sx)}
      {...props}
    />
  )
}

function SelectItem({
  sx,
  children,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.Item>, 'className'> & { sx?: Sx }) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      {...stylex.props(styles.item, svgHost, svgSize4, sx)}
      {...props}
    >
      <span {...stylex.props(styles.itemIndicator)}>
        <SelectPrimitive.ItemIndicator>
          <CheckIcon sx={iconInert.pointerEventsNone} />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({
  sx,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.Separator>, 'className'> & { sx?: Sx }) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      {...stylex.props(styles.separator, sx)}
      {...props}
    />
  )
}

function SelectScrollUpButton({
  sx,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>, 'className'> & { sx?: Sx }) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      {...stylex.props(styles.scrollButton, svgSize4, sx)}
      {...props}
    >
      <ChevronUpIcon />
    </SelectPrimitive.ScrollUpArrow>
  )
}

function SelectScrollDownButton({
  sx,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>, 'className'> & { sx?: Sx }) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      {...stylex.props(styles.scrollButton, svgSize4, sx)}
      {...props}
    >
      <ChevronDownIcon />
    </SelectPrimitive.ScrollDownArrow>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
