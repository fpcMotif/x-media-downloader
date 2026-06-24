import { render } from 'preact'
import { App } from './App'
import '../../app.css'
// Loaded AFTER app.css so it can relax the popup's fixed 380x600 document box
// for this full-page settings tab.
import './style.css'

const root = document.getElementById('app')
if (root) {
  root.replaceChildren()
  render(<App />, root)
}
