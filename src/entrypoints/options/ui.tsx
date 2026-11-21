import type { ComponentChildren, VNode } from 'preact'
import { useEffect, useId, useRef, useState } from 'preact/hooks'
import * as stylex from '@stylexjs/stylex'
import type { Settings } from '@/packages/schema'
import { tokens } from '@/theme/tokens.stylex'
import { FieldGroup } from '@/components/ui/field'
import { ChevronDownIcon, iconSize } from '@/components/icons'

const HOVER = '@media (hover: hover)'
const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)'
const RING_FOCUS_VISIBLE =
  '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent), 0 0 #0000'

const styles = stylex.create({
  // grid gap-1.5 pb-1
  header: {
    display: 'grid',
    gap: '0.375rem',
    paddingBottom: '0.25rem',
  },
  // text-xl font-semibold tracking-tight text-balance
  title: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontSize: '1.625rem',
    lineHeight: 1.2,
    fontWeight: 650,
    letterSpacing: '-0.03em',
    textWrap: 'balance',
  },
  // text-[13px] leading-relaxed text-muted-foreground text-pretty
  description: {
    fontSize: '0.875rem',
    lineHeight: 1.5,
    color: tokens['--muted-foreground'],
    textWrap: 'pretty',
  },
  // border-t border-border pt-6
  section: {
    display: 'grid',
    gap: '0.75rem',
  },
  // mb-4 flex items-start justify-between gap-3
  titleRow: {
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: '0.75rem',
    paddingInline: '0.25rem',
  },
  // grid gap-1 min-w-0
  titleColumn: {
    display: 'grid',
    gap: '0.25rem',
    minWidth: 0,
  },
  // text-sm font-semibold
  sectionTitle: {
    fontSize: '0.9375rem',
    lineHeight: 1.3,
    fontWeight: 600,
    letterSpacing: '-0.012em',
  },
  // text-[13px] leading-snug text-muted-foreground text-pretty
  sectionDescription: {
    fontSize: '13px',
    lineHeight: 1.45,
    color: tokens['--muted-foreground'],
    textWrap: 'pretty',
  },
  // shrink-0 pt-0.5
  actionSlot: {
    flexShrink: 0,
    paddingTop: '0.125rem',
  },
  // gap-0 (replaces the FieldGroup base's gap-5) — the divide-y/divide-border/
  // *:py-4 utilities become data-xmd-divide/data-xmd-rows (spec §6).
  rows: {
    gap: 0,
    borderRadius: tokens['--xmd-radius-1'],
    backgroundColor: tokens['--card'],
    boxShadow: '0 0 0 1px var(--border), var(--xmd-shadow-1)',
    paddingInline: '1.25rem',
  },
  foldClosed: { gap: 0 },
  foldTrigger: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.375rem',
    minHeight: '2.5rem',
    paddingInline: '0.25rem',
    paddingBlock: 0,
    borderWidth: 0,
    borderRadius: tokens['--xmd-radius-3'],
    backgroundColor: 'transparent',
    font: 'inherit',
    letterSpacing: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
    outlineStyle: 'none',
    color: { default: tokens['--muted-foreground'], [HOVER]: { ':hover': tokens['--foreground'] } },
    boxShadow: { default: null, ':focus-visible': RING_FOCUS_VISIBLE },
  },
  chevron: {
    display: 'inline-flex',
    transitionProperty: 'rotate',
    transitionDuration: { default: '0.16s', [REDUCED_MOTION]: '0s' },
    transitionTimingFunction: 'var(--xmd-ease)',
    rotate: '-90deg',
  },
  chevronOpen: { rotate: '0deg' },
})

/** Every settings panel reads the live settings and writes through `update`;
 *  `reload` re-pulls from storage after the background mutates settings
 *  out-of-band (e.g. cloud OAuth stores tokens). */
export type PanelProps = {
  readonly settings: Settings
  readonly update: (patch: Partial<Settings>) => Promise<void>
  readonly reload: () => Promise<void>
}

/** The live value of the `<input>` that fired `e` — narrows `EventTarget | null`
 *  instead of asserting it, since every caller binds this to a real
 *  `HTMLInputElement`'s `onChange`. */
export const inputValue = (e: Event): string =>
  e.target instanceof HTMLInputElement ? e.target.value : ''

/** The title + lede at the top of a panel's content column — R4 Foundations
 *  type scale (20px title, 13px muted lede): a quiet typographic document,
 *  not a dashboard hero. */
export function PanelHeader({
  title,
  description,
  badge,
}: {
  title: string
  description?: string
  badge?: VNode
}) {
  return (
    <header {...stylex.props(styles.header)}>
      <h1 {...stylex.props(styles.title)}>
        {title}
        {badge}
      </h1>
      {description && <p {...stylex.props(styles.description)}>{description}</p>}
    </header>
  )
}

/** A flat, hairline-separated block of settings — R4 replaces the bordered
 *  card + icon-tile unit with structure that comes from spacing and a single
 *  top hairline. No nested box, no icon: the title sits directly on the page
 *  and each child row is hairline-divided from the next. `action` floats a
 *  quiet link (e.g. "Open archive ›") to the right of the title line. */
export function Section({
  title,
  description,
  action,
  collapsed,
  children,
}: {
  title: string
  description?: string
  action?: VNode
  collapsed?: boolean
  children: ComponentChildren
}) {
  if (collapsed) return <FoldedSection title={title}>{children}</FoldedSection>
  return (
    <section {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.titleRow)}>
        <div {...stylex.props(styles.titleColumn)}>
          <h2 {...stylex.props(styles.sectionTitle)}>{title}</h2>
          {description && <p {...stylex.props(styles.sectionDescription)}>{description}</p>}
        </div>
        {action && <div {...stylex.props(styles.actionSlot)}>{action}</div>}
      </div>
      <FieldGroup sx={styles.rows} data-xmd-divide="" data-xmd-rows="4">
        {children}
      </FieldGroup>
    </section>
  )
}

function FoldedSection({ title, children }: { title: string; children: ComponentChildren }) {
  const [open, setOpen] = useState(false)
  const contentId = useId()
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const content = contentRef.current
    if (!content) return undefined
    const reveal = (): void => setOpen(true)
    content.addEventListener('beforematch', reveal)
    return () => content.removeEventListener('beforematch', reveal)
  }, [])
  return (
    <section {...stylex.props(styles.section, !open && styles.foldClosed)}>
      <h2 {...stylex.props(styles.sectionTitle)}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((wasOpen) => !wasOpen)}
          {...stylex.props(styles.foldTrigger)}
        >
          {title}
          <span aria-hidden="true" {...stylex.props(styles.chevron, open && styles.chevronOpen)}>
            <ChevronDownIcon sx={iconSize.s4} />
          </span>
        </button>
      </h2>
      <div id={contentId} ref={contentRef} hidden={open ? false : 'until-found'}>
        <FieldGroup sx={styles.rows} data-xmd-divide="" data-xmd-rows="4">
          {children}
        </FieldGroup>
      </div>
    </section>
  )
}
