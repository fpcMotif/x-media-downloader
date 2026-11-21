import * as stylex from '@stylexjs/stylex'
import { tokens } from '@/theme/tokens.stylex'
import { PanelHeader, Section } from '../ui'

const styles = stylex.create({
  // text-[13px] text-muted-foreground
  bodyText: {
    fontSize: '13px',
    color: tokens['--muted-foreground'],
  },
  list: {
    display: 'grid',
    gap: '0.375rem',
    paddingBlock: '0.75rem',
  },
})

const PRIVACY = [
  'No telemetry, no scraping',
  'Everything stays on this computer unless you turn on Sync',
  'Metadata sync sends metadata only, never files',
  'Cloud uploads go from your browser straight to your Drive or Dropbox',
] as const

export function AboutPanel() {
  return (
    <>
      <PanelHeader title="About" />

      <Section title="Privacy">
        <ul {...stylex.props(styles.list)}>
          {PRIVACY.map((line) => (
            <li key={line} {...stylex.props(styles.bodyText)}>
              {line}
            </li>
          ))}
        </ul>
      </Section>
    </>
  )
}
