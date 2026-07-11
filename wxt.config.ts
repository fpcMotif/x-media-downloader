import { readFileSync } from 'node:fs'
import { defineConfig } from 'wxt'
import preact from '@preact/preset-vite'
import tailwindcss from '@tailwindcss/vite'
import { allAdapterHostMatch, cdnMatchPatternsForAllAdapters } from './src/core/adapters/registry'

// When a local `.env` pre-seeds Cloud Sync (WXT_CONVEX_URL), promote the Convex
// origin from an optional to a REQUIRED host permission for THIS build only —
// unpacked dev extensions get required host permissions auto-granted on reload,
// so the seeded config works with zero clicks. A normal build (no `.env`) keeps
// it optional and opt-in (ADR-0009).
const seedsConvex = (() => {
  try {
    return /^\s*WXT_CONVEX_URL=\S/m.test(readFileSync('.env', 'utf8'))
  } catch {
    return false
  }
})()

const CONVEX_ORIGIN = 'https://*.convex.cloud/*'

// Every registered adapter's page origin, as a manifest `host_permissions`
// entry (`https://host/*`) — derived from `allAdapterHostMatch()` (the
// registry's own manifest-permissions source of truth) rather than
// hand-listed, so adding a platform to the registry (docs/adr/0019) is the
// only edit needed. `hostMatch` entries are match-pattern syntax
// (`*://host/*`); the scheme differs from `host_permissions` shape, hence
// the transform below.
const PLATFORM_HOST_PERMISSIONS = allAdapterHostMatch().map(
  (m) => `https://${m.split('://')[1]?.split('/')[0]}/*`,
)

// Every registered adapter's CDN match pattern (docs/adr/0019), already in
// `https://host/*` / `https://*.host/*` manifest shape — no transform needed
// (unlike PLATFORM_HOST_PERMISSIONS above, which starts from match-pattern
// syntax). Adding a platform's CDN to the registry needs no edit here.
const CDN_HOST_PERMISSIONS = cdnMatchPatternsForAllAdapters()

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'X Media Downloader',
    description:
      'Download X (Twitter) tweet/thread media at original quality. Minimalist, local-only, no scraping.',
    // `identity` powers chrome.identity.launchWebAuthFlow for Cloud Upload OAuth
    // (ADR-0013). Required (not optional): `identity` is not reliably grantable
    // via chrome.permissions.request. launchWebAuthFlow needs no host permission
    // for the auth window or the chromiumapp.org redirect.
    // `alarms` powers the Cloud Upload backoff wake-up (ADR-0013) so failed
    // uploads retry autonomously after the service worker suspends.
    // `unlimitedStorage` keeps the Tweet Harvest IndexedDB store (`xmd-capture`)
    // from being evicted under browser storage pressure — the breadth flag can
    // harvest tens of thousands of text records.
    permissions: ['downloads', 'storage', 'activeTab', 'identity', 'alarms', 'unlimitedStorage'],
    host_permissions: [
      // X/Instagram/Threads page origins, derived from the adapter registry
      // (docs/adr/0019-platform-identity-derives-from-adapter-registry.md) —
      // the content scripts' widened `matches` need a matching host
      // permission per platform. Threads moved `threads.net` → `threads.com`
      // in April 2025; both hosts serve the same backend, so both are listed.
      ...PLATFORM_HOST_PERMISSIONS,
      // X's public embed endpoint — the background fetches it to recover a video
      // the passive tee missed (SPA cache hit / lazy reply). Required (not opt-in)
      // so the media count is correct out of the box; read-only, X-owned, narrow.
      'https://cdn.syndication.twimg.com/*',
      ...(seedsConvex ? [CONVEX_ORIGIN] : []),
    ],
    // Requested at runtime only when Download Strategy = Fetched (ADR-0003):
    optional_permissions: ['offscreen'],
    // Every registered adapter's CDN = Fetched (ADR-0003) AND the Cloud Upload
    // byte source (ADR-0013), derived from the adapter registry (docs/adr/0019)
    // rather than hand-listed — twimg's exact host pair plus Meta's
    // `*.cdninstagram.com` wildcard (Instagram/Threads serve signed media off
    // numbered `scontent` subdomains rather than one fixed host). HEAD-probes
    // for the size/budget filters, the 'fetched' strategy, and Cloud Upload's
    // byte source all need this fetch-level host access, on top of the
    // page-origin host_permissions already granted for the content script.
    // localhost = aria2 JSON-RPC opt-in (ADR-0006); convex.cloud = Cloud Sync
    // opt-in (ADR-0009), unless a local `.env` pre-seeds it (then it's required,
    // above); the googleapis/dropboxapi origins = Cloud Upload provider APIs
    // (ADR-0013), requested at provider-connect time.
    optional_host_permissions: [
      ...CDN_HOST_PERMISSIONS,
      'http://localhost/*',
      'https://www.googleapis.com/*',
      'https://oauth2.googleapis.com/*',
      'https://api.dropboxapi.com/*',
      'https://content.dropboxapi.com/*',
      'https://www.dropbox.com/*',
      ...(seedsConvex ? [] : [CONVEX_ORIGIN]),
    ],
  },
  vite: () => ({
    plugins: [preact(), tailwindcss()],
  }),
})
