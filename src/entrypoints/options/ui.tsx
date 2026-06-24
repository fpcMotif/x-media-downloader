import type { ComponentChildren, VNode } from 'preact'
import type { Settings } from '@/core/schema'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { FieldGroup } from '@/components/ui/field'

/** Every settings panel reads the live settings and writes through `update`;
 *  `reload` re-pulls from storage after the background mutates settings
 *  out-of-band (e.g. cloud OAuth stores tokens). */
export type PanelProps = {
  readonly settings: Settings
  readonly update: (patch: Partial<Settings>) => Promise<void>
  readonly reload: () => Promise<void>
}

/** The title + lede at the top of a panel's content column. */
export function PanelHeader({ title, description }: { title: string; description: string }) {
  return (
    <header className="grid gap-1.5">
      <h1 className="text-2xl font-bold tracking-tight text-balance">{title}</h1>
      <p className="text-sm leading-relaxed text-muted-foreground text-pretty">{description}</p>
    </header>
  )
}

/** A bordered card grouping related settings, with an optional accent-tinted
 *  leading icon — the unit the Figma design uses for every settings cluster. */
export function SettingGroup({
  title,
  description,
  icon,
  children,
}: {
  title: string
  description?: string
  icon?: VNode
  children: ComponentChildren
}) {
  return (
    <Card aria-label={title}>
      <CardHeader>
        <div className="flex items-start gap-3">
          {icon && (
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              {icon}
            </span>
          )}
          <div className="grid gap-1">
            <CardTitle className="font-semibold">{title}</CardTitle>
            {description && (
              <CardDescription className="leading-snug text-pretty">{description}</CardDescription>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <FieldGroup className="gap-4">{children}</FieldGroup>
      </CardContent>
    </Card>
  )
}
