/** How a request begins. Only browser-backed modes can be retried by Chrome. */
export type BrowserTransferMode = 'direct' | 'fetched'
export type InitialDownloadStrategy = BrowserTransferMode | 'aria2'

/** `data:` sidecars always use Chrome; aria2 never creates a browser handle. */
export function browserTransferModeForInitialRequest(
  strategy: InitialDownloadStrategy,
  url: string,
): BrowserTransferMode {
  return strategy === 'fetched' && !url.startsWith('data:') ? 'fetched' : 'direct'
}
