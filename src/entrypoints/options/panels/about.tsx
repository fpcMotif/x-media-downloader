import { Badge } from '@/components/ui/badge'
import { Field, FieldDescription, FieldTitle } from '@/components/ui/field'
import { PanelHeader, SettingGroup } from '../ui'
import { InfoIcon, CloudIcon } from '@/components/icons'

export function AboutPanel() {
  const redirectUrl = ((): string => {
    try {
      return browser.identity.getRedirectURL()
    } catch {
      return ''
    }
  })()

  return (
    <>
      <PanelHeader
        title="About"
        description="X Media Downloader — download X (Twitter) media at original quality. Minimalist, local-only, no scraping."
      />

      <SettingGroup
        title="Privacy posture"
        description="Local-first by default. Nothing leaves your machine unless you opt in."
        icon={<InfoIcon className="size-[18px]" />}
      >
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">No remote telemetry</Badge>
          <Badge variant="outline">No scraping</Badge>
          <Badge variant="outline">Cloud sync is opt-in</Badge>
          <Badge variant="outline">Bytes go provider-direct</Badge>
        </div>
        <FieldDescription>
          Cloud Sync mirrors download metadata only — never file bytes. Cloud Upload sends media
          bytes straight from your browser to your own Drive/Dropbox, never through our servers.
        </FieldDescription>
      </SettingGroup>

      {redirectUrl !== '' && (
        <SettingGroup
          title="OAuth redirect URL"
          description="Register this redirect URL in your Google Cloud / Dropbox app console when setting up Cloud Upload."
          icon={<CloudIcon className="size-[18px]" />}
        >
          <Field>
            <FieldTitle>Redirect URL</FieldTitle>
            <code className="rounded-md bg-muted px-2 py-1.5 font-mono text-xs break-all">
              {redirectUrl}
            </code>
          </Field>
        </SettingGroup>
      )}
    </>
  )
}
