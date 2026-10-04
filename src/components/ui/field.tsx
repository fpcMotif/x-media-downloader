// @ts-nocheck — vendored shadcn/ui, authored for React. This repo runs Preact
// via preact/compat with exactOptionalPropertyTypes; the {...props} spreads do
// not satisfy it. Checked at call sites instead.
import { useMemo } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { StyleXStyles } from '@stylexjs/stylex'

import { tokens } from '@/theme/tokens.stylex'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'

type Sx = StyleXStyles | ReadonlyArray<StyleXStyles | false | null | undefined>

const CONTAINER = '@container field-group (width >= 28rem)'

const setStyles = stylex.create({
  fieldSet: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    // dropped: has-[>[data-slot=checkbox-group]]:gap-3, has-[>[data-slot=radio-group]]:gap-3
    // — no call site nests a checkbox-group/radio-group directly under a FieldSet.
  },
})

function FieldSet({ sx, ...props }: React.ComponentProps<'fieldset'> & { sx?: Sx }) {
  return <fieldset data-slot="field-set" {...stylex.props(setStyles.fieldSet, sx)} {...props} />
}

const legendStyles = stylex.create({
  legend: {
    marginBottom: '0.375rem',
    fontWeight: 500,
    fontSize: {
      default: null,
      '[data-variant="label"]': '0.875rem',
      '[data-variant="legend"]': '1rem',
    },
    lineHeight: {
      default: null,
      '[data-variant="label"]': tokens['--text-sm--line-height'],
      '[data-variant="legend"]': tokens['--text-base--line-height'],
    },
  },
})

function FieldLegend({
  variant = 'legend',
  sx,
  ...props
}: React.ComponentProps<'legend'> & { variant?: 'legend' | 'label'; sx?: Sx }) {
  return (
    <legend
      data-slot="field-legend"
      data-variant={variant}
      {...stylex.props(legendStyles.legend, sx)}
      {...props}
    />
  )
}

const groupStyles = stylex.create({
  group: {
    display: 'flex',
    width: '100%',
    flexDirection: 'column',
    gap: '1.25rem',
    containerName: 'field-group',
    containerType: 'inline-size',
    // dropped: data-[slot=checkbox-group]:gap-3 — this element's own data-slot
    // is always "field-group", so the selector never matches.
    // dropped: *:data-[slot=field-group]:gap-4 — no call site nests a
    // FieldGroup directly inside another FieldGroup.
  },
})

function FieldGroup({ sx, ...props }: React.ComponentProps<'div'> & { sx?: Sx }) {
  return <div data-slot="field-group" {...stylex.props(groupStyles.group, sx)} {...props} />
}

type FieldOrientation = 'vertical' | 'horizontal' | 'responsive'

const fieldStyles = stylex.create({
  base: {
    display: 'flex',
    width: '100%',
    gap: '0.5rem',
    color: { default: null, '[data-invalid="true"]': tokens['--destructive'] },
  },
  vertical: {
    flexDirection: 'column',
    // *:w-full is handled by the `[data-slot='field'][data-orientation='vertical'] > *`
    // rule in app.css.
    // dropped: [&>.sr-only]:w-auto — no call site renders a `.sr-only` direct
    // child of a vertical Field.
  },
  horizontal: {
    flexDirection: 'row',
    alignItems: { default: 'center', ':has(> [data-slot="field-content"])': 'flex-start' },
    // *:data-[slot=field-label]:flex-auto is handled by the
    // `[data-slot='field'][data-orientation='horizontal'] > [data-slot='field-label']`
    // rule in app.css.
    // dropped: has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px
    // — no call site combines a field-content child with a checkbox/radio sibling.
  },
  responsive: {
    flexDirection: { default: 'column', [CONTAINER]: 'row' },
    alignItems: {
      default: null,
      [CONTAINER]: { default: 'center', ':has(> [data-slot="field-content"])': 'flex-start' },
    },
    // dropped: [&>.sr-only]:w-auto (see vertical) and the responsive orientation's
    // @md/field-group:*:w-auto / @md/field-group:*:data-[slot=field-label]:flex-auto /
    // @md/field-group:has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px
    // child rules — same reasoning as the vertical/horizontal variants above; the
    // container-query self rules (flex-row / items-center / :has(...) items-start)
    // are kept.
  },
})

function Field({
  orientation = 'vertical',
  sx,
  ...props
}: React.ComponentProps<'div'> & { orientation?: FieldOrientation; sx?: Sx }) {
  return (
    <div
      role="group"
      data-slot="field"
      data-orientation={orientation}
      {...stylex.props(fieldStyles.base, fieldStyles[orientation], sx)}
      {...props}
    />
  )
}

const contentStyles = stylex.create({
  content: {
    display: 'flex',
    flex: 1,
    flexDirection: 'column',
    gap: '0.125rem',
    lineHeight: 1.375,
  },
})

function FieldContent({ sx, ...props }: React.ComponentProps<'div'> & { sx?: Sx }) {
  return <div data-slot="field-content" {...stylex.props(contentStyles.content, sx)} {...props} />
}

