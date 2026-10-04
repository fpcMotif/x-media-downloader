import type { ComponentChildren, VNode } from 'preact'
import * as stylex from '@stylexjs/stylex'
import type { Settings } from '@/packages/schema'
import { tokens } from '@/theme/tokens.stylex'
import { FieldGroup } from '@/components/ui/field'

const styles = stylex.create({
  // grid gap-1.5 pb-1
  header: {
    display: 'grid',
    gap: '0.375rem',
    paddingBottom: '0.25rem',
  },
  // text-xl font-semibold tracking-tight text-balance
  title: {
    fontSize: '1.25rem',
    lineHeight: tokens['--text-xl--line-height'],
    fontWeight: 600,
    letterSpacing: '-0.025em',
    textWrap: 'balance',
  },
  // text-[13px] leading-relaxed text-muted-foreground text-pretty
  description: {
    fontSize: '13px',
    lineHeight: 1.625,
    color: tokens['--muted-foreground'],
    textWrap: 'pretty',
  },
  // border-t border-border pt-6
  section: {
    borderTopStyle: 'solid',
    borderTopWidth: '1px',
    borderColor: tokens['--border'],
    paddingTop: '1.5rem',
  },
  // mb-4 flex items-start justify-between gap-3
  titleRow: {
    marginBottom: '1rem',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '0.75rem',
  },
  // grid gap-1 min-w-0
  titleColumn: {
    display: 'grid',
    gap: '0.25rem',
    minWidth: 0,
  },
  // text-sm font-semibold
  sectionTitle: {
    fontSize: '0.875rem',
    lineHeight: tokens['--text-sm--line-height'],
    fontWeight: 600,
  },
  // text-[13px] leading-snug text-muted-foreground text-pretty
  sectionDescription: {
    fontSize: '13px',
    lineHeight: 1.375,
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
  },
})

/** Every settings panel reads the live settings and writes through `update`;
 *  `reload` re-pulls from storage after the background mutates settings
 *  out-of-band (e.g. cloud OAuth stores tokens). */
export type PanelProps = {
  readonly settings: Settings
  readonly update: (patch: Partial<Settings>) => Promise<void>
  readonly reload: () => Promise<void>
}

/** The title + lede at the top of a panel's content column — R4 Foundations
 *  type scale (20px title, 13px muted lede): a quiet typographic document,
 *  not a dashboard hero. */
export function PanelHeader({ title, description }: { title: string; description: string }) {
  return (
    <header {...stylex.props(styles.header)}>
      <h1 {...stylex.props(styles.title)}>{title}</h1>
      <p {...stylex.props(styles.description)}>{description}</p>
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
  children,
}: {
  title: string
  description?: string
  action?: VNode
  children: ComponentChildren
}) {
  return (
    <section aria-label={title} {...stylex.props(styles.section)}>
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
