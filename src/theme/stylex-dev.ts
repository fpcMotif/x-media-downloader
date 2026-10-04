/** Links the StyleX plugin's live stylesheet into a dev-server-driven extension
 *  page and refreshes it on every HMR update.
 *
 *  @remarks
 *  Production builds append the compiled rules to `assets/app-*.css`; during
 *  `wxt dev` the plugin instead serves them from `/virtual:stylex.css` on the
 *  Vite dev server. Extension pages are a different origin from that server,
 *  so the plugin's own relative-URL shim cannot reach it — this resolves the
 *  path against `import.meta.url` (the dev server, which is where the page's
 *  modules load from). Call only under `import.meta.env.DEV`. */
export function linkStylexDevStylesheet(): void {
  const url = new URL('/virtual:stylex.css', import.meta.url)
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = url.href
  document.head.append(link)
  import.meta.hot?.on('stylex:css-update', () => {
    url.searchParams.set('t', String(Date.now()))
    link.href = url.href
  })
}
