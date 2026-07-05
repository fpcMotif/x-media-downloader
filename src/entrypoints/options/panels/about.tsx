import { Field, FieldDescription, FieldTitle } from '@/components/ui/field'
import { PanelHeader, Section } from '../ui'

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

      <Section
        title="Privacy posture"
        description="Local-first by default. Nothing leaves your machine unless you opt in."
      >
        <p className="text-[13px] text-muted-foreground">
          No remote telemetry · No scraping · Cloud sync is opt-in · Bytes go provider-direct
        </p>
        <FieldDescription>
          Cloud Sync mirrors download metadata only — never file bytes. Cloud Upload sends media
          bytes straight from your browser to your own Drive/Dropbox, never through our servers.
        </FieldDescription>
      </Section>

      {redirectUrl !== '' && (
        <Section
          title="OAuth redirect URL"
          description="Register this redirect URL in your Google Cloud / Dropbox app console when setting up Cloud Upload."
        >
          <Field>
            <FieldTitle>Redirect URL</FieldTitle>
            <code className="font-mono text-xs break-all text-muted-foreground">{redirectUrl}</code>
          </Field>
        </Section>
      )}
    </>
  )
}
