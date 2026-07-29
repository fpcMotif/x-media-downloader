import type { ComponentChildren, VNode } from 'preact'
import type { Settings, SettingsUiPatch } from '@/core/schema'
import { FieldGroup } from '@/components/ui/field'

/** Every settings panel reads the live settings and writes through `update`;
 *  `reload` re-pulls from storage after the background mutates settings
 *  out-of-band (e.g. cloud OAuth stores tokens). */
export type PanelProps = {
  readonly settings: Settings
  /** Caller-owned freshness gate prevents a late UI intent from persisting. */
  readonly update: (patch: SettingsUiPatch, isCurrent?: () => boolean) => Promise<void>
  readonly reload: () => Promise<void>
}

/** The title + lede at the top of a panel's content column — R4 Foundations
 *  type scale (20px title, 13px muted lede): a quiet typographic document,
 *  not a dashboard hero. */
export function PanelHeader({ title, description }: { title: string; description: string }) {
  return (
    <header className="grid gap-1.5 pb-1">
      <h1 className="text-xl font-semibold tracking-tight text-balance">{title}</h1>
      <p className="text-[13px] leading-relaxed text-muted-foreground text-pretty">{description}</p>
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
    <section aria-label={title} className="border-t border-border pt-6">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="grid gap-1 min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && (
            <p className="text-[13px] leading-snug text-muted-foreground text-pretty">
              {description}
            </p>
          )}
        </div>
        {action && <div className="shrink-0 pt-0.5">{action}</div>}
      </div>
      <FieldGroup className="gap-0 divide-y divide-border *:py-4">{children}</FieldGroup>
    </section>
  )
}
