import { installResponseTee } from './inject/response-tee'

/**
 * MAIN-world passive tee (ADR-0001, grounding §c). Patches XHR + fetch to copy
 * X's own GraphQL media responses to the ISOLATED content script via a document
 * CustomEvent. Issues no requests of its own; always returns the page's response.
 */
export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main: installResponseTee,
})
