import { readFileSync } from 'node:fs'
import { defineConfig } from 'wxt'
import preact from '@preact/preset-vite'
import tailwindcss from '@tailwindcss/vite'
import { allPlatformHostMatch, cdnMatchPatternsForAllPlatforms } from './src/core/adapters/catalog'

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

// HTTPS page access and static content-script reachability are the same
// catalog fact (ADR-0019). No scheme widening or narrowing here.
const PLATFORM_HOST_PERMISSIONS = allPlatformHostMatch()

// Every cataloged platform CDN match pattern (docs/adr/0019), already in
// `https://host/*` / `https://*.host/*` manifest shape — no transform needed
// Adding a platform's CDN to the catalog needs no edit here.
const CDN_HOST_PERMISSIONS = cdnMatchPatternsForAllPlatforms()

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'X Media Downloader',
    description:
      'Download posts from X, Instagram, and Threads at original quality. Local-first, no telemetry by default.',
    // `identity` powers chrome.identity.launchWebAuthFlow for Cloud Upload OAuth
    // (ADR-0013). Required (not optional): `identity` is not reliably grantable
    // via chrome.permissions.request. launchWebAuthFlow needs no host permission
    // for the auth window or the chromiumapp.org redirect.
    // `alarms` powers restart-safe transfer, Clear projection, sync, Capture,
    // and Cloud wakes after the service worker suspends.
    // `unlimitedStorage` reduces eviction pressure for both durable IDB owners:
    // the potentially large Capture archive (`xmd-capture`) and transactional
    // Clear authority (`xmd-clear`).
    // `offscreen` is the single bounded Blob sink shared by Capture exports and
    // the opt-in Fetched strategy. Fetched still requests its CDN origins at use.
    permissions: ['downloads', 'storage', 'identity', 'alarms', 'unlimitedStorage', 'offscreen'],
    host_permissions: [
      // X/Instagram/Threads page origins, derived from the Platform Catalog
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
    // Every cataloged platform CDN = Fetched (ADR-0003) AND the Cloud Upload
    // byte source (ADR-0013), derived from the Platform Catalog (docs/adr/0019)
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