const fieldLabelStyles = stylex.create({
  // Additive overrides applied on top of Label's own base style (Label is
  // rendered with `sx={[fieldLabelStyles.self, sx]}` below).
  self: {
    width: 'fit-content',
    lineHeight: 1.375,
    // dropped: group-data-[disabled=true]/field:opacity-50 — no ancestor Field
    // ever sets data-disabled.
    // dropped: has-data-checked:border-primary/30, has-data-checked:bg-primary/5,
    // dark:has-data-checked:border-primary/20, dark:has-data-checked:bg-primary/10
    // — no call site nests a `[data-checked]` element inside a FieldLabel.
    // dropped: has-[>[data-slot=field]]:rounded-lg, has-[>[data-slot=field]]:border,
    // has-[>[data-slot=field]]:w-full, has-[>[data-slot=field]]:flex-col,
    // *:data-[slot=field]:p-2.5 — no call site wraps a Field inside a FieldLabel.
  },
})

function FieldLabel({ sx, ...props }: React.ComponentProps<typeof Label>) {
  return <Label data-slot="field-label" sx={[fieldLabelStyles.self, sx]} {...props} />
}

const titleStyles = stylex.create({
  title: {
    display: 'flex',
    width: 'fit-content',
    alignItems: 'center',
    gap: '0.5rem',
    fontSize: '0.875rem',
    lineHeight: tokens['--text-sm--line-height'],
    fontWeight: 500,
    // dropped: group-data-[disabled=true]/field:opacity-50 — no ancestor Field
    // ever sets data-disabled.
  },
})

function FieldTitle({ sx, ...props }: React.ComponentProps<'div'> & { sx?: Sx }) {
  return <div data-slot="field-label" {...stylex.props(titleStyles.title, sx)} {...props} />
}

const descriptionStyles = stylex.create({
  description: {
    textAlign: 'left',
    fontSize: '0.875rem',
    lineHeight: 1.5,
    fontWeight: 400,
    color: tokens['--muted-foreground'],
    marginTop: { default: null, ':nth-last-child(2)': '-0.25rem', ':last-child': 0 },
    // dropped: group-has-data-horizontal/field:text-balance — Field emits
    // data-orientation, never data-horizontal, so this selector never matches.
    // dropped: [[data-variant=legend]+&]:-mt-1.5 — no call site renders a
    // FieldDescription immediately after a legend-variant FieldLegend.
    // [&>a]:underline / underline-offset-4 / hover:text-primary now live in
    // app.css as `[data-slot='field-description'] > a` rules — nothing to do here.
  },
})

function FieldDescription({ sx, ...props }: React.ComponentProps<'p'> & { sx?: Sx }) {
  return (
    <p
      data-slot="field-description"
      {...stylex.props(descriptionStyles.description, sx)}
      {...props}
    />
  )
}

const separatorStyles = stylex.create({
  self: {
    position: 'relative',
    marginBlock: '-0.5rem',
    height: '1.25rem',
    fontSize: '0.875rem',
    lineHeight: tokens['--text-sm--line-height'],
    // dropped: group-data-[variant=outline]/field-group:-mb-2 — FieldGroup
    // never sets data-variant, so this selector never matches.
  },
  line: {
    position: 'absolute',
    inset: 0,
    top: '50%',
  },
  content: {
    position: 'relative',
    marginInline: 'auto',
    display: 'block',
    width: 'fit-content',
    backgroundColor: tokens['--background'],
    paddingInline: '0.5rem',
    color: tokens['--muted-foreground'],
  },
})

function FieldSeparator({
  children,
  sx,
  ...props
}: React.ComponentProps<'div'> & {
  children?: React.ReactNode
  sx?: Sx
}) {
  return (
    <div
      data-slot="field-separator"
      data-content={!!children}
      {...stylex.props(separatorStyles.self, sx)}
      {...props}
    >
      <Separator sx={separatorStyles.line} />
      {children && (
        <span {...stylex.props(separatorStyles.content)} data-slot="field-separator-content">
          {children}
        </span>
      )}
    </div>
  )
}

const errorStyles = stylex.create({
  error: {
    fontSize: '0.875rem',
    lineHeight: tokens['--text-sm--line-height'],
    fontWeight: 400,
    color: tokens['--destructive'],
  },
  list: {
    marginLeft: '1rem',
    display: 'flex',
    listStyleType: 'disc',
    flexDirection: 'column',
    gap: '0.25rem',
  },
})

function FieldError({
  children,
  errors,
  sx,
  ...props
}: React.ComponentProps<'div'> & {
  errors?: Array<{ message?: string } | undefined>
  sx?: Sx
}) {
  const content = useMemo(() => {
    if (children) {
      return children
    }

    if (!errors?.length) {
      return null
    }

    const uniqueErrors = [...new Map(errors.map((error) => [error?.message, error])).values()]

    if (uniqueErrors?.length == 1) {
      return uniqueErrors[0]?.message
    }

    return (
      <ul {...stylex.props(errorStyles.list)}>
        {uniqueErrors.map((error, index) => error?.message && <li key={index}>{error.message}</li>)}
      </ul>
    )
  }, [children, errors])

  if (!content) {
    return null
  }

  return (
    <div role="alert" data-slot="field-error" {...stylex.props(errorStyles.error, sx)} {...props}>
      {content}
    </div>
  )
}

export {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldContent,
  FieldTitle,
}
