import * as stylex from '@stylexjs/stylex'
import { tokens } from '@/theme/tokens.stylex'
import { Field, FieldDescription, FieldTitle } from '@/components/ui/field'
import { PanelHeader, Section } from '../ui'

const styles = stylex.create({
  // text-[13px] text-muted-foreground
  bodyText: {
    fontSize: '13px',
    color: tokens['--muted-foreground'],
  },
  // text-pretty — composed onto the FieldDescription base and onto bodyText
  textPretty: {
    textWrap: 'pretty',
  },
  // font-mono text-xs break-all text-muted-foreground
  redirectCode: {
    fontFamily: tokens['--font-mono'],
    fontSize: '0.75rem',
    lineHeight: tokens['--text-xs--line-height'],
    wordBreak: 'break-all',
    color: tokens['--muted-foreground'],
  },
})

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
        <p {...stylex.props(styles.bodyText)}>
          No remote telemetry · No scraping · Cloud sync is opt-in · Bytes go provider-direct
        </p>
        <FieldDescription sx={styles.textPretty}>
          Cloud Sync mirrors download metadata only — never file bytes. Cloud Upload sends media
          bytes straight from your browser to your own Drive/Dropbox, never through our servers.
        </FieldDescription>
      </Section>

      <Section title="Appearance">
        <p {...stylex.props(styles.bodyText, styles.textPretty)}>
          Follows your system light/dark setting. There is no in-app theme override.
        </p>
      </Section>

      {redirectUrl !== '' && (
        <Section
          title="OAuth redirect URL"
          description="Register this redirect URL in your Google Cloud / Dropbox app console when setting up Cloud Upload."
        >
          <Field>
            <FieldTitle>Redirect URL</FieldTitle>
            <code {...stylex.props(styles.redirectCode)}>{redirectUrl}</code>
          </Field>
        </Section>
      )}
    </>
  )
}
