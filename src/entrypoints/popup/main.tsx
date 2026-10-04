import { render } from 'preact'
import { App } from './App'
import { linkStylexDevStylesheet } from '@/theme/stylex-dev'
import '../../app.css'

// Dev server only: the StyleX plugin serves the live-collected stylesheet from the Vite dev server.
if (import.meta.env.DEV) linkStylexDevStylesheet()

const root = document.getElementById('app')
if (root) {
  root.replaceChildren()
  render(<App />, root)
}
